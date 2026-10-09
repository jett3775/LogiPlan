import { describe, expect, it } from "vitest";

import {
  budgetLedgerKey,
  monthStamp,
  readMonthlyUsage,
  reserveBudget,
  reserveFailureErrorCode,
  settleBudget,
} from "./budget-ledger";
import { deriveBudgetThreshold, FX_VERSION_V1, PRICE_VERSION_V1 } from "./pricing";
import { InMemoryRedisLike } from "./test-doubles";

/**
 * AC2.5：`reserve`/`settle` 幂等（同一 `request_id` 重复结算只计一次）。
 * AC2.6：价格版本变更后旧阈值被拒绝。
 * AC2.8：月度累计达到阈值；自然月切换或人工调预算版本后恢复。
 * AC2.11：只读月度累计用量。
 */

const T0 = Date.parse("2026-10-08T12:00:00.000Z");
const threshold = deriveBudgetThreshold(PRICE_VERSION_V1, FX_VERSION_V1);
const current = { currentPriceVersion: PRICE_VERSION_V1, currentFxVersion: FX_VERSION_V1 };

describe("费用预留与结算幂等", () => {
  it("同一 request_id 重复预留只计一次", async () => {
    const redis = new InMemoryRedisLike();
    const first = await reserveBudget(redis, {
      threshold,
      nowMs: T0,
      requestId: "req-1",
      amountCny: 5,
      ...current,
    });
    const again = await reserveBudget(redis, {
      threshold,
      nowMs: T0,
      requestId: "req-1",
      amountCny: 5,
      ...current,
    });
    expect(first).toEqual({ ok: true, totalCny: 5, capCny: 30 });
    expect(again).toEqual({ ok: true, totalCny: 5, capCny: 30 });
  });

  it("同一 request_id 重复结算只计一次（第二次 applied=false）", async () => {
    const redis = new InMemoryRedisLike();
    await reserveBudget(redis, {
      threshold,
      nowMs: T0,
      requestId: "req-1",
      amountCny: 5,
      ...current,
    });
    const settled = await settleBudget(redis, {
      threshold,
      nowMs: T0,
      requestId: "req-1",
      actualCny: 3,
    });
    const settledAgain = await settleBudget(redis, {
      threshold,
      nowMs: T0,
      requestId: "req-1",
      actualCny: 3,
    });
    expect(settled).toEqual({ totalCny: 3, applied: true });
    expect(settledAgain).toEqual({ totalCny: 3, applied: false });
  });

  it("超过上限的预留被拒绝（cap_exceeded）", async () => {
    const redis = new InMemoryRedisLike();
    const result = await reserveBudget(redis, {
      threshold,
      nowMs: T0,
      requestId: "req-big",
      amountCny: 31,
      ...current,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("必须失败");
    expect(result.reason).toBe("cap_exceeded");
    expect(reserveFailureErrorCode(result.reason)).toBe("BUDGET_EXCEEDED");
  });

  it("阈值过期即拒绝（stale_threshold），不得沿用旧阈值", async () => {
    const redis = new InMemoryRedisLike();
    const result = await reserveBudget(redis, {
      threshold,
      nowMs: T0,
      requestId: "req-1",
      amountCny: 1,
      currentPriceVersion: "PRICE_2026_V2",
      currentFxVersion: FX_VERSION_V1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("必须失败");
    expect(result.reason).toBe("stale_threshold");
    expect(reserveFailureErrorCode(result.reason)).toBe("CONTROL_PLANE_UNAVAILABLE");
  });
});

describe("月度累计与 L2 恢复", () => {
  it("累计达到 30 元上限后账本封顶", async () => {
    const redis = new InMemoryRedisLike();
    await reserveBudget(redis, { threshold, nowMs: T0, requestId: "a", amountCny: 20, ...current });
    await reserveBudget(redis, { threshold, nowMs: T0, requestId: "b", amountCny: 10, ...current });
    const blocked = await reserveBudget(redis, {
      threshold,
      nowMs: T0,
      requestId: "c",
      amountCny: 1,
      ...current,
    });
    expect(blocked.ok).toBe(false);
  });

  it("自然月切换后恢复：新月份账本从 0 开始", async () => {
    const redis = new InMemoryRedisLike();
    await reserveBudget(redis, { threshold, nowMs: T0, requestId: "a", amountCny: 30, ...current });
    const nextMonth = Date.parse("2026-11-01T00:00:00.000Z");
    expect(budgetLedgerKey(threshold, nextMonth)).not.toBe(budgetLedgerKey(threshold, T0));
    const restored = await reserveBudget(redis, {
      threshold,
      nowMs: nextMonth,
      requestId: "b",
      amountCny: 5,
      ...current,
    });
    expect(restored).toEqual({ ok: true, totalCny: 5, capCny: 30 });
  });

  it("人工调预算版本后恢复：换命名空间，旧账本不计入", async () => {
    const redis = new InMemoryRedisLike();
    await reserveBudget(redis, { threshold, nowMs: T0, requestId: "a", amountCny: 30, ...current });
    const nextThreshold = { ...threshold, price_version: "PRICE_2026_V2" };
    expect(budgetLedgerKey(nextThreshold, T0)).not.toBe(budgetLedgerKey(threshold, T0));
    const restored = await reserveBudget(redis, {
      threshold: nextThreshold,
      nowMs: T0,
      requestId: "b",
      amountCny: 5,
      currentPriceVersion: "PRICE_2026_V2",
      currentFxVersion: FX_VERSION_V1,
    });
    expect(restored).toEqual({ ok: true, totalCny: 5, capCny: 30 });
  });
});

describe("只读月度用量（AC2.11）", () => {
  it("读取累计用量，且不写入、不改变账本", async () => {
    const redis = new InMemoryRedisLike();
    await reserveBudget(redis, { threshold, nowMs: T0, requestId: "a", amountCny: 7, ...current });
    const before = redis.calls.budgetReserve;
    const usage = await readMonthlyUsage(redis, { threshold, nowMs: T0 });
    expect(usage).toEqual({
      month: "2026-10",
      used_cny: 7,
      cap_cny: 30,
      price_version: PRICE_VERSION_V1,
      fx_version: FX_VERSION_V1,
    });
    expect(redis.calls.budgetReserve).toBe(before);
    expect(monthStamp(T0)).toBe("2026-10");
  });
});
