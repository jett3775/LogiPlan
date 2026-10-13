import {
  ControlPlaneUnavailableError,
  isBudgetReserveOutcome,
  isBudgetSettleOutcome,
  isCircuitSnapshot,
  isSlidingWindowOutcome,
  type BudgetReserveOutcome,
  type BudgetSettleOutcome,
  type CircuitSnapshot,
  type CircuitState,
  type RedisLike,
  type SlidingWindowOutcome,
} from "./redis-like";

/**
 * `RedisLike` 的生产实现（docs/gate2-design.md §3.1、D-181）。
 *
 * ## 原子性
 *
 * 每个方法都用**一个** Lua 脚本完成全部读改写，因此计数与判定、预留、结算、熔断计数都是
 * 原子的：并发调用不会超发（AC2.2）。脚本通过 `@upstash/redis` 的 `eval` 执行。
 *
 * ## 本机不可验证
 *
 * **真实 Redis 的并发原子性无法在本机验证**：本机没有可用的 Redis 实例，会话内
 * `spawnSync`/`execSync` 恒返回 `EBUSY`，无法起容器。因此本文件的 Lua 脚本只经过人工
 * 审查，未经真实执行；AC2.2 在本机只能由内存替身验证接口形态与调用方逻辑。
 *
 * **返回值精度回归（opt-in 集成测试）**：`upstash-redis.integration.test.ts` 打真实
 * Upstash REST，覆盖「Lua number 返回值被 RESP 截断为整数」这一内存替身无法复现的缺陷；
 * **跨实例一致性回归**：`circuit-breaker.integration.test.ts` 用两个独立客户端共享同一
 * Redis，验证熔断计数与状态跨实例可见、且同一毫秒并发故障不漏计数。两者默认跳过，仅在
 * `LOGIPLAN_UPSTASH_INTEGRATION=1` 且存在真实凭据时运行。
 *
 * ## 动态导入
 *
 * `@upstash/redis` 用**动态** `import()` 加载，使 `@logiplan/ai` 的 barrel 被浏览器
 * 组件引用时不会把 Redis 客户端静态打进浏览器包；只有服务端调用本工厂时才加载。
 *
 * ## 可注入的最小客户端
 *
 * 构造参数收窄为 `RedisScriptClient`（`@upstash/redis` 的 `Redis` 结构上满足），使脚本
 * 返回值 → 结果对象的映射可在**默认运行**（无凭据）下用替身覆盖。
 */

/** 生产实现依赖的最小 Redis 客户端接口；`@upstash/redis` 的 `Redis` 结构上满足。 */
export interface RedisScriptClient {
  eval(script: string, keys: string[], args: unknown[]): Promise<unknown>;
  get(key: string): Promise<unknown>;
}

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

// 账本总量必须以**字符串**（bulk string）返回：Redis 会把脚本返回值里的 Lua number 转成
// RESP integer 并**截断小数**（1.5 → 1、0.8 → 0），使 `totalCny` 少报，进而污染审计字段
// `budget_used_cny`（D-138 白名单）。`tostring`（Lua 5.1 即 `%.14g`）对 2—4 位小数的金额
// 精确往返；且这里把**同一个**格式化字符串既交给 `SET` 又作为返回值，保证返回值与持久化值
// **逐字节一致**（不依赖 Redis 对 SET 参数的内部数值格式化）。`ok`/`applied` 仍是整数。
const BUDGET_RESERVE_SCRIPT = `
local totalText = redis.call('GET', KEYS[1]) or '0'
local total = tonumber(totalText)
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then
  return {1, totalText, 0}
end
local amount = tonumber(ARGV[2])
local cap = tonumber(ARGV[3])
if total + amount > cap then
  return {0, totalText, 0}
end
local nextTotal = total + amount
local nextTotalText = tostring(nextTotal)
redis.call('SET', KEYS[1], nextTotalText)
redis.call('HSET', KEYS[2], ARGV[1], amount)
return {1, nextTotalText, 1}
`;

const BUDGET_SETTLE_SCRIPT = `
local totalText = redis.call('GET', KEYS[1]) or '0'
local total = tonumber(totalText)
if redis.call('SISMEMBER', KEYS[3], ARGV[1]) == 1 then
  return {totalText, 0}
end
local reserved = tonumber(redis.call('HGET', KEYS[2], ARGV[1]) or '0')
local actual = tonumber(ARGV[2])
local nextTotal = total - reserved + actual
local nextTotalText = tostring(nextTotal)
redis.call('SET', KEYS[1], nextTotalText)
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('SADD', KEYS[3], ARGV[1])
return {nextTotalText, 1}
`;

// L1 熔断（D-190 决策一）。键：`{key}:failures`（ZSET）/ `{key}:opened`（打开时刻）/
// `{key}:seq`（故障序号）。**纯读**：只用 GET 与 ZCOUNT，不写任何键。
// `ZCOUNT key '(' .. cutoff '+inf` 的排他下界等价于「`nowMs - at < windowMs`」的严格窗口。
const CIRCUIT_READ_SCRIPT = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local cutoff = now - window
local count = redis.call('ZCOUNT', KEYS[1], '(' .. cutoff, '+inf')
local opened = redis.call('GET', KEYS[2])
local state = 'closed'
local openedAt = -1
if opened then
  openedAt = tonumber(opened)
  if now - openedAt >= window then
    state = 'half_open'
  else
    state = 'open'
  end
end
return {state, count, openedAt}
`;

// 读—改—写在同一脚本内。**唯一成员**：`now .. ':' .. INCR(seq)`，使同一毫秒的并发故障
// 不互相覆盖（ZSET 成员唯一，若成员只用 `now` 则并发故障会被折叠成一条而漏计数）。
// 半开态失败 → 清空后重新计数为 1 并重开；否则剪除窗口外故障后追加。TTL = 2 × 窗口，
// 使 `opened` 键在窗口滑出（半开）之后仍然存活，避免把半开误读为闭合。
const CIRCUIT_RECORD_FAILURE_SCRIPT = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local threshold = tonumber(ARGV[3])
local ttl = window * 2
local cutoff = now - window
local opened = redis.call('GET', KEYS[2])
local halfOpen = false
if opened and (now - tonumber(opened)) >= window then
  halfOpen = true
  redis.call('DEL', KEYS[1])
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
local seq = redis.call('INCR', KEYS[3])
redis.call('ZADD', KEYS[1], now, now .. ':' .. seq)
local count = redis.call('ZCARD', KEYS[1])
if halfOpen or count >= threshold then
  redis.call('SET', KEYS[2], tostring(now))
end
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('PEXPIRE', KEYS[3], ttl)
if opened or halfOpen or count >= threshold then
  redis.call('PEXPIRE', KEYS[2], ttl)
end
return 1
`;

const CIRCUIT_RECORD_SUCCESS_SCRIPT = `
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
return 1
`;

const totalKey = (ledgerKey: string): string => `${ledgerKey}:total`;
const reservationsKey = (ledgerKey: string): string => `${ledgerKey}:reservations`;
const settledKey = (ledgerKey: string): string => `${ledgerKey}:settled`;

const circuitFailuresKey = (key: string): string => `${key}:failures`;
const circuitOpenedKey = (key: string): string => `${key}:opened`;
const circuitSequenceKey = (key: string): string => `${key}:seq`;

const asNumber = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneUnavailableError("redis script returned a non-numeric value");
  }
  return parsed;
};

export class UpstashRedisLike implements RedisLike {
  readonly #redis: RedisScriptClient;

  constructor(redis: RedisScriptClient) {
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

  async circuitRead(key: string, nowMs: number, windowMs: number): Promise<CircuitSnapshot> {
    const raw: unknown = await this.#redis.eval(
      CIRCUIT_READ_SCRIPT,
      [circuitFailuresKey(key), circuitOpenedKey(key)],
      [nowMs, windowMs],
    );
    if (!Array.isArray(raw) || raw.length < 3) {
      throw new ControlPlaneUnavailableError("circuit read script returned unexpected shape");
    }
    const openedAt = asNumber(raw[2]);
    const snapshot: CircuitSnapshot = {
      state: raw[0] as CircuitState,
      failures: asNumber(raw[1]),
      openedAt: openedAt < 0 ? null : openedAt,
    };
    if (!isCircuitSnapshot(snapshot)) {
      throw new ControlPlaneUnavailableError("circuit snapshot malformed");
    }
    return snapshot;
  }

  async circuitRecordFailure(
    key: string,
    nowMs: number,
    windowMs: number,
    threshold: number,
  ): Promise<void> {
    await this.#redis.eval(
      CIRCUIT_RECORD_FAILURE_SCRIPT,
      [circuitFailuresKey(key), circuitOpenedKey(key), circuitSequenceKey(key)],
      [nowMs, windowMs, threshold],
    );
  }

  async circuitRecordSuccess(key: string): Promise<void> {
    await this.#redis.eval(
      CIRCUIT_RECORD_SUCCESS_SCRIPT,
      [circuitFailuresKey(key), circuitOpenedKey(key), circuitSequenceKey(key)],
      [],
    );
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
  const client = new RedisClient({ url: credentials.url, token: credentials.token });
  return new UpstashRedisLike(client);
};

/**
 * 惰性生产实现：构造时**不**加载客户端，首次调用任一方法时才 `import("@upstash/redis")`。
 *
 * 这样 `createControlPlaneFromEnvironment` 可以在不触碰网络与客户端构造的前提下返回运行时
 * （进程级单例可缓存），只有真正发起限流/预算/熔断操作时才加载客户端。
 *
 * 第二个参数是可注入的构造工厂（默认 `createUpstashRedisLike`），**仅供测试**用替身覆盖
 * 「首次调用才构造、后续复用」的委托逻辑；生产调用方不传。
 */
export const createLazyUpstashRedisLike = (
  credentials: UpstashRedisCredentials,
  create: (credentials: UpstashRedisCredentials) => Promise<RedisLike> = createUpstashRedisLike,
): RedisLike => {
  let inner: Promise<RedisLike> | undefined;
  const resolve = (): Promise<RedisLike> => (inner ??= create(credentials));
  return {
    slidingWindow: (key, member, nowMs, windowMs, limit) =>
      resolve().then((redis) => redis.slidingWindow(key, member, nowMs, windowMs, limit)),
    budgetReserve: (ledgerKey, requestId, amountCny, capCny) =>
      resolve().then((redis) => redis.budgetReserve(ledgerKey, requestId, amountCny, capCny)),
    budgetSettle: (ledgerKey, requestId, actualCny) =>
      resolve().then((redis) => redis.budgetSettle(ledgerKey, requestId, actualCny)),
    budgetRead: (ledgerKey) => resolve().then((redis) => redis.budgetRead(ledgerKey)),
    circuitRead: (key, nowMs, windowMs) =>
      resolve().then((redis) => redis.circuitRead(key, nowMs, windowMs)),
    circuitRecordFailure: (key, nowMs, windowMs, threshold) =>
      resolve().then((redis) => redis.circuitRecordFailure(key, nowMs, windowMs, threshold)),
    circuitRecordSuccess: (key) => resolve().then((redis) => redis.circuitRecordSuccess(key)),
  };
};
