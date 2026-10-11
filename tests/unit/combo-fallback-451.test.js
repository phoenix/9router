// Regression for the reported symptom: the `flash` combo stopped on its first
// member with
//   ✗ ERROR 451 · opencode/step-5-preview-free · URL: https://opencode.ai/zen/v1/chat/completions
//   ⚠️ [COMBO] Model oc/step-5-preview-free failed (no fallback) {"status":451}
// while four healthy members were still configured. The combo loop reused the
// account-scoped "don't cool down a credential for a request-scoped 4xx" guard,
// so a provider-scoped 451 (Endpoint is unavailable) was read as "the request is
// bad, stop". These tests exercise the loop itself, not just the predicate.
import { describe, expect, it, vi } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// The exact body opencode zen returned for this failure.
const ENDPOINT_UNAVAILABLE_451 = {
  error: { type: "server_error", message: "Upstream request failed: Endpoint is unavailable." },
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function okResponse(text = "hello") {
  return new Response(JSON.stringify({
    choices: [{ message: { role: "assistant", content: text } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("handleComboChat — a 451 on one member does not stop the combo", () => {
  it("falls through a 451 to the next configured member", async () => {
    const models = ["oc/step-5-preview-free", "oc/mimo-v2.6-flash-free"];
    const tried = [];
    const handleSingleModel = vi.fn(async (body, modelStr) => {
      tried.push(modelStr);
      return modelStr === models[0] ? jsonResponse(451, ENDPOINT_UNAVAILABLE_451) : okResponse();
    });

    const result = await handleComboChat({ body: { messages: [] }, models, handleSingleModel, log: silentLog });

    expect(tried).toEqual(models);
    expect(result.ok).toBe(true);
    await expect(result.json()).resolves.toMatchObject({
      choices: [{ message: { content: "hello" } }],
    });
  });

  it("reproduces the reported flash combo shape (5 members, first is 451)", async () => {
    const models = [
      "oc/step-5-preview-free",
      "oc/mimo-v2.6-flash-free",
      "openrouter/inclusionai/ling-3.1-flash",
      "tokenharbor/deepseek-v4.1-flash:free",
      "plus",
    ];
    const tried = [];
    const handleSingleModel = vi.fn(async (body, modelStr) => {
      tried.push(modelStr);
      return modelStr === models[0] ? jsonResponse(451, ENDPOINT_UNAVAILABLE_451) : okResponse("second");
    });

    const result = await handleComboChat({ body: { messages: [] }, models, handleSingleModel, log: silentLog });

    expect(tried).toEqual([models[0], models[1]]);
    expect(result.status).toBe(200);
  });

  it("still stops immediately on a request-shape error (every member would reject it)", async () => {
    const models = ["oc/step-5-preview-free", "oc/mimo-v2.6-flash-free"];
    const tried = [];
    const handleSingleModel = vi.fn(async (body, modelStr) => {
      tried.push(modelStr);
      return jsonResponse(400, {
        error: { type: "invalid_request_error", message: "This model's maximum context length is 1048576 tokens" },
      });
    });

    const result = await handleComboChat({ body: { messages: [] }, models, handleSingleModel, log: silentLog });

    expect(tried).toEqual([models[0]]);
    expect(result.status).toBe(400);
  });

  it("returns the last upstream error when every member is 451", async () => {
    const models = ["oc/step-5-preview-free", "oc/mimo-v2.6-flash-free"];
    const tried = [];
    const handleSingleModel = vi.fn(async (body, modelStr) => {
      tried.push(modelStr);
      return jsonResponse(451, ENDPOINT_UNAVAILABLE_451);
    });

    const result = await handleComboChat({ body: { messages: [] }, models, handleSingleModel, log: silentLog });

    expect(tried).toEqual(models);
    expect(result.status).toBe(451);
  });
});