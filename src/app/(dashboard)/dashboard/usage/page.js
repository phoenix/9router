"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { UsageStats, RequestLogger, CardSkeleton, SegmentedControl } from "@/shared/components";
import RequestDetailsTab from "./components/RequestDetailsTab";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
  { value: "all", label: "All" },
];

export default function UsagePage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <UsageContent />
    </Suspense>
  );
}

function UsageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [period, setPeriod] = useState("today");
  const [exchangeRate, setExchangeRate] = useState(null);
  const [exchangeRateLoading, setExchangeRateLoading] = useState(true);
  const [exchangeRateUnavailable, setExchangeRateUnavailable] = useState(false);

  useEffect(() => {
    let active = true;

    fetch("/api/exchange-rate")
      .then((response) => {
        if (!response.ok) throw new Error(`exchange rate ${response.status}`);
        return response.json();
      })
      .then((rate) => {
        if (!active) return;
        if (!Number.isFinite(rate?.rate) || rate.rate <= 0) {
          throw new Error("Invalid exchange rate response");
        }
        setExchangeRate(rate);
        setExchangeRateUnavailable(false);
      })
      .catch(() => {
        if (active) setExchangeRateUnavailable(true);
      })
      .finally(() => {
        if (active) setExchangeRateLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const exchangeRateStatus = exchangeRateUnavailable
    ? { icon: "cloud_off", text: "Exchange rate unavailable", tone: "error" }
    : exchangeRate?.stale
      ? {
          icon: "history",
          text: "Using cached exchange rate (may be outdated)",
          tone: "warning",
        }
      : exchangeRateLoading
        ? { icon: "progress_activity", text: "Loading exchange rate", tone: "muted" }
        : null;

  const tabFromUrl = searchParams.get("tab");
  const activeTab = tabFromUrl && ["overview", "logs", "details"].includes(tabFromUrl)
    ? tabFromUrl
    : "overview";

  const handleTabChange = (value) => {
    if (value === activeTab) return;
    const params = new URLSearchParams(searchParams);
    params.set("tab", value);
    router.push(`/dashboard/usage?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Tabs + period selector on same row */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl
          options={[
            { value: "overview", label: "Overview" },
            { value: "details", label: "Details" },
          ]}
          value={activeTab}
          onChange={handleTabChange}
          className="w-full sm:w-auto"
        />
        {activeTab === "overview" && (
          <SegmentedControl
            options={PERIODS}
            value={period}
            onChange={setPeriod}
            size="sm"
            className="w-full sm:w-auto"
          />
        )}
      </div>

      {exchangeRateStatus && (
        <div
          role="status"
          aria-atomic="true"
          className={`flex items-center gap-1.5 self-start rounded-md border px-2.5 py-1 text-xs ${
            exchangeRateStatus.tone === "error"
              ? "border-error/30 bg-error/5 text-error"
              : exchangeRateStatus.tone === "warning"
                ? "border-warning/30 bg-warning/5 text-warning"
                : "border-border bg-bg-subtle text-text-muted"
          }`}
        >
          <span
            className={`material-symbols-outlined text-[15px] ${exchangeRateStatus.tone === "muted" ? "animate-spin" : ""}`}
            aria-hidden="true"
          >
            {exchangeRateStatus.icon}
          </span>
          <span>{exchangeRateStatus.text}</span>
          {exchangeRate?.date && (
            <span className="text-text-muted">· {exchangeRate.date}</span>
          )}
        </div>
      )}

      {activeTab === "overview" && (
        <Suspense fallback={<CardSkeleton />}>
          <UsageStats
            period={period}
            setPeriod={setPeriod}
            hidePeriodSelector
            exchangeRate={exchangeRate}
          />
        </Suspense>
      )}
      {activeTab === "logs" && <RequestLogger />}
      {activeTab === "details" && <RequestDetailsTab exchangeRate={exchangeRate} />}
    </div>
  );
}
