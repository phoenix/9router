// Draining helpers for the forced-streaming → single-JSON path.
//
// handleForcedSSEToJson must consume a whole upstream SSE body before it can
// answer the client with one JSON document. Two things must be measured while
// that happens, and neither is available from `providerResponse.text()`:
//
//   1. TTFT — the client-visible "time to first token". providerResponse.text()
//      returns only after the LAST byte, so the duration it is bracketed by is
//      the full generation time. Recording that as TTFT (which is what this path
//      used to do) made every forced-stream request show TTFT == Total and hid
//      the prefill/startup cost entirely.
//
//   2. A stall guard — providerResponse.text() has no timeout of its own. An
//      upstream that sends headers and then goes silent wedges the request until
//      some outer deadline fires, even though the same request on the streaming
//      path would be aborted by STREAM_STALL_TIMEOUT_MS.
//
// This mirrors pipeWithDisconnect's watchdog, but for a body we fully buffer
// rather than pipe. The timer tracks raw byte activity, so a slow reasoning
// model that emits partial frames is not mistaken for a stalled one.
import { STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { dbg } from "../../utils/debugLog.js";

/**
 * Drain a Response body, recording when the first byte arrived and aborting if
 * the upstream goes quiet for too long.
 *
 * @param {object} options
 * @param {ReadableStream} options.body - upstream body (providerResponse.body)
 * @param {number} options.requestStartTime - Date.now() when the request started
 * @param {AbortSignal} [options.signal] - aborts the upstream fetch on stall
 * @param {function} [options.now] - injectable clock, for deterministic tests
 * @param {number} [options.stallTimeoutMs] - idle window before giving up
 * @returns {Promise<{text: string, ttft: number|null, stalled: boolean, bytes: number}>}
 */
export async function drainWithTTFT({
  body,
  requestStartTime,
  signal = null,
  now = Date.now,
  stallTimeoutMs = STREAM_STALL_TIMEOUT_MS
} = {}) {
  if (!body || typeof body.getReader !== "function") {
    // Body already consumed or absent — caller falls back to .text().
    return { text: null, ttft: null, stalled: false, bytes: 0 };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  let ttft = null;
  let stalled = false;
  let bytes = 0;
  let chunks = 0;
  let lastChunkAt = now();
  const t0 = lastChunkAt;
  let timer = null;

  const clearStall = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  const armStall = () => {
    if (!Number.isFinite(stallTimeoutMs) || stallTimeoutMs <= 0) return;
    clearStall();
    timer = setTimeout(() => {
      stalled = true;
      dbg("SSE2JSON", `STALL TIMEOUT ${stallTimeoutMs}ms | chunks=${chunks} | bytes=${bytes} | sinceLast=${now() - lastChunkAt}ms`);
      // Abort the underlying fetch, then let the read loop unwind naturally.
      // The signal is shared with the executor, so this also frees the socket.
      try { signal?.abort?.(); } catch { /* nothing to abort */ }
      reader.cancel().catch(() => {});
    }, stallTimeoutMs);
  };

  armStall();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      if (ttft === null) ttft = now() - requestStartTime;
      chunks++;
      bytes += value?.byteLength || value?.length || 0;
      lastChunkAt = now();
      armStall();
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    // A stall abort surfaces as an AbortError from the reader; that is the
    // expected way out, not an upstream failure to report separately.
    if (!stalled) {
      dbg("SSE2JSON", `drain error: ${error?.message} | chunks=${chunks} | bytes=${bytes}`);
      clearStall();
      throw error;
    }
  } finally {
    clearStall();
  }

  dbg("SSE2JSON", `drain done | chunks=${chunks} | bytes=${bytes} | ttft=${ttft === null ? "n/a" : `${ttft}ms`} | dur=${now() - t0}ms | stalled=${stalled}`);
  return { text, ttft, stalled, bytes };
}

/**
 * Resolve a latency pair for the request-detail row.
 *
 * When no first-byte timing could be observed (the body was already consumed, so
 * the caller had to fall back to .text()), report ttft === total. That is the
 * conservative pre-existing value: it says "unmeasured", whereas 0 would claim
 * an instant first token.
 */
export function resolveLatency({ requestStartTime, ttft, now = Date.now }) {
  const total = now() - requestStartTime;
  return { ttft: ttft === null || ttft === undefined ? total : ttft, total };
}
