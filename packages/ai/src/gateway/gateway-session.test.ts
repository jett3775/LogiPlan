import { describe, expect, it } from "vitest";

import type { AdapterResult, ProviderAdapter } from "../adapter/adapter-contract";
import type { RedisLike } from "../control-plane/redis-like";
import { L1CircuitBreaker } from "../control-plane/circuit-breaker";
import { reserveBudget } from "../control-plane/budget-ledger";
import {
  CONTROL_PLANE_TIMEOUT_MS,
  DEFAULT_ROLE_COST_PROFILES,
  type ControlPlaneRuntime,
} from "../control-plane/control-plane";
import { deriveBudgetThreshold, FX_VERSION_V1, PRICE_VERSION_V1 } from "../control-plane/pricing";
import { RATE_LIMIT_MAX_PER_WINDOW, RATE_LIMIT_WINDOW_MS } from "../control-plane/rate-limit";
import { FixedClock, InMemoryRedisLike } from "../control-plane/test-doubles";
import { buildFixedExampleAnalysis } from "../fixed-example/fixed-example";
import type { RetryHooks } from "./retry-policy";
import { runGatewaySession } from "./gateway-session";
import {
  adapterReturning,
  adapterThrowing,
  deterministicRetryHooks,
  fakeAdapter,
  fixedExampleEvidenceIds,
  gatewayConfig,
  FIXED_EXAMPLE_SCOPE_ANCHOR,
  fixedExampleWhitelist,
  liveAnalysis,
} from "./gateway-fixtures.test";

/**
 * 端到端会话编排（D-192）：控制面预检 → 网关编排 → 记录尝试结局 → 结算。
 *
 * 六种结局全部用**替身**验证——**零真实调用、零付费、不读取任何密钥**：
 * ① 成功输出；② 预算不足；③ 限流；④ 超时；⑤ 输出越界；⑥ 固定示例回退。
 */

const CLOCK_MS = 1_760_000_000_000; // 固定时刻，使匿名派生与限流窗口可复现

const runtimeWith = (redis: RedisLike, overrides: Partial<ControlPlaneRuntime["config"]> = {}) => {
  const clock = new FixedClock(CLOCK_MS);
  const runtime: ControlPlaneRuntime = {
    deps: { redis, breaker: new L1CircuitBreaker(redis), clock },
    config: {
      environment: "test",
      secret: "test-secret",
      threshold: deriveBudgetThreshold(PRICE_VERSION_V1, FX_VERSION_V1),
      currentPriceVersion: PRICE_VERSION_V1,
      currentFxVersion: FX_VERSION_V1,
      rateLimitWindowMs: RATE_LIMIT_WINDOW_MS,
      rateLimitLimit: RATE_LIMIT_MAX_PER_WINDOW,
      controlPlaneTimeoutMs: CONTROL_PLANE_TIMEOUT_MS,
      roleCostProfiles: DEFAULT_ROLE_COST_PROFILES,
      ...overrides,
    },
  };
  return { runtime, clock };
};

const sessionRequest = (overrides: Record<string, unknown> = {}) => ({
  request_id: "req-session-1",
  role: "management_analysis" as const,
  input: "上个月英国履约变动成本为什么上升？",
  scope_anchor: FIXED_EXAMPLE_SCOPE_ANCHOR,
  evidence: fixedExampleWhitelist(),
  rawIp: "203.0.113.7",
  userAgent: "vitest/1.0",
  ...overrides,
});

/** 统计适配器被调用次数的假适配器包装。 */
const countingAdapter = (
  inner: ProviderAdapter,
): { adapter: ProviderAdapter; calls: () => number } => {
  let calls = 0;
  return {
    adapter: {
      adapterVersion: inner.adapterVersion,
      capabilities: inner.capabilities,
      invoke: (request) => {
        calls += 1;
        return inner.invoke(request);
      },
    },
    calls: () => calls,
  };
};

/** 硬超时钩子：真的调用任务，但一律报告超时（模拟供应商不返回）。 */
const timingOutHooks = (): RetryHooks => ({
  withHardTimeout: async (task) => {
    await task().catch(() => undefined);
    return { timedOut: true };
  },
  backoff: async () => undefined,
});

describe("① 成功输出", () => {
  it("预检放行 + 三检通过 → live，且预留被结算为**实际**成本", async () => {
    const redis = new InMemoryRedisLike();
    const { runtime } = runtimeWith(redis);
    const result = await runGatewaySession(
      {
        config: gatewayConfig(),
        runtime,
        adapter: adapterReturning(liveAnalysis()),
        retryHooks: deterministicRetryHooks(),
      },
      sessionRequest(),
    );

    expect(result.outcome.kind).toBe("live");
    if (result.outcome.kind !== "live") throw new Error("应为 live");
    expect(result.outcome.analysis.answer_type).toBe("LIVE_GENERATED");
    expect(result.preflight?.liveCallPermitted).toBe(true);
    expect(result.record).toBe("recorded");
    expect(result.settlement).toBe("settled");
    // 0.00042 USD → CNY（含安全余量）必然 > 0，且账本被真实写入。
    expect(result.settle_amount_cny).toBeGreaterThan(0);
    expect(redis.calls.budgetSettle).toBe(1);
    expect(redis.calls.circuitRecordSuccess).toBe(1);
  });
});

describe("② 预算不足", () => {
  it("月度账本已达上限 → BUDGET_EXCEEDED，且**零调用、零结算**", async () => {
    const redis = new InMemoryRedisLike();
    const { runtime } = runtimeWith(redis);
    // 先把账本推到接近上限，使本次预留必然超限。
    const seeded = await reserveBudget(redis, {
      threshold: runtime.config.threshold,
      nowMs: CLOCK_MS,
      requestId: "seed-request",
      amountCny: runtime.config.threshold.monthly_budget_cny - 0.01,
      currentPriceVersion: PRICE_VERSION_V1,
      currentFxVersion: FX_VERSION_V1,
    });
    expect(seeded.ok).toBe(true);

    const { adapter, calls } = countingAdapter(adapterReturning(liveAnalysis()));
    const result = await runGatewaySession(
      { config: gatewayConfig(), runtime, adapter, retryHooks: deterministicRetryHooks() },
      sessionRequest(),
    );

    expect(result.outcome.kind).toBe("fallback");
    if (result.outcome.kind !== "fallback") throw new Error("应为 fallback");
    expect(result.outcome.errorCode).toBe("BUDGET_EXCEEDED");
    expect(result.preflight?.liveCallPermitted).toBe(false);
    expect(result.settlement).toBe("not_attempted");
    expect(result.record).toBe("not_attempted");
    expect(calls()).toBe(0);
    expect(redis.calls.budgetSettle).toBe(0);
  });
});

describe("③ 限流", () => {
  it("窗口内超过上限 → RATE_LIMITED，且**零调用、零结算**", async () => {
    const redis = new InMemoryRedisLike();
    const { runtime } = runtimeWith(redis);
    const { adapter, calls } = countingAdapter(adapterReturning(liveAnalysis()));
    const deps = {
      config: gatewayConfig(),
      runtime,
      adapter,
      retryHooks: deterministicRetryHooks(),
    };

    let last = await runGatewaySession(deps, sessionRequest());
    for (let index = 0; index < RATE_LIMIT_MAX_PER_WINDOW; index += 1) {
      last = await runGatewaySession(
        deps,
        sessionRequest({ request_id: `req-session-${index + 2}` }),
      );
    }

    expect(last.outcome.kind).toBe("fallback");
    if (last.outcome.kind !== "fallback") throw new Error("应为 fallback");
    expect(last.outcome.errorCode).toBe("RATE_LIMITED");
    // 前 N 次放行、第 N+1 次被拒：适配器调用次数恰好等于上限。
    expect(calls()).toBe(RATE_LIMIT_MAX_PER_WINDOW);
    expect(last.settlement).toBe("not_attempted");
  });
});

describe("④ 超时", () => {
  it("供应商不返回 → PROVIDER_TIMEOUT，保留预留（不结算）且记入 L1", async () => {
    const redis = new InMemoryRedisLike();
    const { runtime } = runtimeWith(redis);
    const { adapter, calls } = countingAdapter(adapterReturning(liveAnalysis()) as ProviderAdapter);
    const result = await runGatewaySession(
      { config: gatewayConfig(), runtime, adapter, retryHooks: timingOutHooks() },
      sessionRequest(),
    );

    expect(result.outcome.kind).toBe("fallback");
    if (result.outcome.kind !== "fallback") throw new Error("应为 fallback");
    expect(result.outcome.errorCode).toBe("PROVIDER_TIMEOUT");
    expect(calls()).toBe(1);
    expect(result.outcome.spend.responded).toBe(false);
    // 实际花费未知 ⇒ 不结算，预留额留在账本上（宁可多计、不可少计）。
    expect(result.settlement).toBe("not_attempted");
    expect(redis.calls.budgetSettle).toBe(0);
    // 超时属瞬时故障 ⇒ 记入 L1 连续故障计数。
    expect(result.record).toBe("recorded");
    expect(redis.calls.circuitRecordFailure).toBe(1);
  });
});

describe("⑤ 输出越界", () => {
  it("三检不过但供应商**已响应** → 结算为真实成本（不得释放成 0）", async () => {
    const redis = new InMemoryRedisLike();
    const { runtime } = runtimeWith(redis);
    const bogusNumber = liveAnalysis({
      conclusion: {
        ...buildFixedExampleAnalysis().conclusion,
        text: "凭空多出 999,999.9999 CNY 的不利差异。",
      },
    });
    const result = await runGatewaySession(
      {
        config: gatewayConfig(),
        runtime,
        adapter: adapterReturning(bogusNumber),
        retryHooks: deterministicRetryHooks(),
      },
      sessionRequest(),
    );

    expect(result.outcome.kind).toBe("fallback");
    if (result.outcome.kind !== "fallback") throw new Error("应为 fallback");
    expect(result.outcome.errorCode).toBe("NUMERIC_MISMATCH");
    expect(result.outcome.spend.responded).toBe(true);
    expect(result.outcome.spend.cost_usd).toBeGreaterThan(0);
    expect(result.settlement).toBe("settled");
    expect(result.settle_amount_cny).toBeGreaterThan(0);
    expect(redis.calls.budgetSettle).toBe(1);
  });

  it("模式不合法（输出越界）同样回落，且已响应时照样结算", async () => {
    const redis = new InMemoryRedisLike();
    const { runtime } = runtimeWith(redis);
    const result = await runGatewaySession(
      {
        config: gatewayConfig(),
        runtime,
        adapter: adapterReturning({ ...buildFixedExampleAnalysis(), answer_id: "" }),
        retryHooks: deterministicRetryHooks(),
      },
      sessionRequest(),
    );

    expect(result.outcome.kind).toBe("fallback");
    if (result.outcome.kind !== "fallback") throw new Error("应为 fallback");
    expect(result.outcome.errorCode).toBe("SCHEMA_VALIDATION_FAILED");
    expect(result.settlement).toBe("settled");
  });
});

describe("⑥ 固定示例回退", () => {
  it("供应商不可用 → 回落固定示例并记入 L1，但不结算", async () => {
    const redis = new InMemoryRedisLike();
    const { runtime } = runtimeWith(redis);
    const result = await runGatewaySession(
      {
        config: gatewayConfig(),
        runtime,
        adapter: adapterThrowing("PROVIDER_UNAVAILABLE"),
        retryHooks: deterministicRetryHooks(),
      },
      sessionRequest(),
    );

    expect(result.outcome.kind).toBe("fallback");
    if (result.outcome.kind !== "fallback") throw new Error("应为 fallback");
    expect(result.outcome.errorCode).toBe("PROVIDER_UNAVAILABLE");
    expect(result.outcome.analysis.answer_type).toBe("FIXED_EXAMPLE");
    expect(result.outcome.spend.responded).toBe(false);
    expect(result.settlement).toBe("not_attempted");
    expect(redis.calls.budgetSettle).toBe(0);
    expect(redis.calls.circuitRecordFailure).toBe(1);
  });
});

/** 结算写入失败的替身（其余行为与内存替身一致）。 */
class SettleFailingRedis extends InMemoryRedisLike {
  override budgetSettle(): Promise<never> {
    return Promise.reject(new Error("settle storage unavailable"));
  }
}

/** L1 写入失败的替身（其余行为与内存替身一致）。 */
class CircuitWriteFailingRedis extends InMemoryRedisLike {
  override circuitRecordSuccess(): Promise<never> {
    return Promise.reject(new Error("circuit storage unavailable"));
  }

  override circuitRecordFailure(): Promise<never> {
    return Promise.reject(new Error("circuit storage unavailable"));
  }
}

describe("结算与记录的失败方向", () => {
  it("供应商已响应但自报成本非正 → **不**结算，保留预留（不得释放成 0 而少报支出）", async () => {
    const redis = new InMemoryRedisLike();
    const { runtime } = runtimeWith(redis);
    const zeroCostAdapter = fakeAdapter(async (request) => ({
      provider: "openai",
      model: request.model,
      providerRequestId: "resp_zero_cost",
      structuredOutput: liveAnalysis(),
      usage: { inputTokens: 0, outputTokens: 0 },
      finishReason: "stop",
      latencyMs: 3,
      costEstimate: { currency: "USD", amount: 0, priceVersion: PRICE_VERSION_V1 },
    }));
    const result = await runGatewaySession(
      {
        config: gatewayConfig(),
        runtime,
        adapter: zeroCostAdapter,
        retryHooks: deterministicRetryHooks(),
      },
      sessionRequest(),
    );

    expect(result.outcome.kind).toBe("live");
    expect(result.settlement).toBe("not_attempted");
    expect(result.settle_amount_cny).toBe(0);
    expect(redis.calls.budgetSettle).toBe(0);
  });

  it("结算写入失败 → 仍返回已生成的回答，只把结算标记为失败（预留额留在账本上）", async () => {
    const { runtime } = runtimeWith(new SettleFailingRedis());
    const result = await runGatewaySession(
      {
        config: gatewayConfig(),
        runtime,
        adapter: adapterReturning(liveAnalysis()),
        retryHooks: deterministicRetryHooks(),
      },
      sessionRequest(),
    );

    expect(result.outcome.kind).toBe("live");
    expect(result.settlement).toBe("settle_failed");
    expect(result.settle_amount_cny).toBe(0);
  });

  it("L1 记录写入失败 → 仍返回回答，只把记录标记为失败", async () => {
    const { runtime } = runtimeWith(new CircuitWriteFailingRedis());
    const result = await runGatewaySession(
      {
        config: gatewayConfig(),
        runtime,
        adapter: adapterReturning(liveAnalysis()),
        retryHooks: deterministicRetryHooks(),
      },
      sessionRequest(),
    );

    expect(result.outcome.kind).toBe("live");
    expect(result.record).toBe("record_failed");
  });
});

describe("夹具自证", () => {
  it("固定示例白名单里的证据 ID 非空（用例的前置）", () => {
    expect(fixedExampleEvidenceIds().length).toBeGreaterThan(0);
    const adapter: AdapterResult["structuredOutput"] = liveAnalysis();
    expect(adapter).toBeDefined();
  });
});
