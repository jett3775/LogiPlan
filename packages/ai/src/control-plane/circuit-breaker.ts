import type { GatewayErrorCode } from "../gateway/gateway-error-code";
import type { AiRole } from "../routing/role-routing";
import type { BudgetThreshold } from "./pricing";
import {
  ControlPlaneUnavailableError,
  isCircuitSnapshot,
  type CircuitSnapshot,
  type CircuitState,
  type RedisLike,
} from "./redis-like";

/**
 * 两级熔断（docs/gate2-design.md §3.4、docs/decisions.md D-190 决策一）。
 *
 * - **L1（供应商短窗熔断）**：同一角色在 **5 分钟窗口内连续 5 次**瞬时故障
 *   （`PROVIDER_TIMEOUT` / `PROVIDER_UNAVAILABLE` / 重试后仍失败的 429）触发，
 *   关闭该角色的真实调用；窗口滑出后**半开重试**，成功即闭合。
 * - **L2（月度预算熔断）**：月度累计达到 30 元阈值即关闭**全部**角色；
 *   自然月切换或人工调整预算版本后恢复（由账本按「版本 + 月」命名空间自然实现）。
 *
 * ## 状态落在注入的存储（跨实例一致）
 *
 * L1 状态**不**再存在进程内存里，而是通过注入的 `RedisLike` 落到共享存储（生产为 Upstash
 * Redis）。这样「同一角色 5 分钟窗口内连续 5 次」的计数与判定**跨进程/跨实例共享**——
 * 这是 Vercel serverless 下 L1 真正生效的前提。每个「读—改—写」都在存储侧**单次调用**
 * 内完成；判定用的读取是**纯读**（不写任何键）。存储不可用 / 超时 / 返回畸形结构时抛
 * `ControlPlaneUnavailableError`，由控制面统一失败关闭——**不**回落到进程内计数。
 *
 * 时钟由调用方注入，使窗口滑出与半开可被确定地测试（AC2.7）。
 */

/** L1 窗口长度：5 分钟。 */
export const L1_WINDOW_MS = 5 * 60 * 1000;
/** L1 连续瞬时故障阈值：5 次（第 4 次不触发，第 5 次触发）。 */
export const L1_CONSECUTIVE_FAILURE_THRESHOLD = 5;

/** 计为 L1 瞬时故障的标准化错误码（D-190 决策一）。 */
export const TRANSIENT_FAILURE_CODES: readonly GatewayErrorCode[] = [
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RATE_LIMITED",
];

export const isTransientFailure = (code: GatewayErrorCode): boolean =>
  TRANSIENT_FAILURE_CODES.includes(code);

// 存储层类型定义在 `redis-like.ts`；此处 re-export 保持既有导出位置不变。
export type { CircuitSnapshot, CircuitState };

/** 按角色的 L1 熔断存储键基名：`circuit:{role}`（子键由存储实现追加）。 */
export const circuitKey = (role: AiRole): string => `circuit:${role}`;

export interface CircuitBreakerOptions {
  readonly windowMs?: number;
  readonly threshold?: number;
}

/**
 * 按角色维护的 L1 熔断器：注入的 `RedisLike` 承载状态，方法均为异步 I/O。
 *
 * 语义与 D-190 决策一逐条一致：同一角色、5 分钟窗口、**连续 5 次**瞬时故障 → 打开；
 * 第 4 次不触发、第 5 次触发；打开后窗口滑出 → 半开；半开成功 → 闭合；半开失败 → 重新
 * 打开；按角色分别维护、互不影响。窗口判定沿用严格 `nowMs - at < windowMs`。
 */
export class L1CircuitBreaker {
  readonly #redis: RedisLike;
  readonly #windowMs: number;
  readonly #threshold: number;

  constructor(redis: RedisLike, options: CircuitBreakerOptions = {}) {
    this.#redis = redis;
    this.#windowMs = options.windowMs ?? L1_WINDOW_MS;
    this.#threshold = options.threshold ?? L1_CONSECUTIVE_FAILURE_THRESHOLD;
  }

  /**
   * 一次**纯读**返回完整判定结果：调用方据此同时得到「是否放行」与审计用状态，
   * 避免 `canAttempt` + `state` 的两次往返。返回结构不确定即失败关闭。
   */
  async read(role: AiRole, nowMs: number): Promise<CircuitSnapshot> {
    const snapshot = await this.#redis.circuitRead(circuitKey(role), nowMs, this.#windowMs);
    if (!isCircuitSnapshot(snapshot)) {
      throw new ControlPlaneUnavailableError("circuit snapshot malformed");
    }
    return snapshot;
  }

  /** 当前状态：闭合 / 打开 / 半开（窗口滑出后自动半开）。 */
  async state(role: AiRole, nowMs: number): Promise<CircuitState> {
    return (await this.read(role, nowMs)).state;
  }

  /** 是否允许尝试真实调用：打开期间不允许，半开允许探测一次。 */
  async canAttempt(role: AiRole, nowMs: number): Promise<boolean> {
    return (await this.read(role, nowMs)).state !== "open";
  }

  /** 记录一次瞬时故障；连续达到阈值即打开，半开态失败则重新打开。 */
  async recordTransientFailure(role: AiRole, nowMs: number): Promise<void> {
    await this.#redis.circuitRecordFailure(
      circuitKey(role),
      nowMs,
      this.#windowMs,
      this.#threshold,
    );
  }

  /** 记录一次成功：清空连续故障计数并闭合（半开探测成功即闭合）。 */
  async recordSuccess(role: AiRole): Promise<void> {
    await this.#redis.circuitRecordSuccess(circuitKey(role));
  }
}

/** L2：月度累计是否达到阈值（达到即关闭全部角色）。 */
export const isMonthlyBudgetBreached = (usedCny: number, threshold: BudgetThreshold): boolean =>
  usedCny >= threshold.monthly_budget_cny;
