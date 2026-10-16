import { describe, it, expect } from "vitest";
import { judgeSseBuffer, judgeSseFinal, peekSseEmptySeat } from "../../open-sse/services/comboSsePeek.js";

const sse = (...frames) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");

function sseResponse(frames, { delayMs = 0 } = {}) {
  const text = typeof frames === "string" ? frames : sse(...frames);
  const encoder = new TextEncoder();
  let controllerRef;
  const stream = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      if (delayMs > 0) {
        setTimeout(() => { controller.enqueue(encoder.encode(text)); controller.close(); }, delayMs);
      } else {
        controller.enqueue(encoder.encode(text));
        controller.close();
      }
    }
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function neverStream() {
  return new Response(new ReadableStream({ start() { /* never enqueue, never close */ } }), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

describe("judgeSseBuffer", () => {
  it("sees an OpenAI content delta as content", () => {
    expect(judgeSseBuffer(sse({ choices: [{ delta: { content: "hi" } }] }))).toBe("content");
  });

  it("never early-returns on reasoning-only deltas (weak signal; judged at end-of-stream)", () => {
    expect(judgeSseBuffer(sse({ choices: [{ delta: { tool_calls: [{ id: "t1" }] } }] }))).toBe("content");
    expect(judgeSseBuffer(sse({ choices: [{ delta: { reasoning_content: "hmm" } }] }))).toBe("unknown");
    // mixed delta keeps its strong signal: the answer next to reasoning wins
    expect(judgeSseBuffer(sse({ choices: [{ delta: { reasoning_content: "hmm", content: "answer" } }] }))).toBe("content");
    expect(judgeSseBuffer(sse({ choices: [{ delta: { reasoning: "hmm" } }] }))).toBe("unknown");
  });

  it("sees anthropic text / tool_use as content; thinking deltas do not early-return", () => {
    expect(judgeSseBuffer(sse({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }))).toBe("content");
    expect(judgeSseBuffer(sse({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } }))).toBe("unknown");
    expect(judgeSseBuffer(sse({ type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "f" } }))).toBe("content");
  });

  it("sees gemini text parts as content but finishReason-only frames as unknown", () => {
    expect(judgeSseBuffer(sse({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }))).toBe("content");
    expect(judgeSseBuffer(sse({ candidates: [{ finishReason: "STOP" }] }))).toBe("unknown");
    expect(judgeSseBuffer(sse({ usageMetadata: { totalTokenCount: 10 } }))).toBe("unknown");
  });

  it("sees responses-API text deltas as content; reasoning events do not early-return", () => {
    expect(judgeSseBuffer(sse({ type: "response.output_text.delta", delta: "hi" }))).toBe("content");
    expect(judgeSseBuffer(sse({ type: "response.reasoning_text.delta", delta: "hmm" }))).toBe("unknown");
    expect(judgeSseBuffer(sse({ type: "response.reasoning_summary_text.delta", delta: "hmm" }))).toBe("unknown");
  });

  it("flags error frames", () => {
    expect(judgeSseBuffer(sse({ error: { message: "boom" } }))).toBe("error");
    expect(judgeSseBuffer(sse({ type: "error", error: { message: "boom" } }))).toBe("error");
  });

  it("ignores keepalives, [DONE] and finish-only frames", () => {
    expect(judgeSseBuffer(": keepalive\n\n")).toBe("unknown");
    expect(judgeSseBuffer("data: [DONE]\n\n")).toBe("unknown");
    expect(judgeSseBuffer(sse({ choices: [{ delta: {}, finish_reason: "stop" }] }))).toBe("unknown");
  });

  it("waits on partial JSON instead of misjudging", () => {
    expect(judgeSseBuffer('data: {"choices":[{"de')).toBe("unknown");
  });

  it("does not mistake non-carrier strings for content (ids, roles)", () => {
    expect(judgeSseBuffer(sse({ id: "chatcmpl-x", choices: [{ delta: { role: "assistant" }, finish_reason: null }] }))).toBe("unknown");
  });
});

describe("judgeSseFinal", () => {
  it("empty buffer is empty", () => {
    expect(judgeSseFinal("")).toBe("empty");
    expect(judgeSseFinal("   \n\n")).toBe("empty");
  });

  it("a clean [DONE] with no content is empty", () => {
    expect(judgeSseFinal("data: [DONE]\n\n")).toBe("empty");
  });

  it("openai finish-only / anthropic message_stop / gemini finishReason-only streams are empty", () => {
    expect(judgeSseFinal(sse({ choices: [{ delta: {}, finish_reason: "stop" }] }))).toBe("empty");
    expect(judgeSseFinal(sse({ type: "message_stop" }))).toBe("empty");
    expect(judgeSseFinal(sse({ type: "message_delta", delta: { stop_reason: "end_turn" } }))).toBe("empty");
    expect(judgeSseFinal(sse({ candidates: [{ finishReason: "STOP" }], usageMetadata: {} }))).toBe("empty");
    expect(judgeSseFinal(sse({ type: "response.failed", response: { error: { message: "x" } } }))).toBe("error");
    expect(judgeSseFinal(sse({ done: true, eval_count: 0 }))).toBe("empty");
  });

  it("unparseable tail without terminal marker is fail-safe content", () => {
    expect(judgeSseFinal("data: {oops not json}\n\n")).toBe("content");
  });

  it("reasoning-only terminated stream is thought-only (answer dumped into thinking)", () => {
    expect(judgeSseFinal(
      sse({ choices: [{ delta: { reasoning_content: "let me think" } }] }) +
      sse({ choices: [{ delta: {}, finish_reason: "stop" }] })
    )).toBe("thought-only");
    expect(judgeSseFinal(
      sse({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } }) +
      sse({ type: "message_stop" })
    )).toBe("thought-only");
  });

  it("reasoning followed by real answer is content", () => {
    expect(judgeSseFinal(
      sse({ choices: [{ delta: { reasoning_content: "let me think" } }] }) +
      sse({ choices: [{ delta: { content: "final answer" } }] }) +
      sse({ choices: [{ delta: {}, finish_reason: "stop" }] })
    )).toBe("content");
  });

  it("late content before [DONE] is content", () => {
    expect(judgeSseFinal(sse({ choices: [{ delta: { content: "late" } }] }) + "data: [DONE]\n\n")).toBe("content");
  });
});

describe("peekSseEmptySeat", () => {
  it("returns the seat untouched when content arrives", async () => {
    const response = sseResponse([{ choices: [{ delta: { content: "hello" } }] }, "data: [DONE]\n\n"]);
    const peek = await peekSseEmptySeat(response, { timeoutMs: 1000 });
    expect(peek.empty).toBe(false);
    const text = await peek.response.text();
    expect(text).toContain("hello");
    expect(text).toContain("[DONE]");
  });

  it("preserves bytes exactly across the rewrap", async () => {
    const original = sseResponse([{ choices: [{ delta: { content: "abc" } }] }]);
    const expected = await original.clone().text();
    const peek = await peekSseEmptySeat(original, { timeoutMs: 1000 });
    expect(await peek.response.text()).toBe(expected);
  });

  it("judges a [DONE]-only stream empty", async () => {
    const peek = await peekSseEmptySeat(sseResponse("data: [DONE]\n\n"), { timeoutMs: 1000 });
    expect(peek.empty).toBe(true);
    expect(peek.reason).toBe("done-no-content");
  });

  it("judges a zero-delta finish-only stream empty (the reported symptom)", async () => {
    const peek = await peekSseEmptySeat(sseResponse([{ choices: [{ delta: {}, finish_reason: "stop" }] }]), { timeoutMs: 1000 });
    expect(peek.empty).toBe(true);
  });

  it("judges a gemini finishReason-only stream empty", async () => {
    const peek = await peekSseEmptySeat(sseResponse([{ candidates: [{ finishReason: "STOP" }] }]), { timeoutMs: 1000 });
    expect(peek.empty).toBe(true);
  });

  it("judges a reasoning-only terminated stream empty (thought-only)", async () => {
    const peek = await peekSseEmptySeat(
      sseResponse([
        { choices: [{ delta: { reasoning_content: "thinking..." } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
      { timeoutMs: 1000 }
    );
    expect(peek.empty).toBe(true);
    expect(peek.reason).toBe("thought-only");
  });

  it("passes through reasoning followed by real content", async () => {
    const peek = await peekSseEmptySeat(
      sseResponse([
        { choices: [{ delta: { reasoning_content: "thinking..." } }] },
        { choices: [{ delta: { content: "answer" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
      { timeoutMs: 1000 }
    );
    expect(peek.empty).toBe(false);
    expect(await peek.response.text()).toContain("answer");
  });

  it("waits out a slow first byte and still finds content", async () => {
    const peek = await peekSseEmptySeat(
      sseResponse([{ choices: [{ delta: { content: "slow" } }] }], { delayMs: 120 }),
      { timeoutMs: 5000 }
    );
    expect(peek.empty).toBe(false);
    expect(await peek.response.text()).toContain("slow");
  });

  it("falls back on a stream that never produces a byte within the window", async () => {
    const started = Date.now();
    const peek = await peekSseEmptySeat(neverStream(), { timeoutMs: 80 });
    expect(peek.empty).toBe(true);
    expect(peek.reason).toBe("timeout-no-data");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("falls back on an upstream error frame", async () => {
    const peek = await peekSseEmptySeat(sseResponse([{ error: { message: "overloaded" } }]), { timeoutMs: 1000 });
    expect(peek.empty).toBe(true);
    expect(peek.reason).toBe("error-frame");
  });

  it("is a no-op when the peek is disabled (timeoutMs 0)", async () => {
    const response = sseResponse("data: [DONE]\n\n");
    const peek = await peekSseEmptySeat(response, { timeoutMs: 0 });
    expect(peek.empty).toBe(false);
    expect(peek.response).toBe(response);
  });
});
