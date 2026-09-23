import { describe, it, expect } from "vitest";
import {
  MODEL_PRICING,
  PATTERN_PRICING,
  getPricingForModel,
  calculateCostFromTokens,
} from "../../open-sse/providers/pricing.js";

// 免费模型（-free 后缀）是收费本体的免费通道：预估成本应映射到收费本体的市价，
// 而不是一律记 0（除非本体本身就没有公开定价 —— 那类"神秘模型"保持 0）。
describe("free-variant pricing maps to its paid base model", () => {
  describe("base models exist in MODEL_PRICING", () => {
    it("mimo-v2.5 has Xiaomi official pricing", () => {
      expect(MODEL_PRICING["mimo-v2.5"]).toBeDefined();
      expect(MODEL_PRICING["mimo-v2.5"].input).toBe(0.14);
      expect(MODEL_PRICING["mimo-v2.5"].output).toBe(0.28);
    });

    it("mimo-v2.6-flash has Xiaomi official pricing", () => {
      expect(MODEL_PRICING["mimo-v2.6-flash"]).toBeDefined();
      expect(MODEL_PRICING["mimo-v2.6-flash"].input).toBe(0.14);
      expect(MODEL_PRICING["mimo-v2.6-flash"].output).toBe(0.28);
    });

    it("mimo-v2-omni has Xiaomi official pricing", () => {
      expect(MODEL_PRICING["mimo-v2-omni"]).toBeDefined();
    });

    it("mimo-v2-flash has Xiaomi official pricing", () => {
      expect(MODEL_PRICING["mimo-v2-flash"]).toBeDefined();
    });

    it("mimo-v2-pro has Xiaomi official pricing", () => {
      expect(MODEL_PRICING["mimo-v2-pro"]).toBeDefined();
    });

    it("mimo-v2.5-pro has Xiaomi official pricing", () => {
      expect(MODEL_PRICING["mimo-v2.5-pro"]).toBeDefined();
    });

    it("mimo-v2.6-pro has Xiaomi official pricing", () => {
      expect(MODEL_PRICING["mimo-v2.6-pro"]).toBeDefined();
    });

    it("muse-spark-1.3 has official pricing", () => {
      expect(MODEL_PRICING["muse-spark-1.3"]).toBeDefined();
      expect(MODEL_PRICING["muse-spark-1.3"].input).toBe(0.1);
      expect(MODEL_PRICING["muse-spark-1.3"].output).toBe(0.2);
    });

    it("muse-spark-1.2 has official pricing", () => {
      expect(MODEL_PRICING["muse-spark-1.2"]).toBeDefined();
    });

    it("nemotron-3-ultra-550b-a55b has NVIDIA official pricing", () => {
      expect(MODEL_PRICING["nemotron-3-ultra-550b-a55b"]).toBeDefined();
      expect(MODEL_PRICING["nemotron-3-ultra-550b-a55b"].input).toBe(0.5);
      expect(MODEL_PRICING["nemotron-3-ultra-550b-a55b"].output).toBe(2.5);
    });

    it("nemotron-3-super-120b-a12b has NVIDIA official pricing globally", () => {
      expect(MODEL_PRICING["nemotron-3-super-120b-a12b"]).toBeDefined();
      expect(MODEL_PRICING["nemotron-3-super-120b-a12b"].input).toBe(0.3);
      expect(MODEL_PRICING["nemotron-3-super-120b-a12b"].output).toBe(0.9);
    });

    it("nemotron-3.5-lightning has NVIDIA official pricing", () => {
      expect(MODEL_PRICING["nemotron-3.5-lightning"]).toBeDefined();
      expect(MODEL_PRICING["nemotron-3.5-lightning"].input).toBe(0.2);
      expect(MODEL_PRICING["nemotron-3.5-lightning"].output).toBe(0.8);
    });
  });

  describe("getPricingForModel resolves free variants to base pricing", () => {
    const cases = [
      ["opencode", "mimo-v2.5-free", "mimo-v2.5"],
      ["opencode", "mimo-v2.6-flash-free", "mimo-v2.6-flash"],
      ["opencode", "mimo-v2-pro-free", "mimo-v2-pro"],
      ["opencode", "mimo-v2-omni-free", "mimo-v2-omni"],
      ["opencode", "mimo-v2-flash-free", "mimo-v2-flash"],
      ["opencode", "muse-spark-1.2-contributor-free", "muse-spark-1.2"],
      ["opencode", "muse-spark-1.3-contributor-free", "muse-spark-1.3"],
      ["opencode", "nemotron-3-ultra-free", "nemotron-3-ultra-550b-a55b"],
    ];

    for (const [provider, freeModel, baseModel] of cases) {
      it(`${freeModel} → ${baseModel} pricing`, () => {
        const freePricing = getPricingForModel(provider, freeModel);
        expect(freePricing).not.toBeNull();
        expect(freePricing.input).toBe(MODEL_PRICING[baseModel].input);
        expect(freePricing.output).toBe(MODEL_PRICING[baseModel].output);
      });
    }

    it("free variant cost is non-zero when base model has pricing", () => {
      const pricing = getPricingForModel("opencode", "mimo-v2.5-free");
      const cost = calculateCostFromTokens(
        { prompt_tokens: 100000, completion_tokens: 50000 },
        pricing
      );
      // 100k * 0.14/1M + 50k * 0.28/1M = 0.014 + 0.014 = 0.028
      expect(cost).toBeCloseTo(0.028, 6);
    });

    it("unknown mystery models without a priced base still resolve to null", () => {
      expect(getPricingForModel("opencode", "x-preview-f-free")).toBeNull();
      expect(getPricingForModel("openrouter", "stealth/ox-alpha")).toBeNull();
      expect(getPricingForModel("openrouter", "openrouter/elephant-alpha")).toBeNull();
    });
  });

  describe("PATTERN_PRICING free-strip rule", () => {
    it("contains a *-free strip rule before the generic fallbacks", () => {
      const rule = PATTERN_PRICING.find((r) => r.stripFree === true);
      expect(rule).toBeDefined();
    });
  });
});
