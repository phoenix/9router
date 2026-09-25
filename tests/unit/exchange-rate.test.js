import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeKv } from "@/lib/db/helpers/kvStore.js";
import { getUsdToCnyRate } from "@/lib/exchangeRate.js";

const NOW = Date.parse("2026-05-25T08:00:00.000Z");
const exchangeRateKv = makeKv("exchangeRate");

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

beforeEach(async () => {
  await exchangeRateKv.clear();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("USD/CNY exchange rate service", () => {
  it("fetches the USD/CNY rate and exposes its fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      date: "2026-05-25",
      base: "USD",
      quote: "CNY",
      rate: 7.1234,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getUsdToCnyRate();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.frankfurter.dev/v2/rate/usd/cny");
    expect(result).toEqual({
      base: "USD",
      quote: "CNY",
      rate: 7.1234,
      date: "2026-05-25",
      fetchedAt: NOW,
      stale: false,
    });
  });

  it("uses a persisted rate while it is less than 7 days old", async () => {
    const cachedRate = {
      base: "USD",
      quote: "CNY",
      rate: 7.05,
      date: "2026-05-24",
      fetchedAt: NOW - 6 * 24 * 60 * 60 * 1000,
    };
    await exchangeRateKv.set("usd-cny", cachedRate);
    const fetchMock = vi.fn().mockRejectedValue(new Error("network should not be called"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getUsdToCnyRate()).resolves.toEqual({
      ...cachedRate,
      stale: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes and persists a rate after 7 days", async () => {
    await exchangeRateKv.set("usd-cny", {
      base: "USD",
      quote: "CNY",
      rate: 7.0,
      date: "2026-05-17",
      fetchedAt: NOW - 7 * 24 * 60 * 60 * 1000,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      date: "2026-05-25",
      base: "USD",
      quote: "CNY",
      rate: 7.2,
    })));

    await expect(getUsdToCnyRate()).resolves.toEqual({
      base: "USD",
      quote: "CNY",
      rate: 7.2,
      date: "2026-05-25",
      fetchedAt: NOW,
      stale: false,
    });
    await expect(exchangeRateKv.get("usd-cny")).resolves.toEqual({
      base: "USD",
      quote: "CNY",
      rate: 7.2,
      date: "2026-05-25",
      fetchedAt: NOW,
    });
  });

  it("returns an expired rate as stale when refresh fails", async () => {
    const cachedRate = {
      base: "USD",
      quote: "CNY",
      rate: 7.1,
      date: "2026-05-01",
      fetchedAt: NOW - 8 * 24 * 60 * 60 * 1000,
    };
    await exchangeRateKv.set("usd-cny", cachedRate);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("upstream unavailable")));

    await expect(getUsdToCnyRate()).resolves.toEqual({
      ...cachedRate,
      stale: true,
    });
  });

  it("throws when no cached rate exists and refresh fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("upstream unavailable")));

    await expect(getUsdToCnyRate()).rejects.toThrow("upstream unavailable");
  });

  it("rejects an invalid upstream rate instead of caching it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      date: "2026-05-25",
      base: "EUR",
      quote: "CNY",
      rate: 0,
    })));

    await expect(getUsdToCnyRate()).rejects.toThrow("Invalid USD/CNY exchange rate response");
    await expect(exchangeRateKv.get("usd-cny")).resolves.toBeNull();
  });

  it("keeps stale fallback caller-specific when concurrent refresh fails", async () => {
    const cachedRate = {
      base: "USD",
      quote: "CNY",
      rate: 7.1,
      date: "2026-05-01",
      fetchedAt: NOW - 8 * 24 * 60 * 60 * 1000,
    };
    await exchangeRateKv.set("usd-cny", cachedRate);
    let rejectFetch;
    const fetchResponse = new Promise((_, reject) => {
      rejectFetch = reject;
    });
    const fetchMock = vi.fn().mockReturnValue(fetchResponse);
    vi.stubGlobal("fetch", fetchMock);

    const staleRequest = getUsdToCnyRate();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await exchangeRateKv.remove("usd-cny");
    const noCacheRequest = getUsdToCnyRate();
    rejectFetch(new Error("upstream unavailable"));

    await expect(staleRequest).resolves.toEqual({ ...cachedRate, stale: true });
    await expect(noCacheRequest).rejects.toThrow("upstream unavailable");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent refreshes into one upstream request", async () => {
    let resolveFetch;
    const fetchResponse = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(fetchResponse);
    vi.stubGlobal("fetch", fetchMock);

    const requests = Promise.all([
      getUsdToCnyRate(),
      getUsdToCnyRate(),
      getUsdToCnyRate(),
    ]);
    resolveFetch(jsonResponse({
      date: "2026-05-25",
      base: "USD",
      quote: "CNY",
      rate: 7.3,
    }));

    const results = await requests;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(results.every((result) => result.rate === 7.3)).toBe(true);
  });
});

describe("exchange rate API route", () => {
  it("returns the rate contract with 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      date: "2026-05-25",
      base: "USD",
      quote: "CNY",
      rate: 7.4,
    })));
    const { GET } = await import("@/app/api/exchange-rate/route.js");

    const response = await GET(new Request("http://localhost/api/exchange-rate"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      base: "USD",
      quote: "CNY",
      rate: 7.4,
      date: "2026-05-25",
      fetchedAt: NOW,
      stale: false,
    });
  });

  it("returns 503 without exposing upstream details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret upstream detail")));
    const { GET } = await import("@/app/api/exchange-rate/route.js");

    const response = await GET(new Request("http://localhost/api/exchange-rate"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ error: "Failed to fetch exchange rate" });
  });
});
