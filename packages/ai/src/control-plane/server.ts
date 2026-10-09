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
 * ## 进程级单例（P1-2）
 *
 * L1 熔断要求「同一角色 5 分钟窗口内**连续 5 次**」**跨请求**累计，因此装配结果必须
 * 跨请求复用同一 `L1CircuitBreaker` 实例。本模块按 **Redis 实例** 缓存运行时：
 * - 生产路径：Redis 实例按凭据（url+token）缓存 → 同一进程内恒定 → 运行时恒定；
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
/** 运行时缓存：以 Redis 实例为键，保证同一存储复用同一 L1 熔断状态。 */
const runtimeByRedis = new Map<RedisLike, ControlPlaneRuntime>();

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
  if (cached !== undefined) return cached;
  const redis = createLazyUpstashRedisLike({ url, token });
  productionRedisByCredentials.set(cacheKey, redis);
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
 * 同一 Redis 实例重复调用返回**同一运行时**（进程级单例），使 L1 跨请求累计。
 */
export const createControlPlaneFromEnvironment = async (
  environment: Record<string, string | undefined>,
  options: CreateControlPlaneOptions = {},
): Promise<ControlPlaneRuntime | null> => {
  const secret = environment[CONTROL_PLANE_ENV_KEYS.secret];
  if (secret === undefined || secret.length === 0) return null;
  const redis = options.redis ?? resolveProductionRedis(environment);
  if (redis === null) return null;
  const cached = runtimeByRedis.get(redis);
  if (cached !== undefined) return cached;
  const runtime = buildRuntime(environment, options, redis, secret);
  runtimeByRedis.set(redis, runtime);
  return runtime;
};

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
