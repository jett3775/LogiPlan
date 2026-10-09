import { describe, expect, it } from "vitest";

import {
  deriveBudgetThreshold,
  estimateCostCny,
  estimateCostUsd,
  FX_VERSION_V1,
  isThresholdCurrent,
  MONTHLY_BUDGET_CNY,
  PRICE_VERSION_V1,
  SAFETY_MARGIN,
  USD_CNY_RATE_V1,
  usdToCny,
} from "./pricing";

/**
 * AC2.6：月预算换算含 **10% 余量**；价格版本变更后**旧阈值被拒绝**、必须重新推导。
 */

describe("月预算阈值换算", () => {
  it("阈值含 10% 安全余量、30 元上限与保守汇率", () => {
    const threshold = deriveBudgetThreshold(PRICE_VERSION_V1, FX_VERSION_V1);
    expect(threshold.safety_margin).toBe(1.1);
    expect(SAFETY_MARGIN).toBe(1.1);
    expect(threshold.monthly_budget_cny).toBe(30);
    expect(threshold.monthly_budget_cny).toBe(MONTHLY_BUDGET_CNY);
    expect(threshold.fx_version).toBe(FX_VERSION_V1);
    // 30 / (7.4 × 1.1) —— 余量使美元额度更小，故更保守。
    expect(threshold.monthly_budget_usd).toBeCloseTo(
      MONTHLY_BUDGET_CNY / (USD_CNY_RATE_V1 * 1.1),
      10,
    );
    expect(threshold.monthly_budget_usd).toBeLessThan(MONTHLY_BUDGET_CNY / USD_CNY_RATE_V1);
  });

  it("人民币成本 = 美元成本 × 保守汇率 × 余量", () => {
    const usd = 0.01;
    expect(usdToCny(usd, FX_VERSION_V1)).toBeCloseTo(usd * USD_CNY_RATE_V1 * SAFETY_MARGIN, 12);
    expect(
      estimateCostCny(PRICE_VERSION_V1, FX_VERSION_V1, "gpt-5.6-terra", {
        inputTokens: 1_000,
        outputTokens: 1_000,
      }),
    ).toBeCloseTo(
      usdToCny(
        estimateCostUsd(PRICE_VERSION_V1, "gpt-5.6-terra", {
          inputTokens: 1_000,
          outputTokens: 1_000,
        }),
        FX_VERSION_V1,
      ),
      12,
    );
  });

  it("价格/汇率版本变化后旧阈值被拒绝（必须重新推导）", () => {
    const threshold = deriveBudgetThreshold(PRICE_VERSION_V1, FX_VERSION_V1);
    expect(isThresholdCurrent(threshold, PRICE_VERSION_V1, FX_VERSION_V1)).toBe(true);
    expect(isThresholdCurrent(threshold, "PRICE_2026_V2", FX_VERSION_V1)).toBe(false);
    expect(isThresholdCurrent(threshold, PRICE_VERSION_V1, "FX_2026_V2")).toBe(false);
  });

  it("未知价格/汇率版本不得静默推导（抛错，由调用方失败关闭）", () => {
    expect(() => deriveBudgetThreshold("PRICE_UNKNOWN", FX_VERSION_V1)).toThrow();
    expect(() => deriveBudgetThreshold(PRICE_VERSION_V1, "FX_UNKNOWN")).toThrow();
  });

  it("未知模型成本为 Infinity（预留必然超上限 → 失败关闭）", () => {
    expect(
      estimateCostUsd(PRICE_VERSION_V1, "unknown-model", { inputTokens: 1, outputTokens: 1 }),
    ).toBe(Number.POSITIVE_INFINITY);
  });
});
