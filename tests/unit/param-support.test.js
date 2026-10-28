import { describe, it, expect } from "vitest";

import { stripUnsupportedParams } from "../../open-sse/translator/concerns/paramSupport.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

describe("stripUnsupportedParams", () => {
  it("flattens Cloudflare AI OpenAI content-part arrays", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello " },
            { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
            { type: "text", text: "world" },
          ],
        },
      ],
    };

    expect(() => stripUnsupportedParams("cloudflare-ai", "@cf/meta/llama-3.1-8b-instruct", body)).not.toThrow();
    expect(body.messages[0].content).toBe("hello world");
  });

  it("still drops unsupported GitHub model params", () => {
    const body = { temperature: 0.7, top_p: 1 };

    stripUnsupportedParams("github", "gpt-5.4", body);

    expect(body).toEqual({ top_p: 1 });
  });

  it("clamps VolcEngine Ark GLM max token fields to the model output ceiling", () => {
    const body = {
      max_tokens: 131072,
      max_completion_tokens: 131072,
      max_output_tokens: 131072,
    };

    stripUnsupportedParams("volcengine-ark", "GLM-5.2", body);

    expect(body).toEqual({
      max_tokens: 128000,
      max_completion_tokens: 128000,
      max_output_tokens: 128000,
    });
  });

  it("keeps VolcEngine Ark GLM max tokens when already under the ceiling", () => {
    const body = { max_tokens: 64000 };

    stripUnsupportedParams("volcengine-ark", "GLM-5.2", body);

    expect(body.max_tokens).toBe(64000);
  });

  it("drops replayed reasoning fields from assistant messages for strict providers", () => {
    const makeBody = () => ({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "hello",
          reasoning_content: "thinking...",
          reasoning: "thinking...",
          reasoning_details: [{ text: "thinking..." }],
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        { role: "user", content: "again", reasoning_content: "user-side field stays" },
      ],
    });

    for (const [provider, model] of [
      ["groq", "openai/gpt-oss-120b"],
      ["mistral", "codestral-latest"],
      ["cerebras", "gpt-oss-120b"],
    ]) {
      const body = makeBody();
      stripUnsupportedParams(provider, model, body);
      expect(body.messages[1]).toEqual({
        role: "assistant",
        content: "hello",
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
      });
      // only assistant turns are touched
      expect(body.messages[2].reasoning_content).toBe("user-side field stays");
    }
  });

  it("leaves reasoning fields alone for providers that accept or require them", () => {
    const body = {
      messages: [{ role: "assistant", content: "hello", reasoning_content: "thinking..." }],
    };

    stripUnsupportedParams("deepseek", "deepseek-reasoner", body);
    stripUnsupportedParams("openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free", body);

    expect(body.messages[0].reasoning_content).toBe("thinking...");
  });

  it("normalizes NVIDIA reasoning aliases before DeepSeek placeholder injection", () => {
    const body = {
      messages: [
        { role: "assistant", content: "", reasoning: "alias", reasoning_content: "canonical" },
        { role: "assistant", content: "", reasoning: "alias only" },
        { role: "assistant", content: "", reasoning_content: "canonical only" },
      ],
    };

    const transformed = new DefaultExecutor("nvidia").transformRequest(
      "deepseek-ai/deepseek-v4-pro",
      body,
      true,
      {},
    );

    expect(transformed.messages).toEqual([
      { role: "assistant", content: "", reasoning_content: "canonical" },
      { role: "assistant", content: "", reasoning_content: "alias only" },
      { role: "assistant", content: "", reasoning_content: "canonical only" },
    ]);
  });

  it("drops response_format for OpenCode Go's deepseek family (both json_schema and json_object)", () => {
    const formats = [
      { type: "json_schema", json_schema: { name: "session_title", strict: true, schema: { type: "object" } } },
      { type: "json_object" },
    ];

    for (const model of ["deepseek-v4.1-flash", "deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4-pro"]) {
      for (const response_format of formats) {
        const body = { messages: [{ role: "user", content: "hi" }], response_format };
        stripUnsupportedParams("opencode-go", model, body);
        expect(body.response_format).toBeUndefined();
        expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
      }
    }
  });

  it("keeps response_format for OpenCode Go models that serve it", () => {
    const response_format = { type: "json_schema", json_schema: { name: "t", schema: { type: "object" } } };

    for (const model of ["glm-5.3-flash", "glm-5.3", "kimi-k3", "mimo-v2.6-flash", "minimax-m3", "qwen3.8-flash", "grok-4.7", "muse-spark-1.3-contributor"]) {
      const body = { messages: [{ role: "user", content: "hi" }], response_format };
      stripUnsupportedParams("opencode-go", model, body);
      expect(body.response_format).toBe(response_format);
    }
  });

  it("leaves response_format alone for other providers fronting deepseek ids", () => {
    const response_format = { type: "json_schema", json_schema: { name: "t", schema: { type: "object" } } };

    for (const [provider, model] of [
      ["deepseek", "deepseek-reasoner"],
      ["opencode-zen", "deepseek-v4.1-flash"],
      ["openrouter", "deepseek/deepseek-v3.2"],
    ]) {
      const body = { messages: [{ role: "user", content: "hi" }], response_format };
      stripUnsupportedParams(provider, model, body);
      expect(body.response_format).toBe(response_format);
    }
  });

  it("renames max_tokens to max_completion_tokens for the openai provider", () => {
    const body = { max_tokens: 50, temperature: 1 };

    stripUnsupportedParams("openai", "gpt-6-luna", body);

    expect(body).toEqual({ max_completion_tokens: 50, temperature: 1 });
  });

  it("keeps an explicit max_completion_tokens when both are sent to openai", () => {
    const body = { max_tokens: 50, max_completion_tokens: 80 };

    stripUnsupportedParams("openai", "gpt-6-luna", body);

    expect(body).toEqual({ max_completion_tokens: 80 });
  });

  it("leaves max_tokens untouched for other providers", () => {
    const body = { max_tokens: 50 };

    stripUnsupportedParams("groq", "qwen/qwen3.6-27b", body);

    expect(body).toEqual({ max_tokens: 50 });
  });

  // ── reasoning alias dedupe (NVIDIA NIM strict serde) ────────────────────────
  // NVIDIA's /v1/chat/completions deserializes the body into a Rust struct where
  // `reasoning` and `reasoning_content` are serde aliases of the same field, so an
  // assistant turn carrying both 400s:
  //   "duplicate field `reasoning_content` at line 1 column 218817"
  // Clients (Hermes, various agents) replay both keys with identical text. Collapse
  // them to the canonical reasoning_content before the body goes upstream.
  const bothKeysBody = () => ({
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "ping", arguments: "{}" } }],
        reasoning_content: "same text",
        reasoning: "same text",
        reasoning_details: [{ text: "same text" }],
      },
      { role: "tool", tool_call_id: "call_1", content: "pong" },
    ],
  });

  it("collapses a duplicated reasoning alias on NVIDIA assistant turns (keeps reasoning_content)", () => {
    const body = bothKeysBody();

    stripUnsupportedParams("nvidia", "minimaxai/minimax-m3.1-flash", body);

    const assistant = body.messages[1];
    expect(assistant.reasoning_content).toBe("same text");
    expect(assistant.reasoning).toBeUndefined();
    expect(assistant.reasoning_details).toBeUndefined();
    // Only one reasoning key survives on the wire — that is what stops the 400.
    expect(JSON.stringify(assistant).match(/"reasoning/g)).toHaveLength(1);
  });

  it("promotes a lone reasoning alias to reasoning_content on NVIDIA (no thinking lost)", () => {
    const body = {
      messages: [{ role: "assistant", content: "answer", reasoning: "the chain" }],
    };

    stripUnsupportedParams("nvidia", "minimaxai/minimax-m3.1-flash", body);

    expect(body.messages[0].reasoning_content).toBe("the chain");
    expect(body.messages[0].reasoning).toBeUndefined();
  });

  it("flattens reasoning_details to reasoning_content on NVIDIA when no other reasoning key exists", () => {
    const body = {
      messages: [{ role: "assistant", content: "answer", reasoning_details: [{ text: "ab" }, { content: "c" }] }],
    };

    stripUnsupportedParams("nvidia", "minimaxai/minimax-m3.1-flash", body);

    expect(body.messages[0].reasoning_content).toBe("abc");
    expect(body.messages[0].reasoning_details).toBeUndefined();
  });

  it("leaves user turns and other providers untouched by the NVIDIA alias dedupe", () => {
    const userBody = { messages: [{ role: "user", content: "hi", reasoning: "x", reasoning_content: "x" }] };
    stripUnsupportedParams("nvidia", "minimaxai/minimax-m3.1-flash", userBody);
    expect(userBody.messages[0].reasoning).toBe("x");
    expect(userBody.messages[0].reasoning_content).toBe("x");

    const otherBody = bothKeysBody();
    stripUnsupportedParams("deepseek", "deepseek-reasoner", otherBody);
    expect(otherBody.messages[1].reasoning).toBe("same text");
  });

  it("DefaultExecutor.transformRequest emits a single reasoning key for NVIDIA", async () => {
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const executor = new DefaultExecutor("nvidia");
    const out = executor.transformRequest(
      "minimaxai/minimax-m3.1-flash",
      bothKeysBody(),
      true,
      { apiKey: "x" },
    );
    const assistant = out.messages.find((m) => m.role === "assistant");
    expect(JSON.stringify(assistant).match(/"reasoning/g)).toHaveLength(1);
    expect(assistant.reasoning_content).toBe("same text");
  });
});
