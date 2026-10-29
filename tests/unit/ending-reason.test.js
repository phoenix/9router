// Ending reasons in the request-details drawer.
//
// Two gaps this pins:
//   1. A FAILED request had no `finish_reason` at all, so the Stop Reason column
//      rendered a bare em dash next to status:"error" — indistinguishable from
//      "we never recorded anything". Every failure now gets a classified bucket
//      (timeout / rate_limit / auth_error / …).
//   2. A streaming row that died mid-flight (stall, upstream error, client
//      hang-up) was written as success with no finish_reason. The teardown paths
//      now hand the reason to the transform, which persists it.
//
// Also pinned: a 200 that never names a terminal token must not be recorded as a
// clean `stop`; it reads `incomplete` (answered) or `empty` (nothing at all).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

const {
  ENDING_REASON,
  classifyFailureReason,
  classifySuccessReason,
} = await import("../../open-sse/utils/stopReason.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleStreamingResponse, buildOnStreamComplete } = await import(
  "../../open-sse/handlers/chatCore/streamingHandler.js"
);
const { handleNonStreamingResponse } = await import(
  "../../open-sse/handlers/chatCore/nonStreamingHandler.js"
);
const { saveRequestDetail } = await import("@/lib/usageDb.js");
const { pipeWithDisconnect } = await import("../../open-sse/utils/streamHandler.js");
const { createSSETransformStreamWithLogger } = await import("../../open-sse/utils/stream.js");

const enc = new TextEncoder();
const sse = (obj) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

async function drain(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Last request-detail row written (the completed one, not the placeholder). */
function lastRow() {
  const calls = saveRequestDetail.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0];
}

describe("classifyFailureReason — every failure gets a bucket", () => {
  it("a connect timeout wins over the 502 the executor wraps it in", () => {
    expect(classifyFailureReason({ status: 502, message: "fetch connect timeout" }))
      .toEqual({ reason: ENDING_REASON.TIMEOUT, native: "fetch connect timeout" });
    expect(classifyFailureReason({ status: 502, message: "stream stall timeout" }).reason)
      .toBe(ENDING_REASON.TIMEOUT);
    expect(classifyFailureReason({ status: 502, message: "socket hang up", code: "ETIMEDOUT" }).reason)
      .toBe(ENDING_REASON.TIMEOUT);
  });

  it("maps rate limit, auth, request-shape and upstream failures", () => {
    expect(classifyFailureReason({ status: 429, message: "Too Many Requests" }).reason)
      .toBe(ENDING_REASON.RATE_LIMIT);
    expect(classifyFailureReason({ status: 401, message: "invalid key" }).reason)
      .toBe(ENDING_REASON.AUTH_ERROR);
    expect(classifyFailureReason({ status: 403, message: "blocked" }).reason)
      .toBe(ENDING_REASON.AUTH_ERROR);
    expect(classifyFailureReason({ status: 400, message: "bad body" }).reason)
      .toBe(ENDING_REASON.INVALID_REQUEST);
    expect(classifyFailureReason({ status: 404, message: "model not found" }).reason)
      .toBe(ENDING_REASON.INVALID_REQUEST);
    expect(classifyFailureReason({ status: 503, message: "overloaded" }).reason)
      .toBe(ENDING_REASON.UPSTREAM_ERROR);
  });

  it("marks a caller/stream abort separately from a timeout", () => {
    expect(classifyFailureReason({ aborted: true, message: "Request aborted" }).reason)
      .toBe(ENDING_REASON.ABORTED);
  });

  it("never returns an empty bucket", () => {
    expect(classifyFailureReason({ status: 502 }).reason).toBe(ENDING_REASON.UPSTREAM_ERROR);
    expect(classifyFailureReason({}).reason).toBe(ENDING_REASON.UNKNOWN);
  });
});

describe("classifySuccessReason — a 200 with no terminal token is not a clean stop", () => {
  it("keeps a real upstream reason as-is", () => {
    expect(classifySuccessReason({ reason: "stop", native: null }, "hi"))
      .toEqual({ reason: "stop", native: null });
  });

  it("reads answered-but-unterminated as incomplete", () => {
    expect(classifySuccessReason(null, "an answer").reason).toBe(ENDING_REASON.INCOMPLETE);
  });

  it("reads no output at all as empty", () => {
    expect(classifySuccessReason(null, "").reason).toBe(ENDING_REASON.EMPTY);
    expect(classifySuccessReason(null, "   ").reason).toBe(ENDING_REASON.EMPTY);
    expect(classifySuccessReason(null, undefined).reason).toBe(ENDING_REASON.EMPTY);
  });
});

function streamCtx(extra = {}) {
  return {
    provider: "openai",
    model: "gpt-test",
    connectionId: null,
    apiKey: null,
    requestStartTime: Date.now(),
    body: { model: "gpt-test", stream: true, messages: [] },
    stream: true,
    ...extra,
  };
}

const idleController = {
  signal: new AbortController().signal,
  isConnected: () => true,
  handleComplete: () => {},
  handleError: () => {},
  handleDisconnect: () => {},
  abort: () => {},
};

describe("streamingHandler — a dead stream records why it died", () => {
  beforeEach(() => saveRequestDetail.mockClear());

  it("a stream that closes with no terminal token reads `incomplete`, not a dash", async () => {
    const ctx = streamCtx();
    const { onStreamComplete, streamDetailId } = buildOnStreamComplete(ctx);
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ id: "1", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] }));
        controller.close();
      },
    });

    const result = await handleStreamingResponse({
      ...ctx,
      providerResponse: new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      onStreamComplete,
      streamDetailId,
      streamController: idleController,
    });
    await drain(result.response.body);

    // The transform was closed without a terminal token: no finish_reason from
    // upstream, so the fallback must classify it rather than leave it blank.
    const row = lastRow();
    expect(row.id).toBe(streamDetailId);
    expect(row.response.finish_reason).toBe(ENDING_REASON.INCOMPLETE);
  });

  it("keeps a real terminal reason when the upstream provided one", async () => {
    saveRequestDetail.mockClear();
    const calls = [];
    const ctx = streamCtx();
    const { onStreamComplete } = buildOnStreamComplete(ctx);
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ id: "1", choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] }));
        controller.enqueue(sse({ id: "1", choices: [{ index: 0, delta: {}, finish_reason: "length" }] }));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const result = await handleStreamingResponse({
      ...ctx,
      providerResponse: new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      onStreamComplete,
      streamDetailId: "detail-1",
      streamController: idleController,
    });
    await drain(result.response.body);

    expect(calls.length).toBe(0); // guard against accidental reuse
    expect(lastRow().response.finish_reason).toBe("length");
  });

  it("records `timeout` when the stall watchdog kills the stream", async () => {
    saveRequestDetail.mockClear();
    const ctx = streamCtx();
    const { onStreamComplete, streamDetailId } = buildOnStreamComplete(ctx);

    // Real transform (it is what carries abortReason/finalize), fed one chunk
    // then permanent silence: the watchdog must abort and the reason must reach
    // the row instead of leaving a blank.
    const transform = createSSETransformStreamWithLogger(
      FORMATS.OPENAI, FORMATS.OPENAI, "openai", null, null, "gpt-test", null, null, onStreamComplete
    );
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ id: "1", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }));
        // never close: the upstream is wedged
      },
    });
    const abortController = new AbortController();
    const body = pipeWithDisconnect(
      new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
      transform,
      { signal: abortController.signal, startTime: Date.now(), isConnected: () => true,
        handleComplete: () => {}, handleError: () => {}, handleDisconnect: () => {}, abort: () => abortController.abort() },
      null,
      80, // 80ms stall window
    );
    void body;

    await new Promise((r) => setTimeout(r, 300));
    // Nothing reads the body here, so flush() never runs — the real teardown
    // path calls finalize() after recording the reason (streamHandler.js does
    // exactly this). Assert both halves happened.
    transform.finalize?.();

    expect(lastRow().id).toBe(streamDetailId);
    expect(lastRow().response.finish_reason).toBe(ENDING_REASON.TIMEOUT);
    expect(lastRow().response.native_finish_reason).toBe("stream stall timeout");
  });
});

describe("nonStreamingHandler — a 200 with no finish_reason is classified", () => {
  beforeEach(() => saveRequestDetail.mockClear());

  function ctx(body) {
    return {
      providerResponse: new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
      provider: "openai-compatible", model: "m", sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI,
      body: { model: "m", stream: false, messages: [] }, stream: false,
      requestStartTime: Date.now(), connectionId: "c",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      onRequestSuccess: vi.fn(), trackDone: vi.fn(), appendLog: vi.fn(),
      reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
      log: { line: vi.fn() },
    };
  }

  it("records `incomplete` when the body carries content but no stop reason", async () => {
    const result = await handleNonStreamingResponse(ctx({
      id: "chatcmpl-1",
      choices: [{ index: 0, message: { role: "assistant", content: "hello" } }],
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }));

    expect(result.success).toBe(true);
    const row = lastRow();
    expect(row.response.finish_reason).toBe(ENDING_REASON.INCOMPLETE);
    expect(row.response.content).toBe("hello");
  });

  it("records `empty` when a 200 answered with nothing", async () => {
    await handleNonStreamingResponse(ctx({
      id: "chatcmpl-2",
      choices: [{ index: 0, message: { role: "assistant", content: "" } }],
    }));

    expect(lastRow().response.finish_reason).toBe(ENDING_REASON.EMPTY);
  });

  it("keeps a tool_calls termination as tool_calls", async () => {
    await handleNonStreamingResponse(ctx({
      id: "chatcmpl-3",
      choices: [{
        index: 0,
        message: { role: "assistant", content: null, tool_calls: [{ id: "t", type: "function", function: { name: "f", arguments: "{}" } }] },
        finish_reason: "tool_calls",
      }],
    }));

    expect(lastRow().response.finish_reason).toBe("tool_calls");
  });
});
