import { describe, expect, it } from "vitest";
import { formatCnyCost } from "@/shared/utils/currency.js";

describe("CNY cost formatting", () => {
  it("converts a USD cost, adds the 5.5% fee, and formats it as CNY", () => {
    expect(formatCnyCost(1.25, { rate: 7.2 })).toBe("¥9.50");
  });

  it("keeps small per-request costs readable", () => {
    expect(formatCnyCost(
      0.000123,
      { rate: 7.2 },
      { minimumFractionDigits: 0, maximumFractionDigits: 6 },
    )).toBe("¥0.000934");
  });

  it("does not fall back to USD when the rate is unavailable", () => {
    expect(formatCnyCost(1.25, null)).toBe("—");
    expect(formatCnyCost(1.25, { rate: 0 })).toBe("—");
  });

  it("renders a known zero cost as CNY", () => {
    expect(formatCnyCost(0, { rate: 7.2 })).toBe("¥0.00");
  });

});
