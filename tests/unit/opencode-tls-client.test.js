import { describe, it, expect, vi, beforeEach } from "vitest";

// The free gate keys on the TLS ClientHello: on one process and egress IP the
// same body/headers answered 429 over Node's OpenSSL fingerprint and 200 over
// the cipher list below. These tests pin the wiring, not the upstream.
const { createSessionMock, loadRuntimeDepMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  loadRuntimeDepMock: vi.fn(),
}));

vi.mock("../../open-sse/services/lazyRuntime.js", () => ({
  loadRuntimeDep: loadRuntimeDepMock,
}));

describe("opencodeTlsClient", () => {
  beforeEach(async () => {
    vi.resetModules();
    createSessionMock.mockReset();
    loadRuntimeDepMock.mockReset();
    loadRuntimeDepMock.mockResolvedValue({ createSession: createSessionMock });
  });

  it("uses the cipher list the upstream accepts and sends ALPN-negotiated requests", async () => {
    const response = new Response("data: ok\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const fetchMock = vi.fn().mockResolvedValue(response);
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch, __test__ } = await import("../../open-sse/services/opencodeTlsClient.js");
    const result = await opencodeTlsFetch("https://opencode.ai/inference/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    const options = createSessionMock.mock.calls[0][0];
    expect(options.emulation.tlsOptions.cipherList).toBe(__test__.OPENCODE_CIPHER_LIST);
    // BoringSSL family list: AES-128-GCM first plus the legacy CBC entries the
    // upstream fingerprints on. Dropping any of them is refused upstream.
    expect(__test__.OPENCODE_CIPHER_LIST.split(":")).toHaveLength(17);
    expect(__test__.OPENCODE_CIPHER_LIST.startsWith("TLS_AES_128_GCM_SHA256")).toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://opencode.ai/inference/v1/chat/completions",
      expect.objectContaining({ method: "POST", body: "{}" })
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("text/event-stream");
  });

  it("reuses one session across requests", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("ok", { status: 200 }));
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    await opencodeTlsFetch("https://opencode.ai/a", {});
    await opencodeTlsFetch("https://opencode.ai/b", {});

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces an actionable error when wreq-js is unavailable", async () => {
    loadRuntimeDepMock.mockRejectedValue(new Error("MODULE_NOT_FOUND"));

    const { opencodeTlsFetch, OpencodeTlsUnavailableError } = await import(
      "../../open-sse/services/opencodeTlsClient.js"
    );

    await expect(opencodeTlsFetch("https://opencode.ai/a", {})).rejects.toBeInstanceOf(
      OpencodeTlsUnavailableError
    );
  });

  it("forwards the abort signal so a cancelled stream stops upstream", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("ok", { status: 200 }));
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    const controller = new AbortController();
    await opencodeTlsFetch("https://opencode.ai/a", {}, { signal: controller.signal });
    controller.abort();
    // 外层取消必须传到 wreq 的请求信号上（与内部空闲看门狗信号合成）
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  // ↓ 2026-10-27 生产事故回归：mimo-v2.6-flash-free 流式响应在 121388ms 被
  // "request or response body error: operation timed out" 掐断。根因是 wreq 的
  // `timeout` 是「请求总时长」硬上限（字节仍在流动也照杀），不是字节空闲超时。

  it("never hands wreq a whole-request deadline — live streams must survive", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("data: ok\n\n", { status: 200 }));
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    await opencodeTlsFetch("https://opencode.ai/a", { method: "POST", body: "{}" });

    // 0 = wreq 不设总上限（其契约：0 或正数）；空闲防护由字节级看门狗负责
    expect(fetchMock.mock.calls[0][1].timeout).toBe(0);
  });

  it("aborts when the upstream never sends headers (no infinite wait)", async () => {
    createSessionMock.mockResolvedValue({
      fetch: vi.fn().mockReturnValue(new Promise(() => {})),
      close: vi.fn(),
    });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    await expect(
      opencodeTlsFetch("https://opencode.ai/a", {}, { headersTimeoutMs: 60 })
    ).rejects.toMatchObject({ name: "StreamIdleTimeoutError" });
  });

  it("kills a body that never sends its first byte (TTFT budget, not forever)", async () => {
    const silentBody = new ReadableStream({ start() { /* 永不吐字节 */ } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(silentBody, { status: 200 }));
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    const res = await opencodeTlsFetch("https://opencode.ai/a", {}, { ttftTimeoutMs: 60 });

    const reader = res.body.getReader();
    await expect(reader.read()).rejects.toMatchObject({ name: "StreamIdleTimeoutError" });
  });

  it("judges a slow first byte by the TTFT budget, not the tight inter-chunk idle", async () => {
    // 首字节 350ms 才到（合法 prefill），之后永久静默。TTFT 预算必须放行首字节，
    // 真正的死因只能是后续静默，且不得早于首字节到达。
    const enc = new TextEncoder();
    let sent = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (sent >= 1) return new Promise(() => {}); // 首块之后永久静默
        await new Promise((r) => setTimeout(r, 350));
        sent++;
        controller.enqueue(enc.encode("first\n"));
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    const res = await opencodeTlsFetch("https://opencode.ai/a", {}, { ttftTimeoutMs: 2500, idleTimeoutMs: 120 });

    const reader = res.body.getReader();
    const t0 = Date.now();
    const first = await reader.read(); // 首字节 350ms：必须被 TTFT 预算放行
    expect(first.done).toBe(false);
    await expect(reader.read()).rejects.toMatchObject({ name: "StreamIdleTimeoutError" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300); // 不能被紧的流动后空闲提前杀
  });

  it("kills mid-stream silence at the tight inter-chunk idle", async () => {
    // 两块很快到，之后静默：流动后的空闲判定用小的 idleTimeoutMs，必须 ~百毫秒级断
    const enc = new TextEncoder();
    let n = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (n >= 2) return new Promise(() => {}); // 静默
        n++;
        await new Promise((r) => setTimeout(r, 20));
        controller.enqueue(enc.encode(`chunk ${n}\n`));
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    const res = await opencodeTlsFetch("https://opencode.ai/a", {}, { ttftTimeoutMs: 2500, idleTimeoutMs: 150 });

    const reader = res.body.getReader();
    await reader.read();
    await reader.read();
    await expect(reader.read()).rejects.toMatchObject({ name: "StreamIdleTimeoutError" });
  });

  it("keeps a slow-but-alive stream flowing (inter-byte idle semantics, not total)", async () => {
    const enc = new TextEncoder();
    let n = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (n >= 8) { controller.close(); return; }
        await new Promise((resolve) => setTimeout(resolve, 120));
        n++;
        controller.enqueue(enc.encode(`chunk ${n}\n`));
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    const res = await opencodeTlsFetch("https://opencode.ai/a", {}, { ttftTimeoutMs: 400, idleTimeoutMs: 400 });

    const chunks = [];
    for await (const chunk of res.body) chunks.push(chunk);
    // 总时长 ~960ms > idleTimeoutMs 400ms，但字节间隔 ~120ms < 400ms：
    // 空闲语义下必须收齐全部 8 块，绝不能像总时长上限那样中途掐断。
    expect(chunks).toHaveLength(8);
  }, 10000);
});
