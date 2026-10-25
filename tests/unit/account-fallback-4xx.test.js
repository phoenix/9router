// Regression: an unmatched 4xx (a request-scoped failure) used to hit the
// transient-cooldown default, which locked the account for 30s and — with a
// single connection — answered every other request in that window with a copy of
// the first error. A 400 "maximum context length" from one session therefore
// looked like the same failure in unrelated sessions.
import { describe, expect, it } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { FALLBACK_SCOPE } from "../../open-sse/config/errorConfig.js";

describe("checkFallbackError — request-scoped vs account-scoped failures", () => {
  it("does not cool the account down for a 400 caused by the request", () => {
    const result = checkFallbackError(400, JSON.stringify({
      error: {
        message: "This model's maximum context length is 1048576 tokens. However, you requested 1186139 tokens",
        type: "invalid_request_error",
      },
    }));

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0, requestScoped: true });
  });

  it("still falls back for account-scoped statuses", () => {
    for (const status of [401, 402, 403, 404, 429]) {
      expect(checkFallbackError(status, "nope").shouldFallback).toBe(true);
    }
  });

  it("still honours rate-limit / quota wording on any 4xx", () => {
    expect(checkFallbackError(400, "rate limit reached").shouldFallback).toBe(true);
    expect(checkFallbackError(422, "quota exceeded").shouldFallback).toBe(true);
  });

  it.each([
    "You have insufficient credits to make this request. Please purchase more credits to continue using the service.",
    "INSUFFICIENT CREDITS",
    "Insufficient credit balance",
    "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    "CREDIT BALANCE IS TOO LOW",
  ])("falls back with backoff for a 400 credit error: %s", (message) => {
    expect(checkFallbackError(400, message)).toEqual({
      shouldFallback: true, cooldownMs: 2000, newBackoffLevel: 1,
    });
    expect(checkFallbackError(400, message, 1)).toEqual({
      shouldFallback: true, cooldownMs: 4000, newBackoffLevel: 2,
    });
  });

  it("does not fall back for an ordinary bad request", () => {
    expect(checkFallbackError(400, "Bad request")).toEqual({
      shouldFallback: false, cooldownMs: 0, requestScoped: true,
    });
  });

  it("keeps the transient cooldown for unmatched server errors", () => {
    const result = checkFallbackError(503, "upstream exploded");

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });
});

// Regression: 451 is provider-scoped, not request-scoped. opencode zen answers
// `451 {"error":{"message":"Upstream request failed: Endpoint is unavailable."}}`
// when a model is pulled from its endpoint. The account-scoped guard below used to
// decide BOTH questions — "should this credential cool down?" and "should the combo
// try its next model?" — so the combo stopped on the first member and returned the
// 451 to the client while four healthy members sat untried
// ("[COMBO] Model oc/step-5-preview-free failed (no fallback)").
describe("checkFallbackError — fallback scope (account vs combo)", () => {
  it("defaults to the account scope so existing callers are unchanged", () => {
    const result = checkFallbackError(400, JSON.stringify({
      error: { message: "This model's maximum context length is 1048576 tokens" },
    }));

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0, requestScoped: true });
    expect(checkFallbackError(400, "nope", 0, null, FALLBACK_SCOPE.ACCOUNT)).toEqual(result);
  });

  it("falls back on a 451 in the combo scope (provider-scoped, not the request)", () => {
    const result = checkFallbackError(
      451,
      JSON.stringify({ error: { type: "server_error", message: "Upstream request failed: Endpoint is unavailable." } }),
      0,
      null,
      FALLBACK_SCOPE.MODEL,
    );

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });

  it("flags a request-shape error as requestScoped in the combo scope (no account fallback)", () => {
    // Upstream #5057: requestScoped means "advance to the next combo member and,
    // if none can serve it, hand back this member's own response" — the
    // credential is never cooled down either way.
    const result = checkFallbackError(
      400,
      JSON.stringify({ error: { message: "This model's maximum context length is 1048576 tokens" } }),
      0,
      null,
      FALLBACK_SCOPE.MODEL,
    );

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0, requestScoped: true });
  });

  it("treats transport-level statuses as fallback-worthy in the combo scope", () => {
    for (const status of [408, 409, 413, 416, 423, 425, 431]) {
      expect(checkFallbackError(status, "nope", 0, null, FALLBACK_SCOPE.MODEL).shouldFallback).toBe(true);
    }
  });

  it("never cools the account down for request-shape statuses in the account scope", () => {
    // The account scope must NOT adopt the combo scope's permissive set: a 400 is
    // still the request's fault, so the credential stays healthy.
    for (const status of [400, 413, 422, 451]) {
      expect(checkFallbackError(status, "nope", 0, null, FALLBACK_SCOPE.ACCOUNT).shouldFallback).toBe(false);
    }
  });

  it("lets provider-scoped rules match when the provider is supplied", () => {
    // ERROR_RULES carries a codex-only rule; it must stay inert for other
    // providers and stay reachable now that combo resolves alias→id.
    const codexText = "model is not supported when using codex with a chatgpt account";

    expect(checkFallbackError(400, codexText, 0, "codex", FALLBACK_SCOPE.ACCOUNT).shouldFallback).toBe(true);
    expect(checkFallbackError(400, codexText, 0, "openai", FALLBACK_SCOPE.ACCOUNT).shouldFallback).toBe(false);
    // Unresolved alias must not accidentally match the id-keyed rule.
    expect(checkFallbackError(400, codexText, 0, "cx", FALLBACK_SCOPE.ACCOUNT).shouldFallback).toBe(false);
  });
});
