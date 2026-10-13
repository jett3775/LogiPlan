import { describe, expect, it } from "vitest";

import {
  circuitKey,
  isMonthlyBudgetBreached,
  isTransientFailure,
  L1CircuitBreaker,
  L1_CONSECUTIVE_FAILURE_THRESHOLD,
  L1_WINDOW_MS,
  TRANSIENT_FAILURE_CODES,
  type CircuitBreakerOptions,
} from "./circuit-breaker";
import { ControlPlaneUnavailableError } from "./redis-like";
import { deriveBudgetThreshold, FX_VERSION_V1, PRICE_VERSION_V1 } from "./pricing";
import { InMemoryRedisLike, MalformedRedisLike } from "./test-doubles";

/**
 * AC2.7：L1 = 5 分钟窗口内**连续 5 次**瞬时故障触发；第 4 次不触发；
 * 窗口滑出后半开重试，成功即闭合。
 * AC2.8（L2 判定部分）：达到 30 元阈值。
 *
 * 本切片起 L1 状态落在**注入的存储**（此处用内存替身；生产为 Redis），方法均为异步。
 * 语义与 D-190 决策一逐条不变；「跨实例一致」由门控集成测试
 * `circuit-breaker.integration.test.ts` 打真实 Redis 验证。
 */

const T0 = Date.parse("2026-10-08T12:00:00.000Z");
const ROLE = "management_analysis" as const;

/** 每个用例新建独立存储，使 L1 状态互不干扰。 */
const makeBreaker = (
  options: CircuitBreakerOptions = {},
): { breaker: L1CircuitBreaker; redis: InMemoryRedisLike } => {
  const redis = new InMemoryRedisLike();
  return { breaker: new L1CircuitBreaker(redis, options), redis };
};

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

  it("存储键按角色隔离：`circuit:{role}`", () => {
    expect(circuitKey(ROLE)).toBe("circuit:management_analysis");
    expect(circuitKey("intent_parse")).not.toBe(circuitKey(ROLE));
  });

  it("第 4 次不触发，第 5 次触发（连续计数）", async () => {
    const { breaker } = makeBreaker();
    for (let count = 1; count <= 4; count += 1) {
      await breaker.recordTransientFailure(ROLE, T0);
      expect(await breaker.state(ROLE, T0), `第 ${count} 次`).toBe("closed");
      expect(await breaker.canAttempt(ROLE, T0), `第 ${count} 次`).toBe(true);
    }
    await breaker.recordTransientFailure(ROLE, T0);
    expect(await breaker.state(ROLE, T0)).toBe("open");
    expect(await breaker.canAttempt(ROLE, T0)).toBe(false);
  });

  it("一次纯读返回完整判定（状态 + 窗口内故障数），不写任何键", async () => {
    const { breaker, redis } = makeBreaker();
    for (let count = 0; count < 4; count += 1) await breaker.recordTransientFailure(ROLE, T0);
    const callsBefore = redis.calls.circuitRead;
    const snapshot = await breaker.read(ROLE, T0);
    expect(snapshot).toEqual({ state: "closed", failures: 4, openedAt: null });
    expect(redis.calls.circuitRead).toBe(callsBefore + 1);
    // 纯读：不产生任何熔断写调用。
    expect(redis.calls.circuitRecordFailure).toBe(4);
    expect(redis.calls.circuitRecordSuccess).toBe(0);
  });

  it("成功会重置连续计数（非连续的 5 次不触发）", async () => {
    const { breaker } = makeBreaker();
    for (let count = 0; count < 4; count += 1) await breaker.recordTransientFailure(ROLE, T0);
    await breaker.recordSuccess(ROLE);
    for (let count = 0; count < 4; count += 1) await breaker.recordTransientFailure(ROLE, T0);
    expect(await breaker.state(ROLE, T0)).toBe("closed");
  });

  it("窗口滑出后自动半开，成功即闭合", async () => {
    const { breaker } = makeBreaker();
    for (let count = 0; count < 5; count += 1) await breaker.recordTransientFailure(ROLE, T0);
    expect(await breaker.state(ROLE, T0)).toBe("open");
    expect(await breaker.state(ROLE, T0 + L1_WINDOW_MS - 1)).toBe("open");
    expect(await breaker.canAttempt(ROLE, T0 + L1_WINDOW_MS - 1)).toBe(false);
    expect(await breaker.state(ROLE, T0 + L1_WINDOW_MS)).toBe("half_open");
    expect(await breaker.canAttempt(ROLE, T0 + L1_WINDOW_MS)).toBe(true);
    await breaker.recordSuccess(ROLE);
    expect(await breaker.state(ROLE, T0 + L1_WINDOW_MS)).toBe("closed");
  });

  it("半开探测失败则重新打开", async () => {
    const { breaker } = makeBreaker();
    for (let count = 0; count < 5; count += 1) await breaker.recordTransientFailure(ROLE, T0);
    const halfOpenAt = T0 + L1_WINDOW_MS;
    expect(await breaker.state(ROLE, halfOpenAt)).toBe("half_open");
    await breaker.recordTransientFailure(ROLE, halfOpenAt);
    expect(await breaker.state(ROLE, halfOpenAt)).toBe("open");
    expect(await breaker.canAttempt(ROLE, halfOpenAt)).toBe(false);
    // 半开失败重置为**单次**并重开：窗口内故障数为 1。
    expect((await breaker.read(ROLE, halfOpenAt)).failures).toBe(1);
  });

  it("窗口外的旧故障不计入连续计数", async () => {
    const { breaker } = makeBreaker();
    for (let count = 0; count < 4; count += 1) await breaker.recordTransientFailure(ROLE, T0);
    // 第 5 次发生在窗口之外：前四次被剪除，连续计数回到 1。
    await breaker.recordTransientFailure(ROLE, T0 + L1_WINDOW_MS + 1);
    expect(await breaker.state(ROLE, T0 + L1_WINDOW_MS + 1)).toBe("closed");
  });

  it("按角色隔离：一个角色熔断不影响另一个", async () => {
    const { breaker } = makeBreaker();
    for (let count = 0; count < 5; count += 1) await breaker.recordTransientFailure(ROLE, T0);
    expect(await breaker.canAttempt(ROLE, T0)).toBe(false);
    expect(await breaker.canAttempt("intent_parse", T0)).toBe(true);
  });

  it("窗口与阈值可由 options 覆盖（不改变默认常量）", async () => {
    const { breaker } = makeBreaker({ windowMs: 1_000, threshold: 2 });
    await breaker.recordTransientFailure(ROLE, T0);
    expect(await breaker.state(ROLE, T0)).toBe("closed");
    await breaker.recordTransientFailure(ROLE, T0);
    expect(await breaker.state(ROLE, T0)).toBe("open");
    expect(await breaker.state(ROLE, T0 + 1_000)).toBe("half_open");
  });

  it("存储返回畸形快照 → 抛 ControlPlaneUnavailableError（不静默回退）", async () => {
    const breaker = new L1CircuitBreaker(new MalformedRedisLike());
    await expect(breaker.read(ROLE, T0)).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
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
