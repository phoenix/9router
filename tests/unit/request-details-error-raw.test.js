// Error rows must be diagnosable from the drawer: Provider Response (Raw) used to
// be an empty object on every failed request, so the one case operators care
// about most had nothing to show. These pin that both failure paths persist what
// the provider/transport actually said, plus a classified ending reason.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: executeMock,
    refreshCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => null),
  isNativePassthrough: vi.fn(() => false),
}));

vi.mock("../../open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));

vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn(() => ({
    signal: undefined,
    handleComplete: vi.fn(),
    handleError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({ refreshWithRetry: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ default: vi.fn(), proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/translator/formats/claude.js", () => ({ normalizeClaudePassthrough: vi.fn() }));
vi.mock("../../open-sse/utils/toolDeduper.js", () => ({ dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })) }));
vi.mock("../../open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }));
vi.mock("../../open-sse/rtk/ponytail.js", () => ({ injectPonytail: vi.fn() }));
vi.mock("../../open-sse/rtk/index.js", () => ({ compressMessages: vi.fn(() => null), formatRtkLog: vi.fn(() => "") }));
vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""),
  formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
}));
vi.mock("../../open-sse/providers/capabilities.js", () => ({ getCapabilitiesForModel: vi.fn(() => ({})) }));
vi.mock("../../open-sse/translator/concerns/modality.js", () => ({ stripUnsupportedModalities: vi.fn(() => false) }));
vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({ prefetchRemoteImages: vi.fn(async () => 0) }));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { saveRequestDetail } = await import("@/lib/usageDb.js");
const { ENDING_REASON } = await import("../../open-sse/utils/stopReason.js");

function options() {
  const body = { model: "gpt-4.1", messages: [{ role: "user", content: "hello" }] };
  return {
    body,
    modelInfo: { provider: "openai", model: "gpt-4.1" },
    credentials: { apiKey: "sk-test" },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: { accept: "application/json" } },
    connectionId: "test-connection",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function rows() {
  return saveRequestDetail.mock.calls.map(([row]) => row);
}

describe("error rows carry the provider's own answer", { timeout: 20_000 }, () => {
  beforeEach(() => {
    executeMock.mockReset();
    saveRequestDetail.mockClear();
  });

  it("transport failure (connect timeout) → raw error fields + timeout bucket", async () => {
    const err = new Error("fetch connect timeout");
    err.name = "Error";
    executeMock.mockRejectedValue(err);

    await handleChatCore(options());

    const row = rows().at(-1);
    expect(row.status).toBe("error");
    // Provider Response (Raw) is no longer an empty object.
    expect(row.providerResponse).toMatchObject({
      error: "fetch connect timeout",
      status: 502,
    });
    expect(row.response.finish_reason).toBe(ENDING_REASON.TIMEOUT);
    expect(row.response.native_finish_reason).toBe("fetch connect timeout");
  });

  it("upstream 429 → keeps raw body and records rate_limit", async () => {
    const rawBody = JSON.stringify({ status: 429, title: "Too Many Requests" });
    executeMock.mockResolvedValue({
      response: new Response(rawBody, {
        status: 429,
        headers: { "content-type": "application/json", "x-request-id": "req-123" },
      }),
      url: "https://api.example.com/v1/chat/completions",
      headers: {},
      transformedBody: { model: "gpt-4.1" },
      responseFormat: "openai",
    });

    await handleChatCore(options());

    const row = rows().at(-1);
    expect(row.status).toBe("error");
    expect(row.providerResponse).toMatchObject({
      status: 429,
      raw: rawBody,
      url: "https://api.example.com/v1/chat/completions",
    });
    expect(row.providerResponse.headers["x-request-id"]).toBe("req-123");
    expect(row.response.error).toContain("429");
    expect(row.response.finish_reason).toBe(ENDING_REASON.RATE_LIMIT);
  });

  it("upstream 400 → invalid_request bucket", async () => {
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({ error: { message: "bad parameter" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
      url: "https://api.example.com/v1/chat/completions",
      headers: {},
      transformedBody: {},
      responseFormat: "openai",
    });

    await handleChatCore(options());

    const row = rows().at(-1);
    expect(row.response.finish_reason).toBe(ENDING_REASON.INVALID_REQUEST);
    expect(row.providerResponse.raw).toContain("bad parameter");
  });
});
