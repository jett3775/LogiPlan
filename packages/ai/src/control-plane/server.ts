import { L1CircuitBreaker } from "./circuit-breaker";
import {
  CONTROL_PLANE_ENV_KEYS,
  CONTROL_PLANE_TIMEOUT_MS,
  DEFAULT_ROLE_COST_PROFILES,
  type ControlPlaneRuntime,
  type CreateControlPlaneOptions,
} from "./control-plane";
import { deriveBudgetThreshold, FX_VERSION_V1, PRICE_VERSION_V1 } from "./pricing";
import { RATE_LIMIT_MAX_PER_WINDOW, RATE_LIMIT_WINDOW_MS } from "./rate-limit";
import type { RedisLike } from "./redis-like";
import { createLazyUpstashRedisLike } from "./upstash-redis";

/**
 * 成本包围控制面的**服务端装配入口**（`@logiplan/ai/server`）。
 *
 * ## 为什么不放进主 barrel
 *
 * 本模块是唯一静态可达 `upstash-redis.ts`（进而可达 Upstash Redis 客户端）的入口。
 * `packages/ai` 的主 barrel（`index.ts`）被**客户端组件**消费，因此**不得**从主 barrel
 * 导出本模块或 `upstash-redis.ts`——否则服务端基础设施会被打进浏览器包（P1-1）。
 * `no-live-call.test.ts` 有一条从 `index.ts` 出发的静态可达性断言锁死这一点。
 *
 * ## 进程级单例（P1-2）与主密钥隔离（阶段 1）
 *
 * L1 熔断要求「同一角色 5 分钟窗口内**连续 5 次**」**跨请求**累计，因此装配结果必须
 * 跨请求复用同一 `L1CircuitBreaker` 实例。本模块按 **Redis 实例 + 当前主密钥的不可逆摘要**
 * 缓存运行时：
 * - 生产路径：Redis 实例按凭据（url+token）缓存 → 同一进程内恒定；该表有容量上限
 *   （`MAX_CACHED_REDIS_CREDENTIALS`），超限按 LRU 淘汰并同步清理对应运行时条目；
 * - 运行时条目同时保存**当前主密钥的不可逆摘要**：摘要不变 → 复用（同一配置下 L1 跨请求
 *   累计）；摘要变化（轮换主密钥）→ **替换**该 Redis 的条目，使匿名派生立即改用新密钥，
 *   且条目数不随历史密钥增长；
 * - 测试路径：注入的 Redis 实例即缓存键，同一替身复用同一运行时（隔离由「每个用例新建
 *   替身」保证）。
 *
 * **Vercel serverless 局限（取舍）**：进程级单例只在**单个热实例**内有效；冷启动或横向
 * 扩容会产生独立实例，L1 计数不跨实例共享。这是有意的取舍——把 L1 落到 Redis 需要为
 * 「连续计数 + 半开」增加一套原子脚本与键，成本与复杂度显著高于切片 2 的目标，且
 * D-190 的 L1 目的是「约 25—100 秒内切断真故障供应商」，单实例内的短窗计数已能满足该
 * 语义。切片 3 若需要跨实例一致，应把 L1 状态迁到注入的存储（RedisLike）并重新验收。
 */

/** 生产 Redis 实例：按凭据缓存，使同一进程内实例恒定（进程级单例的前提）。 */
const productionRedisByCredentials = new Map<string, RedisLike>();

/**
 * 生产凭据缓存的**容量上限**。
 *
 * 生产实际只配置**一组** Upstash 凭据，正常运行时本表恒为 1 条。取 `4` 是为了在
 * 凭据轮换的过渡窗口内允许新旧凭据短暂并存，同时给异常配置一个远小于「无界」的硬上限
 * ——凭据（含 token）是敏感数据，缓存不应随历史轮换无限增长。
 *
 * ⚠️ 与 L1 熔断的关系：`runtimeByRedis`（键为 Redis **实例**）持有 L1 状态。淘汰凭据条目时
 * **必须同时移除对应 Redis 实例的运行时条目**（见 `evictLeastRecentlyUsedCredential`），
 * 否则会留下孤儿条目。**单凭据常态下该条目始终是最近使用项，绝不会被淘汰**，因此 L1 计数
 * 不会因淘汰而重置。只有当同一进程**同时**使用超过 `MAX_CACHED_REDIS_CREDENTIALS` 组不同
 * 凭据时，最久未用的一组才会被淘汰、其 L1 计数随之重置——这是为有界内存付出的、被明确
 * 记录的取舍。
 */
const MAX_CACHED_REDIS_CREDENTIALS = 4;

/**
 * 运行时缓存：每个 Redis 实例只保存**当前主密钥的不可逆摘要**及其运行时。
 * 摘要相同 → 复用（同一存储复用同一 L1 熔断状态）；摘要变化（轮换主密钥）→
 * **替换**该条目，使匿名派生立即改用新密钥，且条目数不随历史密钥增长。
 */
interface CachedRuntime {
  readonly secretDigest: string;
  readonly runtime: ControlPlaneRuntime;
}
const runtimeByRedis = new Map<RedisLike, CachedRuntime>();

/**
 * 淘汰**最久未用**的凭据条目，并**同步移除其 Redis 实例的运行时条目**，使两张表保持一致
 * （不留孤儿）。`Map` 的迭代顺序即插入顺序；命中会在 `resolveProductionRedis` 中把键移到
 * 末尾（LRU 触碰），故首个键即最久未用项。被淘汰实例的运行时条目若不存在则为无操作。
 */
const evictLeastRecentlyUsedCredential = (): void => {
  const oldestKey = productionRedisByCredentials.keys().next().value;
  if (oldestKey === undefined) return;
  const evictedRedis = productionRedisByCredentials.get(oldestKey);
  productionRedisByCredentials.delete(oldestKey);
  if (evictedRedis !== undefined) runtimeByRedis.delete(evictedRedis);
};

/**
 * 主密钥的不可逆摘要（SHA-256），只作运行时缓存的比较键。
 *
 * 复用 `anonymous-id.ts` 已在用的 Web Crypto（`globalThis.crypto.subtle`），不引新依赖。
 * SHA-256 对高熵主密钥不可逆，无法从摘要反推密钥。摘要**绝不外泄**：不写日志、不进返回值、
 * 不进错误消息（阶段 1 验收第 4 条）。
 */
const digestMasterSecret = async (secret: string): Promise<string> => {
  const encoded = new TextEncoder().encode(secret);
  // 复制为独立 `ArrayBuffer`：DOM 与 Node 的 `BufferSource` 对 `Uint8Array<ArrayBufferLike>` 判定不同。
  const bytes = new Uint8Array(encoded.byteLength);
  bytes.set(encoded);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const resolveProductionRedis = (
  environment: Record<string, string | undefined>,
): RedisLike | null => {
  const url = environment[CONTROL_PLANE_ENV_KEYS.upstashUrl];
  const token = environment[CONTROL_PLANE_ENV_KEYS.upstashToken];
  if (url === undefined || url.length === 0 || token === undefined || token.length === 0) {
    return null;
  }
  const cacheKey = `${url}\u0000${token}`;
  const cached = productionRedisByCredentials.get(cacheKey);
  if (cached !== undefined) {
    // LRU 触碰：命中后移到末尾（最近使用），使单凭据常态下永不被淘汰。
    productionRedisByCredentials.delete(cacheKey);
    productionRedisByCredentials.set(cacheKey, cached);
    return cached;
  }
  const redis = createLazyUpstashRedisLike({ url, token });
  productionRedisByCredentials.set(cacheKey, redis);
  // 超限即按 LRU 淘汰（同时清理运行时条目），保持本表有界且两表一致。
  while (productionRedisByCredentials.size > MAX_CACHED_REDIS_CREDENTIALS) {
    evictLeastRecentlyUsedCredential();
  }
  return redis;
};

const buildRuntime = (
  environment: Record<string, string | undefined>,
  options: CreateControlPlaneOptions,
  redis: RedisLike,
  secret: string,
): ControlPlaneRuntime => ({
  deps: {
    redis,
    breaker: new L1CircuitBreaker(),
    clock: options.clock ?? { now: () => Date.now() },
  },
  config: {
    environment: options.environmentName ?? environment["NODE_ENV"] ?? "unknown",
    secret,
    threshold: deriveBudgetThreshold(PRICE_VERSION_V1, FX_VERSION_V1),
    currentPriceVersion: PRICE_VERSION_V1,
    currentFxVersion: FX_VERSION_V1,
    rateLimitWindowMs: RATE_LIMIT_WINDOW_MS,
    rateLimitLimit: RATE_LIMIT_MAX_PER_WINDOW,
    controlPlaneTimeoutMs: CONTROL_PLANE_TIMEOUT_MS,
    roleCostProfiles: DEFAULT_ROLE_COST_PROFILES,
  },
});

/**
 * 从环境变量装配控制面。缺少主密钥或缺少 Redis 凭据时返回 `null`——
 * 调用方据此走「控制面不可用 → 失败关闭」。密钥缺失不抛错，避免把配置问题
 * 变成请求期异常。
 *
 * 同一 Redis 实例、同一主密钥重复调用返回**同一运行时**（进程级单例），使 L1 跨请求累计；
 * 主密钥轮换（摘要变化）时**替换**该 Redis 的运行时条目，使匿名派生立即改用新密钥。
 */
export const createControlPlaneFromEnvironment = async (
  environment: Record<string, string | undefined>,
  options: CreateControlPlaneOptions = {},
): Promise<ControlPlaneRuntime | null> => {
  const secret = environment[CONTROL_PLANE_ENV_KEYS.secret];
  if (secret === undefined || secret.length === 0) return null;
  const redis = options.redis ?? resolveProductionRedis(environment);
  if (redis === null) return null;
  const secretDigest = await digestMasterSecret(secret);
  const cached = runtimeByRedis.get(redis);
  if (cached !== undefined && cached.secretDigest === secretDigest) return cached.runtime;
  const runtime = buildRuntime(environment, options, redis, secret);
  runtimeByRedis.set(redis, { secretDigest, runtime });
  return runtime;
};

/**
 * **仅供测试**：返回两张进程级缓存表的当前条目数（凭据表与运行时表），用于验证淘汰有界、
 * 两表一致（不残留孤儿）。只返回计数，不泄露任何凭据；生产调用方不得依赖此导出。
 */
export const __controlPlaneCacheCountsForTest = (): {
  credentials: number;
  runtimes: number;
} => ({
  credentials: productionRedisByCredentials.size,
  runtimes: runtimeByRedis.size,
});

export {
  evaluateControlPlane,
  controlPlaneUnavailableDecision,
  recordProviderAttemptOutcome,
} from "./control-plane";
export { emitControlPlaneAudit } from "./audit-log";
export type {
  ControlPlaneClock,
  ControlPlaneConfig,
  ControlPlaneDecision,
  ControlPlaneDeps,
  ControlPlaneRequest,
  ControlPlaneRuntime,
  CreateControlPlaneOptions,
  RoleCostProfile,
} from "./control-plane";
export type { ControlPlaneAuditRecord } from "./audit-log";
