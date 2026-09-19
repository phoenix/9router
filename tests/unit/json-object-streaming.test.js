import { describe, it, expect } from "vitest";
import {
  shouldStreamJsonObjectRequest,
  applyStreamingForJsonObject,
  wantsJsonObject,
  isDynamicOpenAICompatible,
} from "../../open-sse/config/jsonObjectStreaming.js";
// The client contract is "one complete JSON document". This is the piece that
// turns the upstream SSE back into that document, so it is asserted against the
// exact chunk shape a real nvidia stream produces (captured live:
// reasoning_content first, content in pieces, then a usage-only chunk + [DONE]).
import { parseSSEToOpenAIResponse } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";

const jsonBody = () => ({
  model: "nvidia/nemotron-3-super-120b-a12b",
  stream: false,
  response_format: { type: "json_object" },
  messages: [{ role: "user", content: "extract facts as json" }],
});

describe("wantsJsonObject", () => {
  it("true only for json_object", () => {
    expect(wantsJsonObject({ response_format: { type: "json_object" } })).toBe(true);
    expect(wantsJsonObject({ response_format: { type: "json_schema" } })).toBe(false);
    expect(wantsJsonObject({ response_format: { type: "text" } })).toBe(false);
    expect(wantsJsonObject({})).toBe(false);
    expect(wantsJsonObject(null)).toBe(false);
  });
});

describe("isDynamicOpenAICompatible", () => {
  it("matches the dynamic custom-provider id shape", () => {
    expect(isDynamicOpenAICompatible("openai-compatible-chat-abc123")).toBe(true);
    expect(isDynamicOpenAICompatible("openai-compatible-responses-x")).toBe(true);
    expect(isDynamicOpenAICompatible("nvidia")).toBe(false);
    expect(isDynamicOpenAICompatible("anthropic-compatible-x")).toBe(false);
    expect(isDynamicOpenAICompatible(null)).toBe(false);
  });
});

describe("shouldStreamJsonObjectRequest", () => {
  it("promotes a non-streaming json_object request for a verified provider", () => {
    expect(shouldStreamJsonObjectRequest({ body: jsonBody(), stream: false, provider: "nvidia" })).toBe(true);
  });

  it("promotes a non-streaming json_object request for a custom upstream", () => {
    expect(
      shouldStreamJsonObjectRequest({ body: jsonBody(), stream: false, provider: "openai-compatible-chat-abc" })
    ).toBe(true);
  });

  it("promotes for openrouter", () => {
    expect(shouldStreamJsonObjectRequest({ body: jsonBody(), stream: false, provider: "openrouter" })).toBe(true);
  });

  it("does not promote opencode — it is already forceStream, so the existing path handles it", () => {
    // opencode declares transport.forceStream = true, which sets `stream` true
    // before this check. Returning false here is correct: there is nothing to
    // promote, and its json_object responses already route through
    // handleForcedSSEToJson via providerRequiresStreaming.
    expect(shouldStreamJsonObjectRequest({ body: jsonBody(), stream: true, provider: "opencode" })).toBe(false);
  });

  it("leaves a client-requested stream alone (no promotion, no stream_options)", () => {
    const body = { ...jsonBody(), stream: true };
    expect(shouldStreamJsonObjectRequest({ body, stream: true, provider: "nvidia" })).toBe(false);
  });

  it("does not touch non-json_object requests", () => {
    const body = { ...jsonBody(), response_format: undefined };
    expect(shouldStreamJsonObjectRequest({ body, stream: false, provider: "nvidia" })).toBe(false);
    const schemaBody = { ...jsonBody(), response_format: { type: "json_schema" } };
    expect(shouldStreamJsonObjectRequest({ body: schemaBody, stream: false, provider: "nvidia" })).toBe(false);
  });

  it("never promotes an image-generation model", () => {
    // Image generation is required to be non-streaming; promote must skip it
    // even when the client asked for json_object.
    expect(
      shouldStreamJsonObjectRequest({ body: jsonBody(), stream: false, provider: "nvidia", isImageGenModel: true })
    ).toBe(false);
  });

  it("does not promote an unverified provider yet", () => {
    expect(shouldStreamJsonObjectRequest({ body: jsonBody(), stream: false, provider: "some-other-api" })).toBe(false);
  });
});

describe("applyStreamingForJsonObject", () => {
  it("sets stream true and requests usage", () => {
    const out = applyStreamingForJsonObject(jsonBody());
    expect(out.stream).toBe(true);
    // Without include_usage the upstream drops the usage object entirely
    // (verified against nvidia: final chunk is a bare [DONE]).
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  it("preserves existing stream_options keys while forcing include_usage", () => {
    const body = { ...jsonBody(), stream_options: { some_future_flag: 1 } };
    const out = applyStreamingForJsonObject(body);
    expect(out.stream_options).toEqual({ some_future_flag: 1, include_usage: true });
  });

  it("preserves the rest of the body and does not mutate the input", () => {
    const body = jsonBody();
    const out = applyStreamingForJsonObject(body);
    expect(out.response_format).toEqual({ type: "json_object" });
    expect(out.messages).toHaveLength(1);
    expect(body.stream).toBe(false);
    expect(body.stream_options).toBeUndefined();
  });

  it("ignores a non-object stream_options instead of spreading garbage", () => {
    const out = applyStreamingForJsonObject({ ...jsonBody(), stream_options: "nope" });
    expect(out.stream_options).toEqual({ include_usage: true });
  });
});

describe("promoted request still yields one complete JSON document", () => {
  // Chunk shape captured from a live nvidia stream (stream:true +
  // response_format:json_object + stream_options.include_usage).
  const chunk = (choices, usage = null) =>
    "data: " + JSON.stringify({
      id: "chatcmpl-1", choices, created: 1789796389,
      model: "nvidia/nemotron-3-super-120b-a12b",
      object: "chat.completion.chunk", usage,
    });

  const liveSse = [
    chunk([{ index: 0, delta: { role: "assistant", reasoning_content: "User wants" }, finish_reason: null }]),
    chunk([{ index: 0, delta: { content: '{"name": ' }, finish_reason: null }]),
    chunk([{ index: 0, delta: { content: '"Zhang San", "age": 30}' }, finish_reason: "stop" }]),
    chunk([], { prompt_tokens: 36, completion_tokens: 53, total_tokens: 89 }),
    "data: [DONE]",
  ].join("\n\n");

  it("reassembles content into parseable JSON", () => {
    const r = parseSSEToOpenAIResponse(liveSse, "nvidia/nemotron-3-super-120b-a12b");
    const parsed = JSON.parse(r.choices[0].message.content);
    expect(parsed).toEqual({ name: "Zhang San", age: 30 });
    expect(r.choices[0].finish_reason).toBe("stop");
  });

  it("keeps reasoning separate from content", () => {
    const r = parseSSEToOpenAIResponse(liveSse, "m");
    expect(r.choices[0].message.reasoning_content).toBe("User wants");
    expect(r.choices[0].message.content.startsWith("{")).toBe(true);
  });

  it("preserves usage from the trailing usage-only chunk", () => {
    // Regression guard: without include_usage the trailing chunk is a bare
    // [DONE] and this comes back undefined, silently zeroing token stats.
    const r = parseSSEToOpenAIResponse(liveSse, "m");
    expect(r.usage).toEqual({ prompt_tokens: 36, completion_tokens: 53, total_tokens: 89 });
  });

  it("drops usage when the upstream did not include it (documents the include_usage requirement)", () => {
    const withoutUsage = liveSse.replace(/data: \{"id":"chatcmpl-1","choices":\[\],.*?\n\n/, "");
    const r = parseSSEToOpenAIResponse(withoutUsage, "m");
    expect(r.usage).toBeUndefined();
  });
});
