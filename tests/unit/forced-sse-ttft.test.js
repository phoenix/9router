// handleForcedSSEToJson is the handler for "client asked for one JSON document,
// upstream was forced to stream" (providerRequiresStreaming, or a json_object
// request promoted to streaming). It drains the whole SSE and re-assembles it.
//
// It used to write `latency: { ttft: totalLatency, total: totalLatency }` — the
// same number in both fields — because it had no way to observe the first chunk:
// only createSSEStream stamps ttftAt, and that stream is never built on this
// path. So every forced-stream request was recorded with TTFT == Total and the
// dashboard could not tell a cold prefill from an instant start.
//
// config/jsonObjectStreaming.js promises this path gets "a real TTFT plus the
// stall guard". These tests hold it to that.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { handleForcedSSEToJson } = await import(
  "../../open-sse/handlers/chatCore/sseToJsonHandler.js"
);
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { saveRequestDetail } = await import("@/lib/usageDb.js");

const OPENAI_CHUNKS = [
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
  "data: [DONE]"
];

const RESPONSES_EVENTS = [
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Hi"}]}],"usage":{"input_tokens":2,"output_tokens":1}}}'
];

/**
 * Build a Response whose chunks are released on a schedule the test controls.
 *
 * `timeline[i]` is the wall-clock "time" at which chunk i ARRIVES — not the
 * request start. The clock is advanced before the chunk is enqueued, so the
 * handler samples that chunk's arrival time when its read resolves.
 *
 * Note a ReadableStream calls pull() once speculatively at construction, so
 * chunk 0 exists before the handler reads anything; timeline[0] must therefore
 * be the first byte's real arrival time or TTFT collapses to 0.
 */
function scheduledSSE(chunks, timeline, clock) {
  const encoder = new TextEncoder();
  let i = 0;
  const pulled = [];
  const body = new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) return controller.close();
      pulled.push(i);
      clock.set(timeline[i] ?? timeline[timeline.length - 1] ?? 0);
      controller.enqueue(encoder.encode(chunks[i] + "\n\n"));
      i++;
    }
  });
  return { body, pulled, headers: { "content-type": "text/event-stream" } };
}

/** A clock the test drives by hand; the handler reads it via `now`. */
function fakeClock() {
  let now = 1_000_000;
  const clock = {
    now: () => now,
    set: (t) => { now = t; },
    advance: (ms) => { now += ms; return now; }
  };
  return clock;
}

/**
 * Default provider for the standard Chat-Completions-SSE tests.
 *
 * Must NOT be a Responses-API provider (codex/openai): handlers branch on
 * isResponsesProvider(provider) and would route these OpenAI chunks through the
 * Responses converter. `opencode` is forceStream with a chat-completions
 * upstream, which is exactly the "forced streaming, JSON client" case.
 */
function callHandler({ providerResponse, requestStartTime, provider = "opencode", ...rest }) {
  return handleForcedSSEToJson({
    providerResponse,
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI,
    provider,
    model: "gpt-5",
    body: { model: "gpt-5", messages: [] },
    stream: false,
    requestStartTime,
    connectionId: "test-connection",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    ...rest
  });
}

/** The latency the handler actually recorded (last saved detail wins). */
function recordedLatency() {
  const calls = saveRequestDetail.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0].latency;
}

describe("forced SSE→JSON records a real TTFT", () => {
  beforeEach(() => {
    saveRequestDetail.mockClear();
    delete process.env.STREAM_STALL_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("separates a fast first chunk from a slow generation", async () => {
    // Request starts at t=1000. First chunk ARRIVES at t=1150 (TTFT 150ms); the
    // stream finishes at t=3150 (total 2150ms). Old behaviour wrote 2150 for both.
    const clock = fakeClock();
    const sse = scheduledSSE(OPENAI_CHUNKS, [1150, 1200, 3100, 3150], clock);

    const result = await callHandler({
      providerResponse: new Response(sse.body, { headers: sse.headers }),
      requestStartTime: 1000,
      now: clock.now
    });
    expect(result.success).toBe(true);

    const { ttft, total } = recordedLatency();
    expect(ttft).toBe(150);
    expect(total).toBe(2150);
    expect(ttft).not.toBe(total);
  });

  it("records TTFT of the first byte, not of the first content delta", async () => {
    // A provider that opens with a role-only chunk: the first byte is what the
    // upstream made us wait for, so that is the TTFT.
    const clock = fakeClock();
    const chunks = [
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      ...OPENAI_CHUNKS.slice(1)
    ];
    const sse = scheduledSSE(chunks, [1500, 1600, 3000, 3000], clock);

    await callHandler({
      providerResponse: new Response(sse.body, { headers: sse.headers }),
      requestStartTime: 1000,
      now: clock.now
    });

    const { ttft, total } = recordedLatency();
    expect(ttft).toBe(500);
    expect(total).toBe(2000);
  });

  it("still re-assembles the SSE into one document for the client", async () => {
    const clock = fakeClock();
    const sse = scheduledSSE(OPENAI_CHUNKS, [1100, 1150, 1200, 1300], clock);

    const result = await callHandler({
      providerResponse: new Response(sse.body, { headers: sse.headers }),
      requestStartTime: 1000,
      now: clock.now
    });

    const json = await result.response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("Hello");
    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 2 });
  });

  it("records a real TTFT on the Responses-API path too", async () => {
    const clock = fakeClock();
    const sse = scheduledSSE(RESPONSES_EVENTS, [1400, 1500], clock);

    const result = await callHandler({
      provider: "codex",
      providerResponse: new Response(sse.body, { headers: sse.headers }),
      requestStartTime: 1000,
      now: clock.now
    });

    expect(result.success).toBe(true);
    const { ttft, total } = recordedLatency();
    expect(ttft).toBe(400);
    expect(total).toBe(500);
  });

  it("falls back to the full duration when no timing was observable", async () => {
    // A plain-string Response has no readable body to drain, so the handler
    // cannot stamp a first byte. It must not then invent a TTFT of 0 — an
    // unmeasurable request keeps the conservative old value (ttft == total).
    // The two are sampled a hair apart, so allow a small real-time drift.
    const result = await callHandler({
      providerResponse: new Response(OPENAI_CHUNKS.join("\n\n"), {
        headers: { "content-type": "text/event-stream" }
      }),
      requestStartTime: Date.now() - 50
    });

    expect(result.success).toBe(true);
    const { ttft, total } = recordedLatency();
    expect(total).toBeGreaterThanOrEqual(50);
    expect(Math.abs(ttft - total)).toBeLessThanOrEqual(5);
  });
});

describe("forced SSE→JSON stall guard", () => {
  beforeEach(() => {
    saveRequestDetail.mockClear();
  });

  afterEach(() => {
    delete process.env.STREAM_STALL_TIMEOUT_MS;
    vi.restoreAllMocks();
  });

  it("gives up when the upstream sends a chunk and then goes silent", async () => {
    // One chunk arrives (so this is not a header timeout), then the upstream
    // hangs forever. providerResponse.text() has no timeout of its own, so the
    // old code hung here until some outer deadline.
    const encoder = new TextEncoder();
    let i = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (i === 0) {
          i++;
          controller.enqueue(encoder.encode(OPENAI_CHUNKS[0] + "\n\n"));
          return;
        }
        return new Promise(() => {}); // never resolves: upstream is wedged
      }
    });

    const started = Date.now();
    const result = await callHandler({
      providerResponse: new Response(body, { headers: { "content-type": "text/event-stream" } }),
      requestStartTime: started,
      stallTimeoutMs: 100,
      timeoutMs: 100
    });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5_000);
    expect(result.success).toBe(false);
    expect(result.response.status).toBeGreaterThanOrEqual(500);
  });

  it("does not abort a slow but progressing stream", async () => {
    const encoder = new TextEncoder();
    let i = 0;
    // 4 chunks, 30ms apart in real time, well inside the 300ms stall window.
    const slow = new Response(new ReadableStream({
      async pull(controller) {
        if (i >= OPENAI_CHUNKS.length) return controller.close();
        await new Promise((r) => setTimeout(r, 30));
        controller.enqueue(encoder.encode(OPENAI_CHUNKS[i] + "\n\n"));
        i++;
      }
    }), { headers: { "content-type": "text/event-stream" } });

    const result = await callHandler({
      providerResponse: slow,
      requestStartTime: Date.now(),
      stallTimeoutMs: 300,
      timeoutMs: 300
    });

    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("Hello");
  });
});
