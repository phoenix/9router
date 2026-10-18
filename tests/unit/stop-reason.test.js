// "Stop reason" on /dashboard/usage?tab=details.
//
// The request-details drawer used to show no termination reason at all, and the
// streaming path never recorded one: streamingHandler stored
// `response: { content, thinking, type: "streaming" }` with no finish_reason, so
// every streamed row had an empty stop reason even though the upstream had told
// us (OpenAI `finish_reason`, Claude `stop_reason`, Gemini `finishReason`,
// Ollama `done_reason`, Responses `response.completed/incomplete`).
//
// These tests pin three things:
//   1. parseFinishReason() normalizes every upstream vocabulary to one
//      OpenAI-style value while keeping the native token for display.
//   2. the SSE transform hands the reason to onStreamComplete (stream.js), so
//      the streaming row can be updated instead of staying blank.
//   3. handleStreamingResponse persists it as response.finish_reason — the same
//      field the non-streaming path already writes.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { parseFinishReason } = await import("../../open-sse/utils/stopReason.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } = await import(
  "../../open-sse/utils/stream.js"
);
const { handleStreamingResponse, buildOnStreamComplete } = await import(
  "../../open-sse/handlers/chatCore/streamingHandler.js"
);
const { saveRequestDetail } = await import("@/lib/usageDb.js");

const enc = new TextEncoder();

function sse(obj) {
  return enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
}

async function drain(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

describe("parseFinishReason — upstream vocabularies → one normalized reason", () => {
  it("reads OpenAI finish_reason and keeps it as-is", () => {
    expect(parseFinishReason({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }))
      .toEqual({ reason: "stop", native: null });
    expect(parseFinishReason({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }))
      .toEqual({ reason: "length", native: null });
    expect(parseFinishReason({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }))
      .toEqual({ reason: "tool_calls", native: null });
  });

  it("reads finish_reason nested on delta (Qoder-style chunks)", () => {
    expect(parseFinishReason({ choices: [{ index: 0, delta: { finish_reason: "stop" } }] }))
      .toEqual({ reason: "stop", native: null });
  });

  it("maps Claude stop_reason and reports the native token", () => {
    expect(parseFinishReason({ type: "message_delta", delta: { stop_reason: "end_turn" } }))
      .toEqual({ reason: "stop", native: "end_turn" });
    expect(parseFinishReason({ type: "message_delta", delta: { stop_reason: "max_tokens" } }))
      .toEqual({ reason: "length", native: "max_tokens" });
    expect(parseFinishReason({ type: "message_delta", delta: { stop_reason: "tool_use" } }))
      .toEqual({ reason: "tool_calls", native: "tool_use" });
    // Anthropic API-level refusal must not read as a clean stop.
    expect(parseFinishReason({ type: "message_delta", delta: { stop_reason: "refusal" } }))
      .toEqual({ reason: "content_filter", native: "refusal" });
  });

  it("maps Gemini finishReason", () => {
    expect(parseFinishReason({ candidates: [{ finishReason: "STOP" }] }))
      .toEqual({ reason: "stop", native: "STOP" });
    expect(parseFinishReason({ candidates: [{ finishReason: "MAX_TOKENS" }] }))
      .toEqual({ reason: "length", native: "MAX_TOKENS" });
    expect(parseFinishReason({ candidates: [{ finishReason: "SAFETY" }] }))
      .toEqual({ reason: "content_filter", native: "SAFETY" });
    // Antigravity wraps the payload in { response: {...} }.
    expect(parseFinishReason({ response: { candidates: [{ finishReason: "MAX_TOKENS" }] } }))
      .toEqual({ reason: "length", native: "MAX_TOKENS" });
  });

  it("maps Ollama done_reason on the final NDJSON chunk", () => {
    expect(parseFinishReason({ done: true, done_reason: "length" }))
      .toEqual({ reason: "length", native: "length" });
    expect(parseFinishReason({ done: false, message: { content: "x" } })).toBeNull();
  });

  it("maps Responses API terminal events", () => {
    expect(parseFinishReason({ type: "response.completed" })).toEqual({ reason: "stop", native: null });
    expect(
      parseFinishReason({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } })
    ).toEqual({ reason: "length", native: "max_output_tokens" });
  });

  it("returns null for chunks that carry no termination evidence", () => {
    expect(parseFinishReason(null)).toBeNull();
    expect(parseFinishReason({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] })).toBeNull();
    expect(parseFinishReason({ choices: [] })).toBeNull();
  });
});

describe("stream.js — finish reason reaches onStreamComplete", () => {
  it("passthrough stream reports the final finish_reason", async () => {
    const calls = [];
    const transform = createPassthroughStreamWithLogger(
      "openai", null, "m", null, null,
      (contentObj, usage) => calls.push({ contentObj, usage })
    );

    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ id: "1", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }));
        controller.enqueue(sse({ id: "1", choices: [{ index: 0, delta: {}, finish_reason: "length" }] }));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    await drain(upstream.pipeThrough(transform));

    expect(calls.length).toBe(1);
    expect(calls[0].contentObj.content).toBe("hi");
    expect(calls[0].contentObj.finishReason).toBe("length");
  });

  it("translated stream (claude upstream → openai client) reports the mapped reason", async () => {
    const calls = [];
    const events = [
      { type: "message_start", message: { id: "m", model: "claude", role: "assistant", content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    const transform = createSSETransformStreamWithLogger(
      FORMATS.CLAUDE, FORMATS.OPENAI, "anthropic", null, null, "claude-x", null, null,
      (contentObj) => calls.push(contentObj)
    );

    const upstream = new ReadableStream({
      start(controller) {
        for (const ev of events) controller.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
        controller.close();
      },
    });

    await drain(upstream.pipeThrough(transform));

    expect(calls.length).toBe(1);
    expect(calls[0].finishReason).toBe("tool_calls");
    // Native upstream token is preserved for the drawer to display.
    expect(calls[0].nativeFinishReason).toBe("tool_use");
  });
});

describe("streamingHandler — persists response.finish_reason", () => {
  it("writes the stop reason on the final detail row", async () => {
    saveRequestDetail.mockClear();

    const upstreamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(sse({ id: "1", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] }));
        controller.enqueue(sse({ id: "1", choices: [{ index: 0, delta: {}, finish_reason: "length" }] }));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const providerResponse = new Response(upstreamBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const ctx = {
      provider: "openai",
      model: "gpt-test",
      connectionId: null,
      apiKey: null,
      requestStartTime: Date.now(),
      body: { model: "gpt-test", stream: true, messages: [] },
      stream: true,
      requestStartTime: Date.now(),
    };
    // The real persistence callback the handler uses (streamingHandler's own
    // buildOnStreamComplete), not a stub — this is what writes the row.
    const { onStreamComplete, streamDetailId } = buildOnStreamComplete(ctx);

    const result = await handleStreamingResponse({
      ...ctx,
      providerResponse,
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      onStreamComplete,
      streamDetailId,
      streamController: {
        signal: new AbortController().signal,
        isConnected: () => true,
        handleComplete: () => {},
        handleError: () => {},
        handleDisconnect: () => {},
        abort: () => {},
      },
    });

    expect(result.success).toBe(true);
    await drain(result.response.body);

    const rows = saveRequestDetail.mock.calls.map(([row]) => row);
    // First write is the "[Streaming in progress...]" placeholder, last is the
    // completed row with real content — it must carry the stop reason.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const final = rows.at(-1);
    expect(final.id).toBe(streamDetailId);
    expect(final.response.finish_reason).toBe("length");
    expect(final.response.content).toBe("hello");
  });
});
