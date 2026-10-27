// TLS-impersonating HTTP client for opencode.ai's free tier.
//
// The free gate keys on the TLS ClientHello, not on headers: a request that
// passes from the OpenCode CLI is refused with 429 FreeUsageLimitError when the
// same body/headers ride Node's OpenSSL fingerprint, and passes again once the
// cipher list matches. Measured 2026-10-26 on one process, one egress IP, three
// transports: node fetch/https/http2 all 429, Bun's BoringSSL fetch 200.
// JA4's cipher hash identifies the list (Bun: 5b57614c22b0), so the match is on
// the cipher-list hash and nothing else — reordering the same list still passes.
//
// wreq-js is an optional dependency; when absent the caller keeps its native
// fetch and stays subject to the gate rather than failing the request here.

import {
  FETCH_CONNECT_TIMEOUT_MS,
  STREAM_FIRST_CHUNK_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
} from "../config/runtimeConfig.js";
import { loadRuntimeDep } from "./lazyRuntime.js";

// BoringSSL/Chrome-family cipher list the upstream accepts, in the order Bun
// sends it. Only the list's hash is compared, so this must stay verbatim.
const OPENCODE_CIPHER_LIST = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-SHA",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-ECDSA-AES256-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

let sessionPromise = null;

export class OpencodeTlsUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "OpencodeTlsUnavailableError";
  }
}

/**
 * Raised when no bytes arrive from upstream within the idle window. This is the
 * ONLY timeout semantic for streaming: a live stream that keeps emitting is
 * never cut off, no matter how long it runs.
 */
export class StreamIdleTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "StreamIdleTimeoutError";
  }
}

async function loadSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const wreq = await loadRuntimeDep("wreq-js");
      if (typeof wreq.createSession !== "function") {
        throw new Error("wreq-js runtime is missing createSession");
      }
      return wreq.createSession({
        emulation: { tlsOptions: { cipherList: OPENCODE_CIPHER_LIST } },
      });
    })().catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

/** Drop the cached session so the next call builds a fresh one. */
export function resetOpencodeTlsSession() {
  const pending = sessionPromise;
  sessionPromise = null;
  pending?.then((session) => session.close?.()).catch(() => {});
}

/**
 * Fetch through the impersonated-TLS session. Returns a native Response so
 * downstream `.body` / `.text()` / `.json()` consumers keep working unchanged.
 *
 * Streaming is preserved: the response body is handed over as the live
 * ReadableStream, never buffered.
 *
 * Timeout semantics (2026-10-27): wreq's `timeout` is a WHOLE-request deadline —
 * it aborts the response mid-stream even while bytes are still flowing (measured:
 * a stream emitting every 500ms was killed at the deadline with "request or
 * response body error: operation timed out"). So `timeout` is pinned to 0 (no
 * deadline) and idleness is guarded instead, per phase (kiro.js precedent:
 * `sawChunk ? stallTimeout : ttftTimeout`):
 *   headers     — no response headers within `headersTimeoutMs`  → abort
 *   first byte  — headers ok but no body byte within `ttftTimeoutMs` (prefill
 *                 is legitimately slow; this is its budget)        → abort
 *   mid-stream  — a byte has flowed, then silence > `idleTimeoutMs` → abort
 * A live stream that keeps emitting is never cut off, however long it runs.
 */
export async function opencodeTlsFetch(url, init = {}, {
  signal,
  headersTimeoutMs = FETCH_CONNECT_TIMEOUT_MS,
  ttftTimeoutMs = STREAM_FIRST_CHUNK_TIMEOUT_MS,
  idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS,
} = {}) {
  let session;
  try {
    session = await loadSession();
  } catch (error) {
    throw new OpencodeTlsUnavailableError(
      `wreq-js unavailable (${error instanceof Error ? error.message : "unknown"}) — install the optional wreq-js dependency to reach the OpenCode free tier`
    );
  }

  // Idle watchdog: one deadline per phase, budget chosen by the phase.
  const idleCtrl = new AbortController();
  let idleError = null;
  const fireIdle = (phase, budgetMs) => {
    idleError = new StreamIdleTimeoutError(
      `opencode upstream sent no bytes for ${budgetMs}ms (${phase})`
    );
    idleCtrl.abort(idleError);
    return idleError;
  };
  const idleDeadline = (phase, budgetMs) => {
    if (!(budgetMs > 0)) return { promise: new Promise(() => {}), cancel: () => {} };
    let timer = null;
    const promise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(fireIdle(phase, budgetMs)), budgetMs);
      timer.unref?.();
    });
    return { promise, cancel: () => clearTimeout(timer) };
  };

  const options = {
    method: init.method || "GET",
    headers: init.headers,
    redirect: "follow",
    // Whole-request deadline: 0 = none (wreq contract). Stream lifetime is
    // governed by the idle watchdog above, not by a wall clock.
    timeout: 0,
    signal: signal ? AbortSignal.any([signal, idleCtrl.signal]) : idleCtrl.signal,
  };
  if (init.body !== undefined) options.body = init.body;

  let res;
  const headersIdle = idleDeadline("headers", headersTimeoutMs);
  try {
    res = await Promise.race([session.fetch(url, options), headersIdle.promise]);
  } catch (error) {
    headersIdle.cancel();
    throw idleError || error;
  }
  headersIdle.cancel();

  const headers = {};
  res.headers?.forEach?.((value, key) => {
    headers[key] = value;
  });

  // Body phase: guarded per read so silence kills the stream while steady
  // chunks — however slow — always survive. First byte gets the TTFT budget
  // (prefill); every later gap gets the tight inter-chunk idle budget.
  let guardedBody = res.body ?? null;
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    let sawChunk = false;
    guardedBody = new ReadableStream({
      async pull(controller) {
        const budgetMs = sawChunk ? idleTimeoutMs : ttftTimeoutMs;
        const phase = sawChunk ? "body" : "first-byte";
        const bodyIdle = idleDeadline(phase, budgetMs);
        try {
          const result = await Promise.race([reader.read(), bodyIdle.promise]);
          bodyIdle.cancel();
          if (result.done) {
            controller.close();
            return;
          }
          sawChunk = true;
          controller.enqueue(result.value);
        } catch (error) {
          bodyIdle.cancel();
          try { reader.cancel(error); } catch { /* already gone */ }
          controller.error(idleError || error);
        }
      },
      cancel(reason) {
        try { reader.cancel(reason); } catch { /* already gone */ }
      },
    });
  }

  return new Response(guardedBody, { status: res.status, statusText: res.statusText, headers });
}

export const __test__ = { OPENCODE_CIPHER_LIST };
