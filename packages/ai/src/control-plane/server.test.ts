import { describe, expect, it } from "vitest";

import {
  CONTROL_PLANE_TIMEOUT_MS,
  evaluateControlPlane,
  recordProviderAttemptOutcome,
  type ControlPlaneRequest,
} from "./control-plane";
import { createControlPlaneFromEnvironment } from "./server";
import { FixedClock, InMemoryRedisLike } from "./test-doubles";

/**
 * P1-2：L1 熔断的**装配级**验证。走 `createControlPlaneFromEnvironment`（而非直接 new 类），
 * 复现路由「每请求装配」的调用形态，断言 L1 计数**跨请求累计**（第 4 次不触发、第 5 次触发）。
 *
 * 修复前 `createControlPlaneFromEnvironment` 每次 `new L1CircuitBreaker()`，本文件的
 * 「进程级单例」与「集成级 AC2.7」两条用例都会失败（见报告中的临时回退验证）。
 */

const T0 = Date.parse("2026-10-08T12:00:00.000Z");
const ENV = { LOGIPLAN_AI_ANON_SECRET: "test-secret" } as const;
const CREDS_ENV = {
  LOGIPLAN_AI_ANON_SECRET: "test-secret",
  UPSTASH_REDIS_REST_URL: "https://example.invalid",
  UPSTASH_REDIS_REST_TOKEN: "token",
} as const;

const request = (overrides: Partial<ControlPlaneRequest> = {}): ControlPlaneRequest => ({
  request_id: "req",
  role: "management_analysis",
  rawIp: "203.0.113.7",
  userAgent: "LogiPlanTest/1.0",
  ...overrides,
});

describe("控制面装配（服务端入口 @logiplan/ai/server）", () => {
  it("缺主密钥 → null（失败关闭由调用方处理）", async () => {
    expect(await createControlPlaneFromEnvironment({})).toBeNull();
  });

  it("缺 Redis 凭据 → null", async () => {
    expect(await createControlPlaneFromEnvironment(ENV)).toBeNull();
  });

  it("注入 Redis 与时钟时可装配，且控制面超时为固定常量", async () => {
    const runtime = await createControlPlaneFromEnvironment(ENV, {
      redis: new InMemoryRedisLike(),
      clock: new FixedClock(T0),
      environmentName: "test",
    });
    expect(runtime).not.toBeNull();
    expect(runtime?.config.controlPlaneTimeoutMs).toBe(CONTROL_PLANE_TIMEOUT_MS);
    const decision = await evaluateControlPlane(runtime!.deps, runtime!.config, request());
    expect(decision.liveCallPermitted).toBe(true);
  });

  it("进程级单例：同一 Redis 复用同一运行时（L1 状态跨请求保留）", async () => {
    const redis = new InMemoryRedisLike();
    const clock = new FixedClock(T0);
    const first = await createControlPlaneFromEnvironment(ENV, {
      redis,
      clock,
      environmentName: "test",
    });
    const second = await createControlPlaneFromEnvironment(ENV, {
      redis,
      clock,
      environmentName: "test",
    });
    expect(first).not.toBeNull();
    expect(first).toBe(second);
    expect(first?.deps.breaker).toBe(second?.deps.breaker);
  });

  it("未注入 Redis 时也复用同一运行时（生产路径单例，且不构造客户端）", async () => {
    const first = await createControlPlaneFromEnvironment(CREDS_ENV);
    const second = await createControlPlaneFromEnvironment(CREDS_ENV);
    expect(first).not.toBeNull();
    expect(first).toBe(second);
  });

  it("集成级 AC2.7：装配后的控制面跨请求累计 L1，第 4 次不触发、第 5 次触发", async () => {
    const redis = new InMemoryRedisLike();
    const clock = new FixedClock(T0);
    const role = "management_analysis";
    // 每次请求都重新装配（复现路由形态）；单例使 L1 状态跨请求保留。
    const assemble = (): Promise<Awaited<ReturnType<typeof createControlPlaneFromEnvironment>>> =>
      createControlPlaneFromEnvironment(ENV, { redis, clock, environmentName: "test" });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const runtime = await assemble();
      if (runtime === null) throw new Error("runtime 必须可装配");
      recordProviderAttemptOutcome(runtime, role, "PROVIDER_TIMEOUT");
      const decision = await evaluateControlPlane(
        runtime.deps,
        runtime.config,
        request({ request_id: `req-${attempt}` }),
      );
      expect(decision.liveCallPermitted, `第 ${attempt} 次不得触发熔断`).toBe(true);
    }

    const runtime = await assemble();
    if (runtime === null) throw new Error("runtime 必须可装配");
    recordProviderAttemptOutcome(runtime, role, "PROVIDER_TIMEOUT");
    const blocked = await evaluateControlPlane(
      runtime.deps,
      runtime.config,
      request({ request_id: "req-5" }),
    );
    expect(blocked.liveCallPermitted).toBe(false);
    expect(blocked.errorCode).toBe("PROVIDER_UNAVAILABLE");
    expect(blocked.audit.circuit_state).toBe("open");
  });
});
