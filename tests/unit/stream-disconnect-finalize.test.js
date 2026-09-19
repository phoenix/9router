// Regression: a client that hangs up mid-stream must NOT leave the request-details
// row stuck on the "[Streaming in progress...]" placeholder with zero tokens.
//
// streamingHandler writes a placeholder row immediately (status "success", tokens 0)
// and relies on the transform stream's flush() -> finalizeStream() -> onStreamComplete
// to overwrite it with the real content/usage. flush() never runs when a piped stream
// is cancelled, so a client disconnect used to skip finalization entirely. Observed
// live: 17% of requestDetails rows on the ai server, all status:"success", all
// provider "opencode", all tokens 0.
import { describe, expect, it } from "vitest";

import { createDisconnectAwareStream, pipeWithDisconnect, createStreamController } from "../../open-sse/utils/streamHandler.js";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

const enc = new TextEncoder();

/** OpenAI-shaped passthrough upstream that emits one content chunk + usage, then ends. */
function openAISSE({ content = "hello", usage = { prompt_tokens: 11, completion_tokens: 22 } } = {}) {
  const chunk = (obj) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(chunk({
        id: "1", object: "chat.completion.chunk", created: 0, model: "m",
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      }));
      controller.enqueue(chunk({
        id: "1", object: "chat.completion.chunk", created: 0, model: "m",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage,
      }));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function makeController() {
  let live = true;
  return {
    signal: new AbortController().signal,
    startTime: Date.now(),
    isConnected: () => live,
    handleComplete: () => { live = false; },
    handleError: () => { live = false; },
    handleDisconnect: () => { live = false; },
    abort: () => { live = false; },
    _setConnected: (v) => { live = v; },
  };
}

async function readAll(stream) {
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

describe("streaming finalize on client disconnect", () => {
  it("still emits the real content + usage when the client hangs up mid-stream", async () => {
    const calls = [];
    const transform = createPassthroughStreamWithLogger(
      "openai", null, "m", null, null,
      (contentObj, usage) => calls.push({ contentObj, usage })
    );

    // Upstream: one chunk arrives, then the client disconnects before the rest.
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(
          `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })}\n\n`
        ));
        // never closes — client went away
      },
    });

    const ctrl = makeController();
    const out = pipeWithDisconnect({ body: upstream }, transform, ctrl, null, 60_000);

    // Read one chunk, then hang up like a client closing the tab.
    const reader = out.getReader();
    await reader.read();

    ctrl._setConnected(false);
    await reader.cancel("client_closed").catch(() => {});

    await new Promise((r) => setTimeout(r, 50));

    expect(calls.length, "onStreamComplete must fire even when the client disconnects").toBeGreaterThan(0);

    const { contentObj, usage } = calls.at(-1);
    expect(contentObj.content).toBe("partial");
    expect(usage?.prompt_tokens ?? usage?.input_tokens).toBeGreaterThan(0);
  });

  it("captures usage on a normal, fully-drained stream (control case)", async () => {
    const calls = [];
    const transform = createPassthroughStreamWithLogger(
      "openai", null, "m", null, null,
      (contentObj, usage) => calls.push({ contentObj, usage })
    );

    const ctrl = createStreamController({ provider: "openai", model: "m" });
    const out = pipeWithDisconnect({ body: openAISSE() }, transform, ctrl, null, 60_000);

    const text = await readAll(out);
    expect(text).toContain("hello");
    expect(text).toContain("[DONE]");

    expect(calls.length).toBe(1);
    expect(calls[0].contentObj.content).toBe("hello");
    expect(calls[0].usage.prompt_tokens).toBe(11);
    expect(calls[0].usage.completion_tokens).toBe(22);
  });
});
