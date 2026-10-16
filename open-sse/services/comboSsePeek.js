// Combo seat SSE peek: decide whether an HTTP 200 SSE stream carries ANY usable
// content, so handleComboChat can fall back instead of handing an empty "success"
// to the client (symptom: COMBO "succeeded" + 📊 DONE with IN 0 · OUT 0).
//
// Byte-loss-free by construction: response.body is tee()d; the peek twin is
// drained for the verdict and the client branch is returned untouched, so the
// first byte a client sees (and thus TTFT) is unchanged.
//
// Fail-safe direction: anything unparseable or ambiguous is judged NOT empty —
// a malformed stream is surfaced to the client rather than silently retried.
// Peek is skipped entirely for binary/NDJSON upstreams (content-type gate in
// combo.js) — protobuf/EventStream bodies never enter this module.

import { COMBO_SSE_EMPTY_PEEK_TIMEOUT_MS } from "../config/runtimeConfig.js";

// A judge that keeps saying "unknown" on a hostile stream must not buffer
// forever; past this, treat as content (surface to client).
const MAX_PEEK_BUFFER_BYTES = 256 * 1024;

// JSON keys whose (non-empty) string value means the model is ANSWERING.
// "delta" covers Responses-API string deltas ("response.output_text.delta");
// "partial_json" covers Anthropic tool-input deltas.
const ANSWER_STRING_KEYS = new Set(["content", "text", "delta", "partial_json"]);

// Reasoning carriers are a WEAK signal: mid-stream they never trigger fallback
// (thinking legitimately precedes content), but a stream that TERMINATES with
// reasoning and an empty answer field is a dead response — the model dumped its
// whole output into thinking — and must fall back. judgeFrame returns
// "thought" for them; only judgeSseFinal acts on it.
const REASONING_STRING_KEYS = new Set(["reasoning_content", "reasoning", "thinking"]);

// Responses-API reasoning events ("response.reasoning_text.delta" & co): their
// string delta rides under the generic "delta" key, so the event TYPE must
// reclassify it as thought.
const RESPONSE_REASONING_TYPE_PREFIX = "response.reasoning";

// JSON keys whose non-null value means structured output (tool call in flight).
const CONTENT_OBJECT_KEYS = new Set(["tool_calls", "function_call", "functionCall", "tool_use"]);

// type values (anthropic content_block.type, responses item.type, …) that mean output.
const CONTENT_TYPE_VALUES = new Set(["tool_use", "function_call", "functionCall"]);

// SSE terminal markers: seeing one with no content signal before it means empty.
const SSE_DONE = "[DONE]";

/**
 * Judge the buffered SSE text. Returns:
 *   "content" — a frame carries answer text / tool call (strong signal)
 *   "error"   — an upstream error frame (OpenAI {error}, Anthropic {type:"error"})
 *   "unknown" — need more data (reasoning/thought frames are weak and ignored here)
 * @param {string} text
 * @returns {"content"|"error"|"unknown"}
 */
export function judgeSseBuffer(text) {
  if (!text) return "unknown";
  const events = text.split(/\r?\n\r?\n/);
  for (const event of events) {
    for (const line of event.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      if (payload === SSE_DONE) continue; // terminal marker alone proves nothing yet
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; } // partial frame — wait for more
      const verdict = judgeFrame(obj);
      // "thought" is deliberately NOT acted on mid-stream: thinking deltas
      // legitimately precede the answer, so they must never early-return.
      if (verdict === "content" || verdict === "error") return verdict;
    }
  }
  return "unknown";
}

/**
 * End-of-stream judgement: the upstream closed with no content signal.
 * Frame-level scan for terminal evidence ([DONE], OpenAI finish_reason,
 * Anthropic message_stop/message_delta, Gemini finishReason); a stream that
 * parsed cleanly but never carried a content signal IS empty (that is exactly
 * what e.g. a Gemini zero-delta stream looks like). A stream that terminates
 * carrying ONLY reasoning (the model dumped its output into thinking and the
 * answer field stayed empty) is "thought-only" — dead for the client, fallback.
 * Leftover unparseable data with no terminal marker is fail-safe "content" —
 * surface, don't retry.
 * @param {string} text
 * @returns {"content"|"error"|"thought-only"|"empty"}
 */
export function judgeSseFinal(text) {
  if (!text || !text.trim()) return "empty";
  const mid = judgeSseBuffer(text);
  if (mid !== "unknown") return mid;
  let sawTerminal = false;
  let sawData = false;
  let sawThought = false;
  let sawUnparseable = false;
  for (const event of text.split(/\r?\n\r?\n/)) {
    if (!event.trim()) continue;
    for (const line of event.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      if (payload === SSE_DONE) { sawTerminal = true; continue; }
      let obj;
      try { obj = JSON.parse(payload); } catch { sawUnparseable = true; continue; }
      sawData = true;
      const signal = judgeFrame(obj);
      if (signal === "content") return "content";
      if (signal === "error") return "error";
      if (signal === "thought") sawThought = true;
      if (isTerminalFrame(obj)) sawTerminal = true;
    }
  }
  if (sawUnparseable && !sawTerminal) return "content";
  if (sawTerminal || !sawData) {
    // Terminal reached (or nothing but whitespace) with zero answer signal.
    // Reasoning-only output is the "answer dumped into thinking" failure —
    // dead for the client, fall back. Unparsed garbage near a terminal marker
    // does not rescue it.
    return sawThought ? "thought-only" : "empty";
  }
  return "content";
}

// A frame after which no model output can arrive anymore.
function isTerminalFrame(obj) {
  if (obj?.type === "message_stop") return true; // anthropic
  if (obj?.type === "message_delta" && obj?.delta?.stop_reason) return true; // anthropic
  if (obj?.type === "response.completed" || obj?.type === "response.incomplete") return true; // responses api
  if (obj?.type === "response.failed") return true; // responses api terminal failure
  if (Array.isArray(obj?.choices) && obj.choices.some((c) => c?.finish_reason)) return true; // openai final frame
  if (Array.isArray(obj?.candidates) && obj.candidates.some((c) => c?.finishReason)) return true; // gemini
  if (obj?.done === true) return true; // ollama final frame
  return false;
}

// Walk one parsed frame. Depth-capped, cycle-free (fresh JSON.parse product).
// Verdicts: "content" (strong, wins immediately), "thought" (weak — the frame
// only carries reasoning), "error", "unknown". Within one frame, any strong
// signal beats a thought found elsewhere in the same frame; thoughts are
// collected at every level and only surface if nothing stronger exists.
function judgeFrame(node, key = "", depth = 0) {
  if (node == null || depth > 6) return "unknown";
  if (Array.isArray(node)) {
    if (key === "tool_calls" && node.length > 0) return "content";
    let sawThought = false;
    for (const item of node) {
      const v = judgeFrame(item, key, depth + 1);
      if (v === "content" || v === "error") return v;
      if (v === "thought") sawThought = true;
    }
    return sawThought ? "thought" : "unknown";
  }
  if (typeof node === "object") {
    if (node.type === "error" || (node.error && typeof node.error === "object") || typeof node.error === "string") return "error";
    // Responses-API reasoning events: their payload string rides under the
    // generic "delta" key, so the event TYPE reclassifies the frame as thought.
    if (typeof node.type === "string" && node.type.startsWith(RESPONSE_REASONING_TYPE_PREFIX)) {
      return "thought";
    }
    let sawThought = false;
    for (const [k, v] of Object.entries(node)) {
      if (CONTENT_OBJECT_KEYS.has(k) && v != null) return "content";
      if (k === "type" && typeof v === "string" && CONTENT_TYPE_VALUES.has(v)) return "content";
      // Weak signal: reasoning riding directly under a reasoning key.
      if (typeof v === "string" && v.trim().length > 0 && REASONING_STRING_KEYS.has(k)) { sawThought = true; continue; }
      const verdict = judgeFrame(v, k, depth + 1);
      if (verdict === "content" || verdict === "error") return verdict;
      if (verdict === "thought") sawThought = true;
    }
    return sawThought ? "thought" : "unknown";
  }
  if (typeof node === "string") {
    if (ANSWER_STRING_KEYS.has(key) && node.trim().length > 0) return "content";
  }
  return "unknown";
}

/**
 * Peek an SSE response body and decide whether the seat is empty.
 * On success the original response MUST be discarded in favor of the returned
 * rewrap (its body is the client-side tee branch; the peek twin is released).
 *
 * @param {Response} response - upstream 200 response with an SSE body
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs] - peek window; 0 disables (returns not-empty)
 * @returns {Promise<{empty: false, response: Response} | {empty: true, reason: string}>}
 *   Never throws: on internal failure returns the original body rewrapped (fail-open).
 */
export async function peekSseEmptySeat(response, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? COMBO_SSE_EMPTY_PEEK_TIMEOUT_MS;
  if (!timeoutMs || timeoutMs <= 0 || !response?.body) {
    return { empty: false, response };
  }

  let clientBranch;
  let peekBranch;
  try {
    [clientBranch, peekBranch] = response.body.tee();
  } catch {
    return { empty: false, response };
  }

  const rewrap = () => new Response(clientBranch, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });

  const reader = peekBranch.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pendingTimer = null;
  const clearPendingTimer = () => {
    if (pendingTimer != null) { clearTimeout(pendingTimer); pendingTimer = null; }
  };
  try {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const wait = reader.read();
      wait.catch(() => {});
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reader.cancel().catch(() => {});
        clientBranch.cancel().catch(() => {});
        return { empty: true, reason: "timeout-no-data" };
      }
      // Race the chunk against the peek window: first byte wins instantly
      // (TTFT untouched), only genuine silence burns the window.
      const result = await new Promise((resolve, reject) => {
        let settled = false;
        pendingTimer = setTimeout(() => {
          settled = true;
          clearPendingTimer();
          resolve(null);
        }, remaining);
        wait.then(
          (r) => { if (!settled) { settled = true; clearPendingTimer(); resolve(r); } },
          (err) => { if (!settled) { settled = true; clearPendingTimer(); reject(err); } }
        );
      });
      if (result === null) {
        reader.cancel().catch(() => {});
        clientBranch.cancel().catch(() => {});
        return { empty: true, reason: "timeout-no-data" };
      }
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const verdict = judgeSseBuffer(buffer);
      if (verdict === "content") {
        peekBranch.cancel().catch(() => {});
        return { empty: false, response: rewrap() };
      }
      if (verdict === "error") {
        reader.cancel().catch(() => {});
        clientBranch.cancel().catch(() => {});
        return { empty: true, reason: "error-frame" };
      }
      if (buffer.length > MAX_PEEK_BUFFER_BYTES) {
        peekBranch.cancel().catch(() => {});
        return { empty: false, response: rewrap() };
      }
    }
    buffer += decoder.decode();
    const finalVerdict = judgeSseFinal(buffer);
    if (finalVerdict === "content") {
      peekBranch.cancel().catch(() => {});
      return { empty: false, response: rewrap() };
    }
    reader.cancel().catch(() => {});
    clientBranch.cancel().catch(() => {});
    const reason = finalVerdict === "error" ? "error-frame"
      : finalVerdict === "thought-only" ? "thought-only"
      : "done-no-content";
    return { empty: true, reason };
  } catch {
    // Peek infrastructure failed — never break the seat over it. Rewrap the
    // untouched client branch so the caller still has a body to return.
    clearPendingTimer();
    reader.cancel().catch(() => {});
    try { peekBranch.cancel().catch(() => {}); } catch {}
    return { empty: false, response: rewrap() };
  }
}
