import { describe, expect, it } from "vitest";

import {
  isMonthlyBudgetBreached,
  isTransientFailure,
  L1CircuitBreaker,
  L1_CONSECUTIVE_FAILURE_THRESHOLD,
  L1_WINDOW_MS,
  TRANSIENT_FAILURE_CODES,
} from "./circuit-breaker";
import { deriveBudgetThreshold, FX_VERSION_V1, PRICE_VERSION_V1 } from "./pricing";

/**
 * AC2.7：L1 = 5 分钟窗口内**连续 5 次**瞬时故障触发；第 4 次不触发；
 * 窗口滑出后半开重试，成功即闭合。
 * AC2.8（L2 判定部分）：达到 30 元阈值。
 */

const T0 = Date.parse("2026-10-08T12:00:00.000Z");
const ROLE = "management_analysis" as const;

describe("L1 供应商短窗熔断", () => {
  it("瞬时故障码集合与阈值符合 D-190", () => {
    expect(L1_CONSECUTIVE_FAILURE_THRESHOLD).toBe(5);
    expect(L1_WINDOW_MS).toBe(5 * 60 * 1000);
    expect(TRANSIENT_FAILURE_CODES).toEqual([
      "PROVIDER_TIMEOUT",
      "PROVIDER_UNAVAILABLE",
      "PROVIDER_RATE_LIMITED",
    ]);
    expect(isTransientFailure("PROVIDER_TIMEOUT")).toBe(true);
    expect(isTransientFailure("PROVIDER_REQUEST_INVALID")).toBe(false);
    expect(isTransientFailure("SCHEMA_VALIDATION_FAILED")).toBe(false);
  });

  it("第 4 次不触发，第 5 次触发（连续计数）", () => {
    const breaker = new L1CircuitBreaker();
    for (let count = 1; count <= 4; count += 1) {
      breaker.recordTransientFailure(ROLE, T0);
      expect(breaker.state(ROLE, T0), `第 ${count} 次`).toBe("closed");
      expect(breaker.canAttempt(ROLE, T0), `第 ${count} 次`).toBe(true);
    }
    breaker.recordTransientFailure(ROLE, T0);
    expect(breaker.state(ROLE, T0)).toBe("open");
    expect(breaker.canAttempt(ROLE, T0)).toBe(false);
  });

  it("成功会重置连续计数（非连续的 5 次不触发）", () => {
    const breaker = new L1CircuitBreaker();
    for (let count = 0; count < 4; count += 1) breaker.recordTransientFailure(ROLE, T0);
    breaker.recordSuccess(ROLE);
    for (let count = 0; count < 4; count += 1) breaker.recordTransientFailure(ROLE, T0);
    expect(breaker.state(ROLE, T0)).toBe("closed");
  });

  it("窗口滑出后自动半开，成功即闭合", () => {
    const breaker = new L1CircuitBreaker();
    for (let count = 0; count < 5; count += 1) breaker.recordTransientFailure(ROLE, T0);
    expect(breaker.state(ROLE, T0)).toBe("open");
    expect(breaker.state(ROLE, T0 + L1_WINDOW_MS - 1)).toBe("open");
    expect(breaker.canAttempt(ROLE, T0 + L1_WINDOW_MS - 1)).toBe(false);
    expect(breaker.state(ROLE, T0 + L1_WINDOW_MS)).toBe("half_open");
    expect(breaker.canAttempt(ROLE, T0 + L1_WINDOW_MS)).toBe(true);
    breaker.recordSuccess(ROLE);
    expect(breaker.state(ROLE, T0 + L1_WINDOW_MS)).toBe("closed");
  });

  it("半开探测失败则重新打开", () => {
    const breaker = new L1CircuitBreaker();
    for (let count = 0; count < 5; count += 1) breaker.recordTransientFailure(ROLE, T0);
    const halfOpenAt = T0 + L1_WINDOW_MS;
    expect(breaker.state(ROLE, halfOpenAt)).toBe("half_open");
    breaker.recordTransientFailure(ROLE, halfOpenAt);
    expect(breaker.state(ROLE, halfOpenAt)).toBe("open");
    expect(breaker.canAttempt(ROLE, halfOpenAt)).toBe(false);
  });

  it("窗口外的旧故障不计入连续计数", () => {
    const breaker = new L1CircuitBreaker();
    for (let count = 0; count < 4; count += 1) breaker.recordTransientFailure(ROLE, T0);
    // 第 5 次发生在窗口之外：前四次被剪除，连续计数回到 1。
    breaker.recordTransientFailure(ROLE, T0 + L1_WINDOW_MS + 1);
    expect(breaker.state(ROLE, T0 + L1_WINDOW_MS + 1)).toBe("closed");
  });

  it("按角色隔离：一个角色熔断不影响另一个", () => {
    const breaker = new L1CircuitBreaker();
    for (let count = 0; count < 5; count += 1) breaker.recordTransientFailure(ROLE, T0);
    expect(breaker.canAttempt(ROLE, T0)).toBe(false);
    expect(breaker.canAttempt("intent_parse", T0)).toBe(true);
  });
});

describe("L2 月度预算判定", () => {
  it("达到 30 元阈值即判定为熔断", () => {
    const threshold = deriveBudgetThreshold(PRICE_VERSION_V1, FX_VERSION_V1);
    expect(isMonthlyBudgetBreached(29.999, threshold)).toBe(false);
    expect(isMonthlyBudgetBreached(30, threshold)).toBe(true);
    expect(isMonthlyBudgetBreached(31, threshold)).toBe(true);
  });
});
