import { describe, expect, it } from "vitest";

import { readMonthlyUsage, reserveBudget, settleBudget } from "./control-plane/budget-ledger";
import { createControlPlaneFromEnvironment } from "./control-plane/server";
import { FixedClock, InMemoryRedisLike } from "./control-plane/test-doubles";
import {
  MONTHLY_USAGE_FIELDS,
  renderMonthlyUsageReport,
  runReadMonthlyUsage,
  USAGE_UNAVAILABLE_MESSAGE_ZH,
} from "./read-monthly-usage";

/**
 * AC2.11：只读 CLI 的行为验证。全部用内存替身（`test-doubles`），**不依赖真实 Upstash**。
 *
 * 覆盖：① 读到的用量与账本一致；② 读操作不写 Redis、不改变熔断状态；③ 缺主密钥 / 缺
 * Redis 凭据走受控失败且文案固定、不含凭据；④ 报告字段集合稳定（恰五字段）。
 */

const T0 = Date.parse("2026-10-08T12:00:00.000Z");
const ENV = { LOGIPLAN_AI_ANON_SECRET: "test-secret" } as const;
const ROLE = "management_analysis" as const;

describe("只读月度用量 CLI（AC2.11）", () => {
  it("读到的用量与账本一致；读操作不写 Redis、不改变熔断状态", async () => {
    const redis = new InMemoryRedisLike();
    const clock = new FixedClock(T0);
    const options = { redis, clock, environmentName: "test" } as const;
    const runtime = await createControlPlaneFromEnvironment(ENV, options);
    if (runtime === null) throw new Error("runtime 必须可装配");
    const { threshold, currentPriceVersion, currentFxVersion } = runtime.config;

    // 先把账本种到一个非零值（预留 5 元 → 结算为 3.5 元）。
    const reserved = await reserveBudget(redis, {
      threshold,
      nowMs: T0,
      requestId: "seed-1",
      amountCny: 5,
      currentPriceVersion,
      currentFxVersion,
    });
    expect(reserved.ok).toBe(true);
    const settled = await settleBudget(redis, {
      threshold,
      nowMs: T0,
      requestId: "seed-1",
      actualCny: 3.5,
    });
    expect(settled.applied).toBe(true);

    // 把熔断器推到「打开」，随后断言只读操作不会改变它。
    for (let attempt = 0; attempt < 5; attempt += 1) {
      runtime.deps.breaker.recordTransientFailure(ROLE, T0);
    }
    expect(runtime.deps.breaker.state(ROLE, T0)).toBe("open");

    const callsBefore = { ...redis.calls };
    const outcome = await runReadMonthlyUsage(ENV, options);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.usage.used_cny).toBe(3.5);
    expect(outcome.usage.cap_cny).toBe(threshold.monthly_budget_cny);
    expect(outcome.usage.month).toBe("2026-10");
    expect(outcome.usage.price_version).toBe(threshold.price_version);
    expect(outcome.usage.fx_version).toBe(threshold.fx_version);

    // 只读：`runReadMonthlyUsage` 只多了一次 budgetRead，且没有任何写调用。
    expect(redis.calls.budgetRead).toBe(callsBefore.budgetRead + 1);
    expect(redis.calls.budgetReserve).toBe(callsBefore.budgetReserve);
    expect(redis.calls.budgetSettle).toBe(callsBefore.budgetSettle);
    expect(redis.calls.slidingWindow).toBe(callsBefore.slidingWindow);

    // 熔断状态保持不变（只读操作不触碰熔断器）。
    expect(runtime.deps.breaker.state(ROLE, T0)).toBe("open");

    // 与「独立读取同一账本」完全一致（置于只读断言之后，避免污染调用计数）。
    const direct = await readMonthlyUsage(redis, { threshold, nowMs: T0 });
    expect(outcome.usage).toEqual(direct);
  });

  it("缺主密钥 → 受控失败，文案固定且不含凭据", async () => {
    const outcome = await runReadMonthlyUsage({});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message_zh).toBe(USAGE_UNAVAILABLE_MESSAGE_ZH);
  });

  it("缺 Redis 凭据（有主密钥、未注入 redis）→ 受控失败，不回显任何凭据", async () => {
    const secret = "super-secret-value";
    const outcome = await runReadMonthlyUsage({ LOGIPLAN_AI_ANON_SECRET: secret });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message_zh).toBe(USAGE_UNAVAILABLE_MESSAGE_ZH);
    expect(outcome.message_zh).not.toContain(secret);
  });

  it("报告字段集合稳定（恰为五个字段，不多不少）", () => {
    const report = renderMonthlyUsageReport({
      month: "2026-10",
      used_cny: 3.5,
      cap_cny: 30,
      price_version: "v1",
      fx_version: "v1",
    });
    expect(Object.keys(JSON.parse(report) as Record<string, unknown>)).toEqual([
      ...MONTHLY_USAGE_FIELDS,
    ]);
    expect(JSON.parse(report)).toEqual({
      month: "2026-10",
      used_cny: 3.5,
      cap_cny: 30,
      price_version: "v1",
      fx_version: "v1",
    });
    expect(report).not.toContain("\n");
  });
});
