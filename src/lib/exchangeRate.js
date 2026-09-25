import { makeKv } from "./db/helpers/kvStore.js";

const EXCHANGE_RATE_URL = "https://api.frankfurter.dev/v2/rate/usd/cny";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_KEY = "usd-cny";
const FETCH_TIMEOUT_MS = 8000;

const exchangeRateKv = makeKv("exchangeRate");

let inFlightRequest = null;

function validateRate(data) {
  if (
    !data
    || data.base !== "USD"
    || data.quote !== "CNY"
    || typeof data.date !== "string"
    || !Number.isFinite(data.rate)
    || data.rate <= 0
  ) {
    throw new Error("Invalid USD/CNY exchange rate response");
  }
}

function isValidCachedRate(value) {
  return Boolean(
    value
    && value.base === "USD"
    && value.quote === "CNY"
    && typeof value.date === "string"
    && Number.isFinite(value.rate)
    && value.rate > 0
    && Number.isFinite(value.fetchedAt),
  );
}

async function refreshUsdToCnyRate(now) {
  const response = await fetch(EXCHANGE_RATE_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Exchange rate request failed with status ${response.status}`);
  }

  const data = await response.json();
  validateRate(data);

  const freshRate = {
    base: data.base,
    quote: data.quote,
    rate: data.rate,
    date: data.date,
    fetchedAt: now,
  };
  await exchangeRateKv.set(CACHE_KEY, freshRate);
  return { ...freshRate, stale: false };
}

export async function getUsdToCnyRate() {
  const now = Date.now();
  const cachedRate = await exchangeRateKv.get(CACHE_KEY);
  if (
    isValidCachedRate(cachedRate)
    && now - cachedRate.fetchedAt < CACHE_TTL_MS
  ) {
    return { ...cachedRate, stale: false };
  }

  if (inFlightRequest) {
    return inFlightRequest.catch((error) => {
      if (isValidCachedRate(cachedRate)) {
        return { ...cachedRate, stale: true };
      }
      throw error;
    });
  }

  inFlightRequest = refreshUsdToCnyRate(now)
    .finally(() => {
      inFlightRequest = null;
    });
  try {
    return await inFlightRequest;
  } catch (error) {
    if (isValidCachedRate(cachedRate)) {
      return { ...cachedRate, stale: true };
    }
    throw error;
  }
}

export const __test__ = {
  CACHE_TTL_MS,
  CACHE_KEY,
  FETCH_TIMEOUT_MS,
  validateRate,
};
