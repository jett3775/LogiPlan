import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Redis } from "@upstash/redis";
import { afterAll, describe, expect, it } from "vitest";

import { L1CircuitBreaker, L1_WINDOW_MS } from "./circuit-breaker";
import type {
  BudgetReserveOutcome,
  BudgetSettleOutcome,
  CircuitSnapshot,
  RedisLike,
  SlidingWindowOutcome,
} from "./redis-like";
import { UpstashRedisLike } from "./upstash-redis";

/**
 * **跨实例 L1 熔断一致性**（本项核心验收）——打真实 Upstash Redis。
 *
 * 复现的缺陷：L1 状态原先存在**进程内存**里，`L1CircuitBreaker` 只承载单进程计数。于是
 * Vercel serverless 的冷启动 / 横向扩容会产生独立实例，L1 计数不跨实例共享——「同一角色
 * 5 分钟窗口内连续 5 次」在跨实例时失效，熔断闸形同虚设。
 *
 * 本文件构造**两个相互独立**的客户端 / breaker（模拟实例 A / 实例 B）共享同一 Redis，
 * 断言：A 记录的连续故障对 B **可见**；第 4 次不触发、第 5 次触发打开；半开与成功闭合跨
 * 实例可见；键的 TTL 存在；且**同一毫秒的并发故障不漏计数**（唯一成员机制）。
 *
 * 门控：**同时**要求显式 opt-in `LOGIPLAN_UPSTASH_INTEGRATION=1` 与真实凭据，避免日常
 * `pnpm test` 自动联网；跳过原因写在 describe 名称里。
 *
 * 隔离：只使用测试专用前缀 `logiplan-test-<random>:*` 的键，跑完清理，绝不触碰生产键。
 * 本文件不打印任何凭据值。
 */

// 仓库根 `.env`（若存在）在本地提供凭据；不覆盖已显式设置的环境变量，不打印任何值。
const envFile = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // `.env` 不可读时忽略：此时凭据缺失，用例照常跳过。
  }
}

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
const enabled =
  process.env.LOGIPLAN_UPSTASH_INTEGRATION === "1" &&
  typeof url === "string" &&
  url.length > 0 &&
  typeof token === "string" &&
  token.length > 0;

const SKIP_REASON =
  "requires LOGIPLAN_UPSTASH_INTEGRATION=1 plus UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN (real Upstash REST); skipped so default `pnpm test` never hits the network";

const ROLE = "management_analysis" as const;

/**
 * 用例超时：本文件每个用例都要对**远端** Upstash 做多次串行往返（最重用例 17 次），
 * 经本机代理实测约 **7.2 s**，超过 vitest 默认的 5 s。放宽到 60 s 既留足网络抖动余量，
 * 又仍能把「真的挂起」判为失败。
 */
const INTEGRATION_TIMEOUT_MS = 60_000;

/** 在真实键前加测试专用前缀，保证不触碰任何生产键。 */
class PrefixedRedisLike implements RedisLike {
  readonly #inner: RedisLike;
  readonly #prefix: string;

  constructor(inner: RedisLike, prefix: string) {
    this.#inner = inner;
    this.#prefix = prefix;
  }

  #k(key: string): string {
    return `${this.#prefix}:${key}`;
  }

  slidingWindow(
    key: string,
    member: string,
    nowMs: number,
    windowMs: number,
    limit: number,
  ): Promise<SlidingWindowOutcome> {
    return this.#inner.slidingWindow(this.#k(key), member, nowMs, windowMs, limit);
  }
  budgetReserve(
    key: string,
    requestId: string,
    amountCny: number,
    capCny: number,
  ): Promise<BudgetReserveOutcome> {
    return this.#inner.budgetReserve(this.#k(key), requestId, amountCny, capCny);
  }
  budgetSettle(key: string, requestId: string, actualCny: number): Promise<BudgetSettleOutcome> {
    return this.#inner.budgetSettle(this.#k(key), requestId, actualCny);
  }
  budgetRead(key: string): Promise<number | null> {
    return this.#inner.budgetRead(this.#k(key));
  }
  circuitRead(key: string, nowMs: number, windowMs: number): Promise<CircuitSnapshot> {
    return this.#inner.circuitRead(this.#k(key), nowMs, windowMs);
  }
  circuitRecordFailure(
    key: string,
    nowMs: number,
    windowMs: number,
    threshold: number,
  ): Promise<void> {
    return this.#inner.circuitRecordFailure(this.#k(key), nowMs, windowMs, threshold);
  }
  circuitRecordSuccess(key: string): Promise<void> {
    return this.#inner.circuitRecordSuccess(this.#k(key));
  }
}

/** 需要清理的测试键（含前缀）。 */
const keysToDelete: string[] = [];

const cleanupClient = enabled ? new Redis({ url: url as string, token: token as string }) : null;

afterAll(async () => {
  if (cleanupClient === null || keysToDelete.length === 0) return;
  await cleanupClient.del(...keysToDelete);
});

interface Instance {
  readonly prefix: string;
  readonly raw: Redis;
  readonly breaker: L1CircuitBreaker;
}

const newPrefix = (): string =>
  `logiplan-test-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

/** 一对**相互独立**的实例（各自客户端），共享同一 Redis 与同一测试键前缀。 */
const newPair = (): { prefix: string; a: Instance; b: Instance; raw: Redis } => {
  const prefix = newPrefix();
  for (const suffix of ["failures", "opened", "seq"]) {
    keysToDelete.push(`${prefix}:circuit:${ROLE}:${suffix}`);
  }
  const make = (): Instance => {
    const raw = new Redis({ url: url as string, token: token as string });
    const breaker = new L1CircuitBreaker(new PrefixedRedisLike(new UpstashRedisLike(raw), prefix));
    return { prefix, raw, breaker };
  };
  const a = make();
  const b = make();
  return { prefix, a, b, raw: a.raw };
};

describe.skipIf(!enabled)(
  `L1 circuit breaker cross-instance consistency on real Upstash Redis (${SKIP_REASON})`,
  () => {
    const T0 = Date.parse("2026-10-08T12:00:00.000Z");

    it(
      "A 的连续故障对 B 可见：第 4 次不触发、第 5 次跨实例触发打开，且键有 TTL",
      { timeout: INTEGRATION_TIMEOUT_MS },
      async () => {
        const { prefix, a, b, raw } = newPair();

        for (let attempt = 1; attempt <= 4; attempt += 1) {
          await a.breaker.recordTransientFailure(ROLE, T0);
          expect((await a.breaker.read(ROLE, T0)).state, `A 第 ${attempt} 次`).toBe("closed");
          // B 独立读同一存储 → 看到 A 写入的计数。
          const observed = await b.breaker.read(ROLE, T0);
          expect(observed.failures, `B 观测第 ${attempt} 次`).toBe(attempt);
          expect(observed.state, `B 第 ${attempt} 次`).toBe("closed");
        }

        await a.breaker.recordTransientFailure(ROLE, T0);
        expect((await a.breaker.read(ROLE, T0)).state).toBe("open");
        expect((await b.breaker.read(ROLE, T0)).state).toBe("open");
        expect(await b.breaker.canAttempt(ROLE, T0)).toBe(false);

        // TTL 必须存在（按窗口长度量级），避免永久残留。
        expect(await raw.pttl(`${prefix}:circuit:${ROLE}:opened`)).toBeGreaterThan(0);
        expect(await raw.pttl(`${prefix}:circuit:${ROLE}:failures`)).toBeGreaterThan(0);
      },
    );

    it("窗口滑出后半开、成功闭合，均跨实例可见", { timeout: INTEGRATION_TIMEOUT_MS }, async () => {
      const { a, b } = newPair();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await a.breaker.recordTransientFailure(ROLE, T0);
      }
      const halfOpenAt = T0 + L1_WINDOW_MS;
      expect((await b.breaker.read(ROLE, halfOpenAt)).state).toBe("half_open");
      expect(await b.breaker.canAttempt(ROLE, halfOpenAt)).toBe(true);
      expect((await a.breaker.read(ROLE, halfOpenAt)).state).toBe("half_open");

      // B 探测成功 → A 也读到闭合、计数清零。
      await b.breaker.recordSuccess(ROLE);
      const after = await a.breaker.read(ROLE, halfOpenAt);
      expect(after.state).toBe("closed");
      expect(after.failures).toBe(0);
    });

    it(
      "半开探测失败重新打开，跨实例可见（重置为单次）",
      { timeout: INTEGRATION_TIMEOUT_MS },
      async () => {
        const { a, b } = newPair();
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await a.breaker.recordTransientFailure(ROLE, T0);
        }
        const halfOpenAt = T0 + L1_WINDOW_MS;
        await b.breaker.recordTransientFailure(ROLE, halfOpenAt);
        const observed = await a.breaker.read(ROLE, halfOpenAt);
        expect(observed.state).toBe("open");
        expect(observed.failures).toBe(1);
      },
    );

    it(
      "同一毫秒的并发故障不漏计数（唯一成员机制）",
      { timeout: INTEGRATION_TIMEOUT_MS },
      async () => {
        const { a, b } = newPair();
        // 五个故障**同一 nowMs**、来自两个独立实例并发触发。
        await Promise.all([
          a.breaker.recordTransientFailure(ROLE, T0),
          b.breaker.recordTransientFailure(ROLE, T0),
          a.breaker.recordTransientFailure(ROLE, T0),
          b.breaker.recordTransientFailure(ROLE, T0),
          a.breaker.recordTransientFailure(ROLE, T0),
        ]);
        const snapshot = await a.breaker.read(ROLE, T0);
        // 若成员只用 `now`，ZSET 成员唯一性会把 5 次折叠成 1 次（漏计数）。
        expect(snapshot.failures).toBe(5);
        expect(snapshot.state).toBe("open");
      },
    );

    it(
      "压测：100 次同毫秒并发故障跨两实例不漏计数，且墙钟在合理上界内",
      { timeout: INTEGRATION_TIMEOUT_MS },
      async () => {
        const { a, b } = newPair();
        const CONCURRENCY = 100;
        const startedAt = Date.now();
        await Promise.all(
          Array.from({ length: CONCURRENCY }, (_, index) =>
            index % 2 === 0
              ? a.breaker.recordTransientFailure(ROLE, T0)
              : b.breaker.recordTransientFailure(ROLE, T0),
          ),
        );
        const elapsedMs = Date.now() - startedAt;
        const snapshot = await a.breaker.read(ROLE, T0);
        // 唯一成员机制下 100 次同毫秒并发必须**全部**计入（成员只用 `now` 会被折叠成 1 次）。
        expect(snapshot.failures).toBe(CONCURRENCY);
        expect(snapshot.state).toBe("open");
        // 只做**宽松上界**的健全性检查（不把远端网络抖动变成红灯）；实测墙钟另行记录在
        // `docs/current-plan.md` §10.4，供后续对比，不作为断言。
        expect(elapsedMs).toBeLessThan(INTEGRATION_TIMEOUT_MS);
      },
    );
  },
);
