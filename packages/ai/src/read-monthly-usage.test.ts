import { describe, expect, it, vi } from "vitest";

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
 *
 * 阶段 2 增补：⑤ `budgetRead` 拒绝时也收敛为同一受控失败（不冒泡底层异常），且同样
 * 只读（仅一次 `budgetRead`，零写调用，熔断写入口零调用）。
 */

const T0 = Date.parse("2026-10-08T12:00:00.000Z");
const ENV = { LOGIPLAN_AI_ANON_SECRET: "test-secret" } as const;
const ROLE = "management_analysis" as const;

/**
 * 局部替身（不改共享 `test-doubles.ts`）：沿用 `InMemoryRedisLike` 的调用计数与内存账本，
 * 但让 `budgetRead` **拒绝**——用于验证「读异常 → 受控失败」且不计费 / 不限流。
 */
class RejectingReadRedisLike extends InMemoryRedisLike {
  readonly #error: Error;

  constructor(error: Error) {
    super();
    this.#error = error;
  }

  override budgetRead(_ledgerKey: string): Promise<number | null> {
    this.calls.budgetRead += 1;
    return Promise.reject(this.#error);
  }
}

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

    // 直接观测熔断**写入口**：只读操作必须零调用（排除经 evaluateControlPlane /
    // recordProviderAttemptOutcome 间接改状态——所有状态变更都经这两个入口）。
    const recordSuccessSpy = vi.spyOn(runtime.deps.breaker, "recordSuccess");
    const recordFailureSpy = vi.spyOn(runtime.deps.breaker, "recordTransientFailure");

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
    expect(recordSuccessSpy).not.toHaveBeenCalled();
    expect(recordFailureSpy).not.toHaveBeenCalled();

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

  it("budgetRead 异常 → 受控失败（固定文案、不暴露底层异常），且不计费/不限流/不改熔断", async () => {
    const forgedUrl = "https://forged-upstash.invalid";
    const forgedToken = "forged-token-value";
    const forgedSecret = "forged-master-secret";
    const redis = new RejectingReadRedisLike(
      new Error(`connect ECONNREFUSED ${forgedUrl} token=${forgedToken} secret=${forgedSecret}`),
    );
    const clock = new FixedClock(T0);
    const env = { LOGIPLAN_AI_ANON_SECRET: forgedSecret };
    const options = { redis, clock, environmentName: "test" } as const;
    const runtime = await createControlPlaneFromEnvironment(env, options);
    if (runtime === null) throw new Error("runtime 必须可装配");

    // 阶段 1 保证：同一 redis + 同一 secret → 同一缓存运行时 → 同一 breaker，spy 生效。
    const recordSuccessSpy = vi.spyOn(runtime.deps.breaker, "recordSuccess");
    const recordFailureSpy = vi.spyOn(runtime.deps.breaker, "recordTransientFailure");
    const callsBefore = { ...redis.calls };

    const outcome = await runReadMonthlyUsage(env, options);

    // 修复前：`readMonthlyUsage` 的 rejection 直接冒泡 → 本行抛错，用例失败。
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message_zh).toBe(USAGE_UNAVAILABLE_MESSAGE_ZH);
    // 只含固定文案：不回显伪造的 URL / token / secret，也不透出底层异常文本。
    expect(outcome.message_zh).not.toContain(forgedUrl);
    expect(outcome.message_zh).not.toContain(forgedToken);
    expect(outcome.message_zh).not.toContain(forgedSecret);
    expect(outcome.message_zh).not.toContain("ECONNREFUSED");

    // 只读：仅一次 budgetRead，零写调用。
    expect(redis.calls.budgetRead).toBe(callsBefore.budgetRead + 1);
    expect(redis.calls.budgetReserve).toBe(callsBefore.budgetReserve);
    expect(redis.calls.budgetSettle).toBe(callsBefore.budgetSettle);
    expect(redis.calls.slidingWindow).toBe(callsBefore.slidingWindow);

    // 熔断写入口零调用（排除经 evaluateControlPlane / recordProviderAttemptOutcome 间接改状态）。
    expect(recordSuccessSpy).not.toHaveBeenCalled();
    expect(recordFailureSpy).not.toHaveBeenCalled();
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
