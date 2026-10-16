import { describe, it, expect } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";

// Regression: a provider that answers HTTP 200 with an EMPTY SSE stream
// (no content deltas — e.g. only a finish frame) was treated as "succeeded"
// by combo, so the empty 200 was returned to the client and no fallback ran.
// Symptom in logs: `COMBO Model nvidia/... succeeded` with `📊 DONE … IN 0 · OUT 0`.

const logStub = { info: () => {}, warn: () => {}, error: () => {} };

function okSse(frames) {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const EMPTY_FINISH_FRAME = {
  id: "chatcmpl-empty",
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
};

const CONTENT_DELTA_FRAME = {
  id: "chatcmpl-real",
  choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
};

const FINAL_CONTENT_FRAME = {
  id: "chatcmpl-real",
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
};

const TOOL_CALL_DELTA_FRAME = {
  id: "chatcmpl-tool",
  choices: [
    {
      index: 0,
      delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } }] },
      finish_reason: null,
    },
  ],
};

async function readText(response) {
  return response.text();
}

describe("combo: empty SSE 200 on a non-final seat falls through to the next model", () => {
  it("falls back when the first model returns an SSE stream with zero usable content", async () => {
    const calls = [];
    const handleSingleModel = async (_body, modelStr) => {
      calls.push(modelStr);
      if (modelStr === "prov/empty-one") {
        return okSse([EMPTY_FINISH_FRAME]);
      }
      return okSse([CONTENT_DELTA_FRAME, FINAL_CONTENT_FRAME]);
    };

    const response = await handleComboChat({
      body: { model: "my-combo", messages: [{ role: "user", content: "hi" }], stream: true },
      models: ["prov/empty-one", "prov/real-two"],
      handleSingleModel,
      log: logStub,
      comboName: "sse-empty-regression",
      comboStrategy: "fallback",
    });

    const text = await readText(response);
    expect(calls).toContain("prov/real-two");
    expect(text).toContain("hello");
  });

  it("falls back on a first seat that streams only [DONE] with no frames at all", async () => {
    const calls = [];
    const handleSingleModel = async (_body, modelStr) => {
      calls.push(modelStr);
      if (modelStr === "prov/empty-one") {
        return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return okSse([CONTENT_DELTA_FRAME, FINAL_CONTENT_FRAME]);
    };

    const response = await handleComboChat({
      body: { model: "my-combo", messages: [{ role: "user", content: "hi" }], stream: true },
      models: ["prov/empty-one", "prov/real-two"],
      handleSingleModel,
      log: logStub,
      comboName: "sse-bare-done",
      comboStrategy: "fallback",
    });

    const text = await readText(response);
    expect(calls).toContain("prov/real-two");
    expect(text).toContain("hello");
  });

  it("returns the first seat unchanged when its SSE stream has real content", async () => {
    const handleSingleModel = async () => okSse([CONTENT_DELTA_FRAME, FINAL_CONTENT_FRAME]);

    const response = await handleComboChat({
      body: { model: "my-combo", messages: [{ role: "user", content: "hi" }], stream: true },
      models: ["prov/real-one", "prov/real-two"],
      handleSingleModel,
      log: logStub,
      comboName: "sse-real-content",
      comboStrategy: "fallback",
    });

    const text = await readText(response);
    expect(text).toContain("hello");
    expect(text).not.toContain("second");
  });

  it("does not fall back when the empty-content stream carries tool_calls", async () => {
    const calls = [];
    const handleSingleModel = async (_body, modelStr) => {
      calls.push(modelStr);
      return okSse([TOOL_CALL_DELTA_FRAME, { ...EMPTY_FINISH_FRAME, id: "chatcmpl-tool" }]);
    };

    const response = await handleComboChat({
      body: { model: "my-combo", messages: [{ role: "user", content: "hi" }], stream: true },
      models: ["prov/tool-one", "prov/real-two"],
      handleSingleModel,
      log: logStub,
      comboName: "sse-tool-calls",
      comboStrategy: "fallback",
    });

    const text = await readText(response);
    expect(calls).toEqual(["prov/tool-one"]);
    expect(text).toContain("get_weather");
  });

  it("falls back when a seat dumps its whole output into reasoning (empty answer field)", async () => {
    const calls = [];
    const REASONING_FRAME = { id: "chatcmpl-think", choices: [{ index: 0, delta: { reasoning_content: "let me think..." }, finish_reason: null }] };
    const handleSingleModel = async (_body, modelStr) => {
      calls.push(modelStr);
      if (modelStr === "prov/thinker") {
        return okSse([REASONING_FRAME, { ...EMPTY_FINISH_FRAME, id: "chatcmpl-think" }]);
      }
      return okSse([CONTENT_DELTA_FRAME, FINAL_CONTENT_FRAME]);
    };

    const response = await handleComboChat({
      body: { model: "my-combo", messages: [{ role: "user", content: "hi" }], stream: true },
      models: ["prov/thinker", "prov/real-two"],
      handleSingleModel,
      log: logStub,
      comboName: "sse-thought-only",
      comboStrategy: "fallback",
    });

    const text = await readText(response);
    expect(calls).toContain("prov/real-two");
    expect(text).toContain("hello");
  });

  it("falls back when a seat's SSE stream opens with an upstream error frame", async () => {
    const calls = [];
    const handleSingleModel = async (_body, modelStr) => {
      calls.push(modelStr);
      if (modelStr === "prov/err-frame") {
        return okSse([{ error: { message: "overloaded" } }]);
      }
      return okSse([CONTENT_DELTA_FRAME, FINAL_CONTENT_FRAME]);
    };

    const response = await handleComboChat({
      body: { model: "my-combo", messages: [{ role: "user", content: "hi" }], stream: true },
      models: ["prov/err-frame", "prov/real-two"],
      handleSingleModel,
      log: logStub,
      comboName: "sse-error-frame",
      comboStrategy: "fallback",
    });

    const text = await readText(response);
    expect(calls).toContain("prov/real-two");
    expect(text).toContain("hello");
  });

  it("does not fall back when the first content byte arrives within the peek window", async () => {
    const handleSingleModel = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            setTimeout(() => {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(CONTENT_DELTA_FRAME)}\n\n`));
              controller.enqueue(enc.encode(`data: ${JSON.stringify(FINAL_CONTENT_FRAME)}\n\n`));
              controller.close();
            }, 120);
          }
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );

    const response = await handleComboChat({
      body: { model: "my-combo", messages: [{ role: "user", content: "hi" }], stream: true },
      models: ["prov/slow-start", "prov/real-two"],
      handleSingleModel,
      log: logStub,
      comboName: "sse-slow-first-byte",
      comboStrategy: "fallback",
    });

    const text = await readText(response);
    expect(text).toContain("hello");
  });

  it("returns 502 when the LAST seat's stream terminates with no answer content (no earlier seat left)", async () => {
    const calls = [];
    const handleSingleModel = async (_body, modelStr) => {
      calls.push(modelStr);
      return okSse([EMPTY_FINISH_FRAME]);
    };

    const response = await handleComboChat({
      body: { model: "my-combo", messages: [{ role: "user", content: "hi" }], stream: true },
      models: ["prov/empty-final"],
      handleSingleModel,
      log: logStub,
      comboName: "sse-last-seat-proven-dead",
      comboStrategy: "fallback",
    });

    expect(calls).toEqual(["prov/empty-final"]);
    expect(response.ok).toBe(false);
    expect(response.status).toBe(502);
    const payload = await response.json();
    expect(payload?.error?.message).toContain("empty response");
  });

  it("returns 502 for a single-model combo whose stream dumps everything into reasoning", async () => {
    const REASONING_FRAME = { id: "chatcmpl-think", choices: [{ index: 0, delta: { reasoning_content: "analysis..." }, finish_reason: null }] };
    const handleSingleModel = async () => okSse([REASONING_FRAME, { ...EMPTY_FINISH_FRAME, id: "chatcmpl-think" }]);

    const response = await handleComboChat({
      body: { model: "my-combo", messages: [{ role: "user", content: "hi" }], stream: true },
      models: ["prov/solo-thinker"],
      handleSingleModel,
      log: logStub,
      comboName: "sse-single-thought-only",
      comboStrategy: "fallback",
    });

    expect(response.status).toBe(502);
  });

  it("still returns the last seat's stream when reasoning is followed by real content", async () => {
    const REASONING_FRAME = { id: "chatcmpl-think", choices: [{ index: 0, delta: { reasoning_content: "thinking first" }, finish_reason: null }] };
    const handleSingleModel = async () => okSse([REASONING_FRAME, CONTENT_DELTA_FRAME, FINAL_CONTENT_FRAME]);

    const response = await handleComboChat({
      body: { model: "my-combo", messages: [{ role: "user", content: "hi" }], stream: true },
      models: ["prov/think-then-answer"],
      handleSingleModel,
      log: logStub,
      comboName: "sse-single-think-then-answer",
      comboStrategy: "fallback",
    });

    expect(response.ok).toBe(true);
    const text = await readText(response);
    expect(text).toContain("hello");
  });

  it("passes a silent last seat through unchanged after the peek window (slow prefill must not die)", async () => {
    const NEVER_SENDING_SEAT = new ReadableStream({ start(c) { /* never enqueues, never closes */ } });
    const handleSingleModel = async () =>
      new Response(NEVER_SENDING_SEAT, { status: 200, headers: { "content-type": "text/event-stream" } });

    const response = await handleComboChat({
      body: { model: "my-combo", messages: [{ role: "user", content: "hi" }], stream: true },
      models: ["prov/slow-last"],
      handleSingleModel,
      log: logStub,
      comboName: "sse-silent-last-seat",
      comboStrategy: "fallback",
      comboSsePeekTimeoutMs: 60,
    });

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
  });
});

describe("combo: non-streaming JSON zero-content responses", () => {
  const okJson = (payload) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });

  const REAL_MESSAGE = {
    id: "chatcmpl-real",
    choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  };
  const EMPTY_STOP = {
    id: "chatcmpl-empty",
    choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
  };
  const THOUGHT_ONLY = {
    id: "chatcmpl-think",
    choices: [{ index: 0, message: { role: "assistant", content: "", reasoning_content: "all the JSON went here" }, finish_reason: "stop" }],
  };

  it("falls back when a JSON seat answers with an empty content and a normal stop", async () => {
    const calls = [];
    const handleSingleModel = async (_body, modelStr) => {
      calls.push(modelStr);
      if (modelStr === "prov/empty-json") return okJson(EMPTY_STOP);
      return okJson(REAL_MESSAGE);
    };

    const response = await handleComboChat({
      body: { model: "my-combo", messages: [{ role: "user", content: "hi" }] },
      models: ["prov/empty-json", "prov/real-two"],
      handleSingleModel,
      log: logStub,
      comboName: "json-empty-stop",
      comboStrategy: "fallback",
    });

    expect(calls).toContain("prov/real-two");
    const payload = await response.json();
    expect(payload?.choices?.[0]?.message?.content).toContain("hello");
  });

  it("falls back when a JSON seat dumps its whole answer into reasoning_content", async () => {
    const calls = [];
    const handleSingleModel = async (_body, modelStr) => {
      calls.push(modelStr);
      if (modelStr === "prov/thinker-json") return okJson(THOUGHT_ONLY);
      return okJson(REAL_MESSAGE);
    };

    const response = await handleComboChat({
      body: { model: "my-combo", messages: [{ role: "user", content: "hi" }] },
      models: ["prov/thinker-json", "prov/real-two"],
      handleSingleModel,
      log: logStub,
      comboName: "json-thought-only",
      comboStrategy: "fallback",
    });

    expect(calls).toContain("prov/real-two");
  });

  it("keeps a JSON seat whose reasoning is followed by real content", async () => {
    const MIXED = {
      id: "chatcmpl-mixed",
      choices: [{ index: 0, message: { role: "assistant", content: "answer", reasoning_content: "think" }, finish_reason: "stop" }],
    };
    const handleSingleModel = async () => okJson(MIXED);

    const response = await handleComboChat({
      body: { model: "my-combo", messages: [{ role: "user", content: "hi" }] },
      models: ["prov/mixed-json"],
      handleSingleModel,
      log: logStub,
      comboName: "json-mixed",
      comboStrategy: "fallback",
    });

    expect(response.ok).toBe(true);
    const payload = await response.json();
    expect(payload?.choices?.[0]?.message?.content).toBe("answer");
  });

  it("returns 502 when the last JSON seat is empty with a normal stop", async () => {
    const handleSingleModel = async () => okJson(EMPTY_STOP);

    const response = await handleComboChat({
      body: { model: "my-combo", messages: [{ role: "user", content: "hi" }] },
      models: ["prov/empty-json-final"],
      handleSingleModel,
      log: logStub,
      comboName: "json-empty-last",
      comboStrategy: "fallback",
    });

    expect(response.status).toBe(502);
    const payload = await response.json();
    expect(payload?.error?.message).toContain("empty response");
  });
});
