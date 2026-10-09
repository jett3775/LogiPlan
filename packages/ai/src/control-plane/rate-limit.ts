import type { AiRole } from "../routing/role-routing";
import { anonymousDayStamp } from "./anonymous-id";
import { ControlPlaneUnavailableError, isSlidingWindowOutcome, type RedisLike } from "./redis-like";

/**
 * 滑动窗口限流（docs/gate2-design.md §3.2、D-181）。
 *
 * 键形态 `rl:{scope}:{role}:{day}`：`scope` 为匿名派生值，按角色分别计数，日戳使键
 * 自然过期。计数与判定由 `RedisLike.slidingWindow` 在**单次调用**内完成（AC2.2）。
 *
 * 窗口长度与上限是**实现参数**，非冻结决策（D-190 只冻结了熔断阈值）；实施时按实际
 * 流量校准，校准不改变「超限即失败关闭」的语义。
 */

/** 滑动窗口长度（毫秒）。 */
export const RATE_LIMIT_WINDOW_MS = 60_000;
/** 单窗口内单角色允许的请求数上限。 */
export const RATE_LIMIT_MAX_PER_WINDOW = 10;

/** 键形态 `rl:{scope}:{role}:{day}`。 */
export const rateLimitKey = (scope: string, role: AiRole, nowMs: number): string =>
  `rl:${scope}:${role}:${anonymousDayStamp(nowMs)}`;

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
}

export interface RateLimitInput {
  readonly scope: string;
  readonly role: AiRole;
  readonly requestId: string;
  readonly nowMs: number;
  readonly windowMs?: number;
  readonly limit?: number;
}

/**
 * 单次调用完成计数与判定。返回结构不确定时抛 `ControlPlaneUnavailableError`，
 * 由控制面统一失败关闭——不把不确定状态当作可用（D-181）。
 */
export const checkRateLimit = async (
  redis: RedisLike,
  input: RateLimitInput,
): Promise<RateLimitDecision> => {
  const limit = input.limit ?? RATE_LIMIT_MAX_PER_WINDOW;
  const windowMs = input.windowMs ?? RATE_LIMIT_WINDOW_MS;
  const key = rateLimitKey(input.scope, input.role, input.nowMs);
  const outcome = await redis.slidingWindow(key, input.requestId, input.nowMs, windowMs, limit);
  if (!isSlidingWindowOutcome(outcome)) {
    throw new ControlPlaneUnavailableError("rate limit outcome malformed");
  }
  return {
    allowed: outcome.allowed,
    limit: outcome.limit,
    remaining: Math.max(0, outcome.limit - outcome.count),
  };
};
