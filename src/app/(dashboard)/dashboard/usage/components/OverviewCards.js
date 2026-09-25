"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { formatCnyCost } from "@/shared/utils/currency";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);

export default function OverviewCards({ stats, exchangeRate }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 sm:gap-4">
      <Card className="flex min-w-0 flex-col items-center text-center gap-1 px-3 py-3 sm:px-4">
        <span className="text-text-muted text-xs uppercase font-semibold sm:text-sm">Total Requests</span>
        <span className="w-full truncate text-lg font-bold xl:text-xl" title={fmt(stats.totalRequests)}>{fmt(stats.totalRequests)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col items-center text-center gap-1 px-3 py-3 sm:px-4">
        <span className="text-text-muted text-xs uppercase font-semibold sm:text-sm">Total Input Tokens</span>
        <span className="w-full truncate text-lg font-bold text-primary xl:text-xl" title={fmt(stats.totalPromptTokens)}>{fmt(stats.totalPromptTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col items-center text-center gap-1 px-3 py-3 sm:px-4">
        <span className="text-text-muted text-xs uppercase font-semibold sm:text-sm">Cached Tokens</span>
        <span className="w-full truncate text-lg font-bold text-info xl:text-xl" title={fmt(stats.totalCachedTokens)}>{fmt(stats.totalCachedTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col items-center text-center gap-1 px-3 py-3 sm:px-4">
        <span className="text-text-muted text-xs uppercase font-semibold sm:text-sm">Output Tokens</span>
        <span className="w-full truncate text-lg font-bold text-success xl:text-xl" title={fmt(stats.totalCompletionTokens)}>{fmt(stats.totalCompletionTokens)}</span>
      </Card>
      <Card className="flex min-w-0 flex-col items-center text-center gap-1 px-3 py-3 sm:px-4">
        <span className="text-text-muted text-xs uppercase font-semibold sm:text-sm">Est. Cost</span>
        <span className="w-full truncate text-lg font-bold text-warning xl:text-xl" title={`~${formatCnyCost(stats.totalCost, exchangeRate)}`}>
          ~{formatCnyCost(stats.totalCost, exchangeRate)}
        </span>
        <span className="text-[10px] text-text-muted">Estimated, not actual billing</span>
      </Card>
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
  exchangeRate: PropTypes.shape({
    rate: PropTypes.number.isRequired,
  }),
};
