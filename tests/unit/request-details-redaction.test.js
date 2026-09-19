import { describe, it, expect } from "vitest";
import { redactDetails, redactPayload } from "../../src/lib/security/redactPayload.js";

describe("redactPayload", () => {
  it("keeps conversation content instead of blanking the payload", () => {
    const out = redactPayload({ messages: [{ role: "user", content: "hello world" }] });
    expect(out).toEqual({ messages: [{ role: "user", content: "hello world" }] });
  });

  it("masks a Bearer token", () => {
    const out = redactPayload({ headers: { Authorization: "Bearer sk-abcdefgh12345678" } });
    expect(out.headers.Authorization).toBe("Bearer [redacted]");
  });

  it("masks api_key / apiKey / authorization field values", () => {
    expect(redactPayload({ api_key: "sk-live-1234567890" }).api_key).toBe("[redacted]");
    expect(redactPayload({ apiKey: "sk-live-1234567890" }).apiKey).toBe("[redacted]");
    expect(redactPayload({ authorization: "Basic dXNlcjpwYXNz" }).authorization).toBe("[redacted]");
  });

  it("masks nested secrets at any depth", () => {
    const out = redactPayload({
      a: { b: [{ c: { apiKey: "sk-deep-secret-1234" } }] },
      list: [{ headers: { authorization: "Bearer tok-abcdefgh" } }],
    });
    expect(out.a.b[0].c.apiKey).toBe("[redacted]");
    expect(out.list[0].headers.authorization).toBe("Bearer [redacted]");
  });

  it("masks x-api-key and cookie-style header names", () => {
    expect(redactPayload({ "x-api-key": "sk-abcdefgh12345" })["x-api-key"]).toBe("[redacted]");
    expect(redactPayload({ Cookie: "session=abcdefgh12345678" }).Cookie).toBe("[redacted]");
  });

  it("leaves non-sensitive keys alone even when names look similar", () => {
    const out = redactPayload({ model: "gpt-5", max_tokens: 100, apiKeyCount: 3, keys: ["a"] });
    expect(out).toEqual({ model: "gpt-5", max_tokens: 100, apiKeyCount: 3, keys: ["a"] });
  });

  it("passes through primitives and null/undefined unchanged", () => {
    expect(redactPayload("plain string with sk-looking text")).toBe("plain string with sk-looking text");
    expect(redactPayload(null)).toBeNull();
    expect(redactPayload(undefined)).toBeUndefined();
    expect(redactPayload(42)).toBe(42);
  });

  it("does not mutate the input object", () => {
    const input = { apiKey: "sk-secret-12345678", nested: { authorization: "Bearer tok-abcdefgh" } };
    redactPayload(input);
    expect(input.apiKey).toBe("sk-secret-12345678");
    expect(input.nested.authorization).toBe("Bearer tok-abcdefgh");
  });

  it("masks Bearer tokens appearing inside string content", () => {
    const out = redactPayload({ error: "upstream said Bearer sk-abcdefgh12345678 is bad" });
    expect(out.error).toBe("upstream said Bearer [redacted] is bad");
  });
});

describe("redactDetails", () => {
  it("keeps metadata and conversation payloads, masking only credentials", () => {
    const details = [{
      id: "abc",
      provider: "opencode",
      model: "deepseek-v4-flash-free",
      timestamp: "2026-08-05T00:00:00Z",
      status: "success",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      request: { messages: [{ role: "user", content: "secret prompt" }], apiKey: "sk-live-1234567890" },
      providerRequest: { messages: [{ role: "user", content: "secret prompt" }] },
      providerResponse: { choices: [{ message: { content: "secret answer" } }] },
      response: { content: "secret answer" },
    }];
    const out = redactDetails(details)[0];

    // metadata untouched
    expect(out.id).toBe("abc");
    expect(out.provider).toBe("opencode");
    expect(out.model).toBe("deepseek-v4-flash-free");
    expect(out.tokens).toEqual({ prompt_tokens: 10, completion_tokens: 5 });

    // conversation content now visible
    expect(out.request.messages[0].content).toBe("secret prompt");
    expect(out.providerResponse.choices[0].message.content).toBe("secret answer");
    expect(out.response.content).toBe("secret answer");

    // credentials still masked
    expect(out.request.apiKey).toBe("[redacted]");
  });

  it("keeps response.error visible so upstream failures stay diagnosable", () => {
    const details = [{ id: "x", response: { error: { message: "fetch connect timeout" } } }];
    const out = redactDetails(details)[0];
    expect(out.response.error.message).toBe("fetch connect timeout");
  });

  it("handles empty and null details", () => {
    expect(redactDetails([])).toEqual([]);
    expect(redactDetails(null)).toEqual([]);
    expect(redactDetails(undefined)).toEqual([]);
  });

  it("keeps non-sensitive fields untouched", () => {
    const details = [{ id: "x", status: "error", latency: { total: 100 } }];
    const out = redactDetails(details)[0];
    expect(out.id).toBe("x");
    expect(out.status).toBe("error");
    expect(out.latency).toEqual({ total: 100 });
  });

  it("does not mutate the source rows", () => {
    const details = [{ id: "x", request: { apiKey: "sk-live-1234567890" } }];
    redactDetails(details);
    expect(details[0].request.apiKey).toBe("sk-live-1234567890");
  });
});
