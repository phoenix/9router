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
 * The full vocabulary of "ending reasons" shown in the request-details drawer.
 *
 * The clean values are the OpenAI ones. The rest exist because a row can end
 * without one: an upstream error, a connect/stall timeout, a rate limit, a
 * client hang-up, or a 200 stream that simply never carried a terminal token.
 * Before this set existed those rows rendered a bare em dash, which made an
 * error indistinguishable from "we never recorded anything".
 */
export const ENDING_REASON = {
  // Clean terminations (upstream told us).
  STOP: OPENAI_FINISH.STOP,
  LENGTH: OPENAI_FINISH.LENGTH,
  TOOL_CALLS: OPENAI_FINISH.TOOL_CALLS,
  CONTENT_FILTER: OPENAI_FINISH.CONTENT_FILTER,
  // Failure terminations (no finish_reason on the wire).
  TIMEOUT: "timeout",
  RATE_LIMIT: "rate_limit",
  AUTH_ERROR: "auth_error",
  INVALID_REQUEST: "invalid_request",
  UPSTREAM_ERROR: "upstream_error",
  // Abnormal-but-not-upstream-fault terminations.
  ABORTED: "aborted",
  INCOMPLETE: "incomplete",
  EMPTY: "empty",
  UNKNOWN: "unknown",
};

/** Text/status signatures of a connect or stream timeout (not a 4xx/5xx body). */
const TIMEOUT_RE = /(connect timeout|stall timeout|timed?\s*out|ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)/i;

/**
 * Classify a FAILED request (no upstream finish_reason exists) into one bucket.
 *
 * Order matters: an AbortError caused by our own connect timer surfaces as
 * "fetch connect timeout", so timeout signatures must win over the 502 status
 * the executor wraps them in. `aborted` is only for a caller/stream abort that
 * was not a timeout.
 *
 * @param {object} opts
 * @param {number|string} [opts.status] - upstream/derived HTTP status
 * @param {string} [opts.message] - human-readable error text
 * @param {boolean} [opts.aborted] - the request/stream was cancelled
 * @param {string} [opts.code] - low-level cause code (ETIMEDOUT, ECONNRESET, …)
 * @returns {{reason: string, native: string}}
 */
export function classifyFailureReason({ status, message, aborted = false, code = "" } = {}) {
  const text = typeof message === "string" ? message : message == null ? "" : String(message);
  const codeStr = typeof code === "string" ? code : "";
  const num = Number(status);
  // A timeout is the most specific signature: keep it ahead of status mapping so
  // a connect timer's synthesized 502 does not read as a generic upstream error.
  if (TIMEOUT_RE.test(text) || TIMEOUT_RE.test(codeStr)) {
    return { reason: ENDING_REASON.TIMEOUT, native: text || codeStr };
  }
  if (aborted) {
    return { reason: ENDING_REASON.ABORTED, native: text || codeStr || "aborted" };
  }
  if (num === 429) return { reason: ENDING_REASON.RATE_LIMIT, native: text || "429" };
  if (num === 401 || num === 402 || num === 403) {
    return { reason: ENDING_REASON.AUTH_ERROR, native: text || String(num) };
  }
  if (num === 400 || num === 404 || num === 406 || num === 422) {
    return { reason: ENDING_REASON.INVALID_REQUEST, native: text || String(num) };
  }
  if (Number.isInteger(num) && num >= 500) {
    return { reason: ENDING_REASON.UPSTREAM_ERROR, native: text || String(num) };
  }
  // No numeric status but real text (network-level failures) is still the upstream's fault.
  if (text) return { reason: ENDING_REASON.UPSTREAM_ERROR, native: text };
  return { reason: ENDING_REASON.UNKNOWN, native: codeStr || "no reason recorded" };
}

/**
 * Classify a SUCCESSFUL row that carried no terminal reason from the upstream.
 *
 * A 200 with output but no finish_reason is not a clean `stop` (the turn may
 * have been cut), so it reads `incomplete`; a 200 with no output at all reads
 * `empty`. Both are far more honest than an em dash.
 *
 * @param {{reason: string, native?: string|null}|null} stopInfo - parsed reason
 * @param {string} contentText - the client-visible answer text
 * @returns {{reason: string, native: string|null}}
 */
export function classifySuccessReason(stopInfo, contentText) {
  if (stopInfo?.reason) return stopInfo;
  const hasContent = typeof contentText === "string" && contentText.trim().length > 0;
  return {
    reason: hasContent ? ENDING_REASON.INCOMPLETE : ENDING_REASON.EMPTY,
    native: null,
  };
}

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
