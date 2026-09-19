// The usage object must be requested on streaming OpenAI-shaped requests;
// without it the final chunk is a bare [DONE] and token accounting records zero.
// Verified live against nvidia: with stream_options.include_usage the trailing
// chunk carries usage, without it the stream just ends.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { BaseExecutor } = await import("../../open-sse/executors/base.js");

function res(status = 200) {
  return { status, headers: { get: () => "text/event-stream" } };
}

/** Capture the body the executor actually serialised onto the wire. */
function sentBody() {
  const call = fetchMock.mock.calls.at(-1);
  return JSON.parse(call[1].body);
}

const creds = { apiKey: "k" };

beforeEach(() => fetchMock.mockReset());

describe("streaming requests ask the upstream for usage", () => {
  it("injects stream_options.include_usage on an OpenAI-shaped stream", async () => {
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api" });
    fetchMock.mockResolvedValue(res());
    await ex.execute({
      model: "m", stream: true, credentials: creds,
      body: { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] },
    });
    expect(sentBody().stream_options).toEqual({ include_usage: true });
  });

  it("does not inject on a non-streaming request", async () => {
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api" });
    fetchMock.mockResolvedValue(res());
    await ex.execute({
      model: "m", stream: false, credentials: creds,
      body: { model: "m", stream: false, messages: [{ role: "user", content: "hi" }] },
    });
    expect(sentBody().stream_options).toBeUndefined();
  });

  it("does not inject into a Claude-shaped body", async () => {
    // `stream_options` is an OpenAI-protocol field; strict Claude upstreams
    // reject unknown top-level params.
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api" });
    fetchMock.mockResolvedValue(res());
    await ex.execute({
      model: "m", stream: true, credentials: creds,
      body: { model: "m", stream: true, system: "be brief", messages: [{ role: "user", content: "hi" }] },
    });
    expect(sentBody().stream_options).toBeUndefined();
  });

  it("does not inject when the body is not OpenAI-shaped", async () => {
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api" });
    fetchMock.mockResolvedValue(res());
    await ex.execute({
      model: "m", stream: true, credentials: creds,
      body: { model: "m", stream: true, contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    });
    expect(sentBody().stream_options).toBeUndefined();
  });

  it("does not inject into a Responses API body (grok-cli / codex shape)", async () => {
    // grok-cli force-deletes stream_options then enforces a Responses-API
    // allowlist. Its body has `input`, not `messages`, so the guard must skip it
    // — otherwise the injection would re-add a field its own filter just dropped.
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api" });
    fetchMock.mockResolvedValue(res());
    await ex.execute({
      model: "m", stream: true, credentials: creds,
      body: {
        model: "m", stream: true, instructions: "be brief",
        input: [{ role: "user", content: "hi" }], max_output_tokens: 10,
      },
    });
    expect(sentBody().stream_options).toBeUndefined();
    expect(sentBody().input).toBeDefined();
  });

  it("preserves an existing include_usage flag and other options", async () => {
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api" });
    fetchMock.mockResolvedValue(res());
    await ex.execute({
      model: "m", stream: true, credentials: creds,
      body: {
        model: "m", stream: true, messages: [{ role: "user", content: "hi" }],
        stream_options: { include_usage: true, other: 1 },
      },
    });
    expect(sentBody().stream_options).toEqual({ include_usage: true, other: 1 });
  });

  it("adds include_usage alongside other existing options", async () => {
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api" });
    fetchMock.mockResolvedValue(res());
    await ex.execute({
      model: "m", stream: true, credentials: creds,
      body: {
        model: "m", stream: true, messages: [{ role: "user", content: "hi" }],
        stream_options: { other: 1 },
      },
    });
    expect(sentBody().stream_options).toEqual({ other: 1, include_usage: true });
  });
});
