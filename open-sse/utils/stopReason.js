// Stop/finish reason normalization for the request-details drawer.
//
// The dashboard shows "Stop Reason" on a recorded request, but every wire format
// names the same concept differently: OpenAI `finish_reason`, Claude
// `stop_reason`, Gemini `finishReason`, Ollama `done_reason`, Responses API
// `response.status` / `incomplete_details.reason`. Storing one vocabulary keeps
// the column filterable and comparable; keeping the upstream token alongside it
// keeps the value debuggable ("length (max_tokens)").
//
// Pure data extraction — no side effects, safe to call on any parsed chunk.

import { toOpenAIFinish } from "../translator/concerns/finishReason.js";
import { FORMATS } from "../translator/formats.js";
import { OPENAI_FINISH } from "../translator/schema/finishReasons.js";

/**
 * Responses API `response.status` → OpenAI finish reason.
 * `incomplete` is a truncated turn (length), `completed` is a clean stop.
 * `failed` is an error and is handled by the row's own `status` field, not here.
 */
function fromResponsesStatus(status, incompleteReason) {
  if (status === "incomplete") {
    return {
      reason: OPENAI_FINISH.LENGTH,
      native: incompleteReason || "incomplete",
    };
  }
  if (status === "completed" || status === "done") {
    return { reason: OPENAI_FINISH.STOP, native: null };
  }
  return null;
}

/**
 * Extract the termination reason from ONE streaming chunk (any upstream format).
 *
 * @param {object|null} chunk - parsed upstream SSE/NDJSON chunk, in its native format
 * @returns {{reason: string, native: string|null}|null}
 *   `reason` is the normalized OpenAI-style value; `native` is the upstream token
 *   when the vocabulary differs from OpenAI's (null when they coincide).
 */
export function parseFinishReason(chunk) {
  if (!chunk || typeof chunk !== "object") return null;

  // Claude: stop_reason rides on message_delta. A "refusal" is NOT a clean stop —
  // toOpenAIFinish maps it to content_filter, matching the client-facing value.
  const claudeStop = chunk.delta?.stop_reason;
  if (typeof claudeStop === "string" && claudeStop.length > 0) {
    return { reason: toOpenAIFinish(claudeStop, FORMATS.CLAUDE), native: claudeStop };
  }

  // Responses API terminal events. `response.incomplete` carries the truncation
  // reason (e.g. max_output_tokens); `response.completed` is a clean stop.
  if (chunk.type === "response.completed" || chunk.type === "response.done") {
    return fromResponsesStatus("completed");
  }
  if (chunk.type === "response.incomplete") {
    return fromResponsesStatus("incomplete", chunk.response?.incomplete_details?.reason);
  }
  if (chunk.response && typeof chunk.response === "object") {
    const fromStatus = fromResponsesStatus(
      chunk.response.status,
      chunk.response.incomplete_details?.reason
    );
    if (fromStatus) return fromStatus;
  }

  // Gemini: top-level candidates, or wrapped in { response: { candidates } }
  // (Antigravity / gemini-cli). Reported as the native Gemini token.
  const candidates = chunk.candidates || chunk.response?.candidates;
  const geminiReason = Array.isArray(candidates) ? candidates[0]?.finishReason : null;
  if (typeof geminiReason === "string" && geminiReason.length > 0) {
    return { reason: toOpenAIFinish(geminiReason, FORMATS.GEMINI), native: geminiReason };
  }

  // OpenAI: finish_reason on the choice, or nested on delta (Qoder-style frames).
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  const openaiFinish = choice?.finish_reason || choice?.delta?.finish_reason;
  if (typeof openaiFinish === "string" && openaiFinish.length > 0) {
    return { reason: openaiFinish, native: null };
  }

  // Ollama NDJSON: done=true is the terminal frame; done_reason names the stop.
  if (chunk.done === true) {
    const doneReason = chunk.done_reason;
    if (typeof doneReason === "string" && doneReason.length > 0) {
      return { reason: toOpenAIFinish(doneReason, FORMATS.OLLAMA), native: doneReason };
    }
    if (chunk.prompt_eval_count !== undefined || chunk.eval_count !== undefined) {
      return { reason: OPENAI_FINISH.STOP, native: null };
    }
  }

  return null;
}

/**
 * Extract the termination reason from a COMPLETE (non-streaming) response body
 * in any client-facing shape. Used by the non-streaming path, whose rows store
 * `response.finish_reason` directly from the body handed to the client.
 *
 * @param {object|null} body - translated non-streaming response body
 * @returns {{reason: string, native: string|null}|null}
 */
export function stopReasonFromBody(body) {
  if (!body || typeof body !== "object") return null;

  // Claude message shape (also what a Claude client receives).
  if (typeof body.stop_reason === "string" && body.stop_reason.length > 0) {
    return { reason: toOpenAIFinish(body.stop_reason, FORMATS.CLAUDE), native: body.stop_reason };
  }

  // Responses API object: status + incomplete_details.
  if (body.object === "response" || body.status === "completed" || body.status === "incomplete") {
    const fromStatus = fromResponsesStatus(body.status, body.incomplete_details?.reason);
    if (fromStatus) return fromStatus;
  }

  // Gemini candidate shape (bare or wrapped).
  const candidates = body.candidates || body.response?.candidates;
  const geminiReason = Array.isArray(candidates) ? candidates[0]?.finishReason : null;
  if (typeof geminiReason === "string" && geminiReason.length > 0) {
    return { reason: toOpenAIFinish(geminiReason, FORMATS.GEMINI), native: geminiReason };
  }

  // OpenAI chat completion.
  const openaiFinish = body.choices?.[0]?.finish_reason;
  if (typeof openaiFinish === "string" && openaiFinish.length > 0) {
    return { reason: openaiFinish, native: null };
  }

  // Ollama non-streaming body.
  if (typeof body.done_reason === "string" && body.done_reason.length > 0) {
    return { reason: toOpenAIFinish(body.done_reason, FORMATS.OLLAMA), native: body.done_reason };
  }

  return null;
}
