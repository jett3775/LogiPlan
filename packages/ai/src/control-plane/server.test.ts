import { describe, expect, it, vi } from "vitest";

import { deriveAnonymousId } from "./anonymous-id";
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
 * 本切片起 L1 状态落在注入的存储（`RedisLike`），装配层只负责把它接上：
 * `createControlPlaneFromEnvironment` 把同一个 Redis 实例传给 `L1CircuitBreaker`，故跨请求
 * 累计由存储保证（生产为 Redis，跨实例一致）。下方「进程级单例」断言仍锁定运行时/配置复用
 * 与主密钥摘要隔离（见 `server.ts`）。
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

  it("进程级单例：同一 Redis 复用同一运行时（配置与客户端跨请求保留）", async () => {
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
      await recordProviderAttemptOutcome(runtime, role, "PROVIDER_TIMEOUT");
      const decision = await evaluateControlPlane(
        runtime.deps,
        runtime.config,
        request({ request_id: `req-${attempt}` }),
      );
      expect(decision.liveCallPermitted, `第 ${attempt} 次不得触发熔断`).toBe(true);
    }

    const runtime = await assemble();
    if (runtime === null) throw new Error("runtime 必须可装配");
    await recordProviderAttemptOutcome(runtime, role, "PROVIDER_TIMEOUT");
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

/**
 * 阶段 1：运行时缓存键必须含**当前主密钥的不可逆摘要**——同 Redis 下换主密钥必须产生
 * 新运行时（匿名派生改用新密钥），同 Redis 同密钥必须复用（L1 跨请求累计），且只保留
 * 「当前密钥」的条目（替换而非嵌套，不随历史密钥无限增长）。
 *
 * 修复前 `runtimeByRedis` 只按 Redis 实例做键：本文件的「换主密钥」与「替换语义」两条
 * 用例都会失败（见报告中的临时回退验证）。
 */
describe("运行时缓存按主密钥摘要隔离（阶段 1）", () => {
  const envWithSecret = (secret: string): Record<string, string | undefined> => ({
    LOGIPLAN_AI_ANON_SECRET: secret,
  });

  it("同 Redis + 换主密钥 → 产生新运行时，且匿名派生改用新密钥", async () => {
    const redis = new InMemoryRedisLike();
    const clock = new FixedClock(T0);
    const first = await createControlPlaneFromEnvironment(envWithSecret("secret-a"), {
      redis,
      clock,
      environmentName: "test",
    });
    const rotated = await createControlPlaneFromEnvironment(envWithSecret("secret-b"), {
      redis,
      clock,
      environmentName: "test",
    });
    expect(first).not.toBeNull();
    expect(rotated).not.toBeNull();
    // 修复前：只按 Redis 做键 → 命中旧条目，返回同一（旧密钥）运行时。
    expect(rotated).not.toBe(first);
    expect(rotated?.deps.breaker).not.toBe(first?.deps.breaker);

    // 运行时内固化的密钥已切换 → 匿名派生值随之变化。
    const derive = (secret: string): Promise<string> =>
      deriveAnonymousId({
        rawIp: "203.0.113.7",
        userAgent: "LogiPlanTest/1.0",
        secret,
        nowMs: T0,
      });
    const before = await derive(first!.config.secret);
    const after = await derive(rotated!.config.secret);
    expect(after).not.toBe(before);
  });

  it("不同 Redis 实例相互隔离（不共享运行时与 L1 状态）", async () => {
    const clock = new FixedClock(T0);
    const a = await createControlPlaneFromEnvironment(envWithSecret("test-secret"), {
      redis: new InMemoryRedisLike(),
      clock,
      environmentName: "test",
    });
    const b = await createControlPlaneFromEnvironment(envWithSecret("test-secret"), {
      redis: new InMemoryRedisLike(),
      clock,
      environmentName: "test",
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    expect(a?.deps.breaker).not.toBe(b?.deps.breaker);
  });

  it("换密钥后再次使用当前密钥仍复用同一运行时（替换而非每次新建）", async () => {
    const redis = new InMemoryRedisLike();
    const clock = new FixedClock(T0);
    const assemble = (
      secret: string,
    ): Promise<Awaited<ReturnType<typeof createControlPlaneFromEnvironment>>> =>
      createControlPlaneFromEnvironment(envWithSecret(secret), {
        redis,
        clock,
        environmentName: "test",
      });

    const a1 = await assemble("secret-a");
    const b1 = await assemble("secret-b");
    const b2 = await assemble("secret-b"); // 当前密钥再次装配 → 复用 b1
    expect(a1).not.toBeNull();
    expect(b1).not.toBeNull();
    expect(b2).toBe(b1);
    expect(b1).not.toBe(a1);

    // 只保留「当前密钥」的条目：回到旧密钥得到新实例（替换语义，不按历史无限增长）。
    const a2 = await assemble("secret-a");
    expect(a2).not.toBe(a1);
  });
});

/**
 * 其他独立项：生产凭据缓存（`productionRedisByCredentials`）的**容量上限与淘汰**。
 *
 * 修复前该表只增不减、无上限：本文件的「有界」「无孤儿」两条用例都会失败（见报告中的
 * 临时回退验证）。每个用例用 `vi.resetModules()` + 动态 `import("./server")` 取得**全新
 * 模块实例**，使两张缓存表从空开始，计数断言确定、互不干扰。
 */
describe("生产凭据缓存容量上限与淘汰", () => {
  const MAX_CACHED_REDIS_CREDENTIALS = 4;

  const credsEnv = (index: number): Record<string, string | undefined> => ({
    LOGIPLAN_AI_ANON_SECRET: "test-secret",
    UPSTASH_REDIS_REST_URL: `https://example-${index}.invalid`,
    UPSTASH_REDIS_REST_TOKEN: `token-${index}`,
  });

  const freshServer = async (): Promise<typeof import("./server")> => {
    vi.resetModules();
    return import("./server");
  };

  it("超过上限后最旧凭据条目被淘汰，条目数有界", async () => {
    const server = await freshServer();
    const oldest = await server.createControlPlaneFromEnvironment(credsEnv(0));
    expect(oldest).not.toBeNull();
    for (let index = 1; index <= MAX_CACHED_REDIS_CREDENTIALS; index += 1) {
      expect(await server.createControlPlaneFromEnvironment(credsEnv(index))).not.toBeNull();
    }
    // 插入上限 +1 组不同凭据后，凭据表仍被上界约束（最旧的 0 号已被淘汰）。
    expect(server.__controlPlaneCacheCountsForTest().credentials).toBe(
      MAX_CACHED_REDIS_CREDENTIALS,
    );
    // 0 号已淘汰 → 重新装配得到**新**运行时（旧实例不再复用）。
    expect(await server.createControlPlaneFromEnvironment(credsEnv(0))).not.toBe(oldest);
    expect(server.__controlPlaneCacheCountsForTest().credentials).toBe(
      MAX_CACHED_REDIS_CREDENTIALS,
    );
  });

  it("淘汰后两张表一致，不残留孤儿运行时条目", async () => {
    const server = await freshServer();
    for (let index = 0; index <= MAX_CACHED_REDIS_CREDENTIALS; index += 1) {
      expect(await server.createControlPlaneFromEnvironment(credsEnv(index))).not.toBeNull();
    }
    const counts = server.__controlPlaneCacheCountsForTest();
    // 两张表都恰为上限：凭据表被上界约束，运行时表不残留被淘汰凭据的孤儿条目。
    expect(counts.credentials).toBe(MAX_CACHED_REDIS_CREDENTIALS);
    expect(counts.runtimes).toBe(MAX_CACHED_REDIS_CREDENTIALS);
  });

  it("单凭据重复调用不触发淘汰，仍复用同一实例与同一运行时", async () => {
    const server = await freshServer();
    const first = await server.createControlPlaneFromEnvironment(credsEnv(0));
    expect(first).not.toBeNull();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(await server.createControlPlaneFromEnvironment(credsEnv(0))).toBe(first);
    }
    const counts = server.__controlPlaneCacheCountsForTest();
    expect(counts.credentials).toBe(1);
    expect(counts.runtimes).toBe(1);
  });
});
