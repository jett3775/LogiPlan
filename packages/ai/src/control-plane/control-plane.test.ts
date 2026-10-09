import { describe, expect, it } from "vitest";

import { L1CircuitBreaker } from "./circuit-breaker";
import {
  CONTROL_PLANE_TIMEOUT_MS,
  DEFAULT_ROLE_COST_PROFILES,
  evaluateControlPlane,
  type ControlPlaneClock,
  type ControlPlaneConfig,
  type ControlPlaneDeps,
  type ControlPlaneRequest,
} from "./control-plane";
import { reserveBudget } from "./budget-ledger";
import { deriveBudgetThreshold, FX_VERSION_V1, PRICE_VERSION_V1 } from "./pricing";
import { RATE_LIMIT_WINDOW_MS } from "./rate-limit";
import {
  FailingRedisLike,
  FixedClock,
  HangingRedisLike,
  InMemoryRedisLike,
  MalformedRedisLike,
} from "./test-doubles";

/**
 * AC2.3：Upstash 不可用 / 超时 / 返回不确定状态 → **失败关闭**。
 * AC2.4：限流命中 → 不调用、回落固定示例。
 * AC2.1（编排侧）：审计记录中搜不到原始 IP 与完整 UA。
 * AC2.8（编排侧）：L2 关闭**全部**角色。
 */

const T0 = Date.parse("2026-10-08T12:00:00.000Z");
const RAW_IP = "203.0.113.7";
const RAW_UA = "Mozilla/5.0 (Windows NT 10.0) LogiPlanTest/1.0";

const threshold = deriveBudgetThreshold(PRICE_VERSION_V1, FX_VERSION_V1);

const makeConfig = (overrides: Partial<ControlPlaneConfig> = {}): ControlPlaneConfig => ({
  environment: "test",
  secret: "test-secret",
  threshold,
  currentPriceVersion: PRICE_VERSION_V1,
  currentFxVersion: FX_VERSION_V1,
  rateLimitWindowMs: RATE_LIMIT_WINDOW_MS,
  rateLimitLimit: 2,
  // 用生产同款超时，避免把 Web Crypto 派生在负载下的抖动误判为控制面超时；
  // 只有专门的超时用例才把该值调小。
  controlPlaneTimeoutMs: CONTROL_PLANE_TIMEOUT_MS,
  roleCostProfiles: DEFAULT_ROLE_COST_PROFILES,
  ...overrides,
});

const makeDeps = (
  redis: ControlPlaneDeps["redis"],
  clock: ControlPlaneClock = new FixedClock(T0),
): ControlPlaneDeps => ({
  redis,
  breaker: new L1CircuitBreaker(),
  clock,
});

const request = (overrides: Partial<ControlPlaneRequest> = {}): ControlPlaneRequest => ({
  request_id: "req-1",
  role: "management_analysis",
  rawIp: RAW_IP,
  userAgent: RAW_UA,
  ...overrides,
});

describe("控制面失败关闭（AC2.3 / AC2.4）", () => {
  it("全部环节通过时允许真实调用（切片 2 不发起调用）", async () => {
    const decision = await evaluateControlPlane(
      makeDeps(new InMemoryRedisLike()),
      makeConfig(),
      request(),
    );
    expect(decision.liveCallPermitted).toBe(true);
    expect(decision.errorCode).toBeNull();
    expect(decision.audit.fell_back_to_fixed_example).toBe(false);
  });

  it("限流命中 → RATE_LIMITED（回落固定示例）", async () => {
    const deps = makeDeps(new InMemoryRedisLike());
    const config = makeConfig({ rateLimitLimit: 2 });
    expect(
      (await evaluateControlPlane(deps, config, request({ request_id: "a" }))).liveCallPermitted,
    ).toBe(true);
    expect(
      (await evaluateControlPlane(deps, config, request({ request_id: "b" }))).liveCallPermitted,
    ).toBe(true);
    const blocked = await evaluateControlPlane(deps, config, request({ request_id: "c" }));
    expect(blocked.liveCallPermitted).toBe(false);
    expect(blocked.errorCode).toBe("RATE_LIMITED");
    expect(blocked.audit.fell_back_to_fixed_example).toBe(true);
  });

  it("L1 熔断打开 → PROVIDER_UNAVAILABLE", async () => {
    const deps = makeDeps(new InMemoryRedisLike());
    for (let count = 0; count < 5; count += 1) {
      deps.breaker.recordTransientFailure("management_analysis", T0);
    }
    const decision = await evaluateControlPlane(deps, makeConfig(), request());
    expect(decision.liveCallPermitted).toBe(false);
    expect(decision.errorCode).toBe("PROVIDER_UNAVAILABLE");
    expect(decision.audit.circuit_state).toBe("open");
  });

  it("L2 预算耗尽 → 关闭全部角色（BUDGET_EXCEEDED + L2_OPEN）", async () => {
    const redis = new InMemoryRedisLike();
    await reserveBudget(redis, {
      threshold,
      nowMs: T0,
      requestId: "seed",
      amountCny: 30,
      currentPriceVersion: PRICE_VERSION_V1,
      currentFxVersion: FX_VERSION_V1,
    });
    const deps = makeDeps(redis);
    const config = makeConfig();
    for (const role of ["intent_parse", "management_analysis", "fallback"] as const) {
      const decision = await evaluateControlPlane(
        deps,
        config,
        request({ role, request_id: `r-${role}` }),
      );
      expect(decision.liveCallPermitted, role).toBe(false);
      expect(decision.errorCode, role).toBe("BUDGET_EXCEEDED");
      expect(decision.audit.circuit_state, role).toBe("L2_OPEN");
    }
  });

  it("存储连接失败 → CONTROL_PLANE_UNAVAILABLE", async () => {
    const decision = await evaluateControlPlane(
      makeDeps(new FailingRedisLike()),
      makeConfig(),
      request(),
    );
    expect(decision.liveCallPermitted).toBe(false);
    expect(decision.errorCode).toBe("CONTROL_PLANE_UNAVAILABLE");
  });

  it("存储超时 → CONTROL_PLANE_UNAVAILABLE", async () => {
    const decision = await evaluateControlPlane(
      makeDeps(new HangingRedisLike()),
      makeConfig({ controlPlaneTimeoutMs: 30 }),
      request(),
    );
    expect(decision.liveCallPermitted).toBe(false);
    expect(decision.errorCode).toBe("CONTROL_PLANE_UNAVAILABLE");
  });

  it("存储返回不确定结构 → CONTROL_PLANE_UNAVAILABLE", async () => {
    const decision = await evaluateControlPlane(
      makeDeps(new MalformedRedisLike()),
      makeConfig(),
      request(),
    );
    expect(decision.liveCallPermitted).toBe(false);
    expect(decision.errorCode).toBe("CONTROL_PLANE_UNAVAILABLE");
  });

  it("审计记录中不出现原始 IP 或完整 UA（AC2.1）", async () => {
    const allowed = await evaluateControlPlane(
      makeDeps(new InMemoryRedisLike()),
      makeConfig(),
      request(),
    );
    const serialized = JSON.stringify(allowed.audit).toLowerCase();
    expect(serialized).not.toContain(RAW_IP.toLowerCase());
    expect(serialized).not.toContain("mozilla");
    expect(serialized).not.toContain(RAW_UA.toLowerCase());
  });

  it("注入时钟抛错也被收敛为失败关闭（绝不抛给上层，P2-2）", async () => {
    const throwingClock = {
      now: (): number => {
        throw new Error("clock exploded");
      },
    };
    const decision = await evaluateControlPlane(
      makeDeps(new InMemoryRedisLike(), throwingClock),
      makeConfig(),
      request(),
    );
    expect(decision.liveCallPermitted).toBe(false);
    expect(decision.errorCode).toBe("CONTROL_PLANE_UNAVAILABLE");
  });
});
