import type { Redis } from "@upstash/redis";

import {
  ControlPlaneUnavailableError,
  isBudgetReserveOutcome,
  isBudgetSettleOutcome,
  isSlidingWindowOutcome,
  type BudgetReserveOutcome,
  type BudgetSettleOutcome,
  type RedisLike,
  type SlidingWindowOutcome,
} from "./redis-like";

/**
 * `RedisLike` 的生产实现（docs/gate2-design.md §3.1、D-181）。
 *
 * ## 原子性
 *
 * 每个方法都用**一个** Lua 脚本完成全部读改写，因此计数与判定、预留、结算都是原子的：
 * 并发调用不会超发（AC2.2）。脚本通过 `@upstash/redis` 的 `eval` 执行。
 *
 * ## 本机不可验证
 *
 * **真实 Redis 的并发原子性无法在本机验证**：本机没有 Upstash 凭据、也没有可用的
 * Redis 实例，会话内 `spawnSync`/`execSync` 恒返回 `EBUSY`，无法起容器。因此本文件的
 * Lua 脚本只经过人工审查，未经真实执行；AC2.2 在本机只能由内存替身验证接口形态与
 * 调用方逻辑。切片 3 接入真实凭据后必须补做真实原子性验证。
 *
 * ## 动态导入
 *
 * `@upstash/redis` 用**动态** `import()` 加载，使 `@logiplan/ai` 的 barrel 被浏览器
 * 组件引用时不会把 Redis 客户端静态打进浏览器包；只有服务端调用本工厂时才加载。
 */

const SLIDING_WINDOW_SCRIPT = `
local cutoff = tonumber(ARGV[1]) - tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
local count = redis.call('ZCARD', KEYS[1])
local limit = tonumber(ARGV[3])
if count < limit then
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return {1, count + 1}
end
return {0, count}
`;

const BUDGET_RESERVE_SCRIPT = `
local total = tonumber(redis.call('GET', KEYS[1]) or '0')
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then
  return {1, total, 0}
end
local amount = tonumber(ARGV[2])
local cap = tonumber(ARGV[3])
if total + amount > cap then
  return {0, total, 0}
end
local nextTotal = total + amount
redis.call('SET', KEYS[1], nextTotal)
redis.call('HSET', KEYS[2], ARGV[1], amount)
return {1, nextTotal, 1}
`;

const BUDGET_SETTLE_SCRIPT = `
local total = tonumber(redis.call('GET', KEYS[1]) or '0')
if redis.call('SISMEMBER', KEYS[3], ARGV[1]) == 1 then
  return {total, 0}
end
local reserved = tonumber(redis.call('HGET', KEYS[2], ARGV[1]) or '0')
local actual = tonumber(ARGV[2])
local nextTotal = total - reserved + actual
redis.call('SET', KEYS[1], nextTotal)
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('SADD', KEYS[3], ARGV[1])
return {nextTotal, 1}
`;

const totalKey = (ledgerKey: string): string => `${ledgerKey}:total`;
const reservationsKey = (ledgerKey: string): string => `${ledgerKey}:reservations`;
const settledKey = (ledgerKey: string): string => `${ledgerKey}:settled`;

const asNumber = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneUnavailableError("redis script returned a non-numeric value");
  }
  return parsed;
};

export class UpstashRedisLike implements RedisLike {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async slidingWindow(
    key: string,
    member: string,
    nowMs: number,
    windowMs: number,
    limit: number,
  ): Promise<SlidingWindowOutcome> {
    const raw: unknown = await this.#redis.eval(
      SLIDING_WINDOW_SCRIPT,
      [key],
      [nowMs, windowMs, limit, member],
    );
    if (!Array.isArray(raw) || raw.length < 2) {
      throw new ControlPlaneUnavailableError("sliding window script returned unexpected shape");
    }
    const outcome: SlidingWindowOutcome = {
      allowed: asNumber(raw[0]) === 1,
      count: asNumber(raw[1]),
      limit,
    };
    if (!isSlidingWindowOutcome(outcome)) {
      throw new ControlPlaneUnavailableError("sliding window outcome malformed");
    }
    return outcome;
  }

  async budgetReserve(
    ledgerKey: string,
    requestId: string,
    amountCny: number,
    capCny: number,
  ): Promise<BudgetReserveOutcome> {
    const raw: unknown = await this.#redis.eval(
      BUDGET_RESERVE_SCRIPT,
      [totalKey(ledgerKey), reservationsKey(ledgerKey)],
      [requestId, amountCny, capCny],
    );
    if (!Array.isArray(raw) || raw.length < 3) {
      throw new ControlPlaneUnavailableError("budget reserve script returned unexpected shape");
    }
    const outcome: BudgetReserveOutcome = {
      ok: asNumber(raw[0]) === 1,
      totalCny: asNumber(raw[1]),
      capCny,
      applied: asNumber(raw[2]) === 1,
    };
    if (!isBudgetReserveOutcome(outcome)) {
      throw new ControlPlaneUnavailableError("budget reserve outcome malformed");
    }
    return outcome;
  }

  async budgetSettle(
    ledgerKey: string,
    requestId: string,
    actualCny: number,
  ): Promise<BudgetSettleOutcome> {
    const raw: unknown = await this.#redis.eval(
      BUDGET_SETTLE_SCRIPT,
      [totalKey(ledgerKey), reservationsKey(ledgerKey), settledKey(ledgerKey)],
      [requestId, actualCny],
    );
    if (!Array.isArray(raw) || raw.length < 2) {
      throw new ControlPlaneUnavailableError("budget settle script returned unexpected shape");
    }
    const outcome: BudgetSettleOutcome = {
      totalCny: asNumber(raw[0]),
      applied: asNumber(raw[1]) === 1,
    };
    if (!isBudgetSettleOutcome(outcome)) {
      throw new ControlPlaneUnavailableError("budget settle outcome malformed");
    }
    return outcome;
  }

  async budgetRead(ledgerKey: string): Promise<number | null> {
    const raw: unknown = await this.#redis.get(totalKey(ledgerKey));
    if (raw === null || raw === undefined) return null;
    return asNumber(raw);
  }
}

export interface UpstashRedisCredentials {
  readonly url: string;
  readonly token: string;
}

/** 用 REST 凭据构造生产 `RedisLike`；动态导入客户端，避免进入浏览器包。 */
export const createUpstashRedisLike = async (
  credentials: UpstashRedisCredentials,
): Promise<RedisLike> => {
  const { Redis: RedisClient } = await import("@upstash/redis");
  return new UpstashRedisLike(new RedisClient({ url: credentials.url, token: credentials.token }));
};

/**
 * 惰性生产实现：构造时**不**加载客户端，首次调用任一方法时才 `import("@upstash/redis")`。
 *
 * 这样 `createControlPlaneFromEnvironment` 可以在不触碰网络与客户端构造的前提下返回运行时
 * （进程级单例可缓存），只有真正发起限流/预算操作时才加载客户端。
 */
export const createLazyUpstashRedisLike = (credentials: UpstashRedisCredentials): RedisLike => {
  let inner: Promise<RedisLike> | undefined;
  const resolve = (): Promise<RedisLike> => (inner ??= createUpstashRedisLike(credentials));
  return {
    slidingWindow: (key, member, nowMs, windowMs, limit) =>
      resolve().then((redis) => redis.slidingWindow(key, member, nowMs, windowMs, limit)),
    budgetReserve: (ledgerKey, requestId, amountCny, capCny) =>
      resolve().then((redis) => redis.budgetReserve(ledgerKey, requestId, amountCny, capCny)),
    budgetSettle: (ledgerKey, requestId, actualCny) =>
      resolve().then((redis) => redis.budgetSettle(ledgerKey, requestId, actualCny)),
    budgetRead: (ledgerKey) => resolve().then((redis) => redis.budgetRead(ledgerKey)),
  };
};
