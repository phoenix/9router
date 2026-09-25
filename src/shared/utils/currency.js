const EXCHANGE_FEE_MULTIPLIER = 1.055;

const DEFAULT_COST_FORMAT = {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
};

export function formatCnyCost(usdAmount, exchangeRate, options = DEFAULT_COST_FORMAT) {
  if (
    usdAmount == null
    || !Number.isFinite(usdAmount)
    || !exchangeRate
    || !Number.isFinite(exchangeRate.rate)
    || exchangeRate.rate <= 0
  ) {
    return "—";
  }

  const amount = usdAmount * exchangeRate.rate * EXCHANGE_FEE_MULTIPLIER;
  return `¥${amount.toLocaleString("zh-CN", options)}`;
}
