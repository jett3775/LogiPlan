import type { GatewayErrorCode } from "../gateway/gateway-error-code";
import type { AiRole } from "../routing/role-routing";
import type { BudgetThreshold } from "./pricing";

/**
 * 两级熔断（docs/gate2-design.md §3.4、docs/decisions.md D-190 决策一）。
 *
 * - **L1（供应商短窗熔断）**：同一角色在 **5 分钟窗口内连续 5 次**瞬时故障
 *   （`PROVIDER_TIMEOUT` / `PROVIDER_UNAVAILABLE` / 重试后仍失败的 429）触发，
 *   关闭该角色的真实调用；窗口滑出后**半开重试**，成功即闭合。
 * - **L2（月度预算熔断）**：月度累计达到 30 元阈值即关闭**全部**角色；
 *   自然月切换或人工调整预算版本后恢复（由账本按「版本 + 月」命名空间自然实现）。
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

export type CircuitState = "closed" | "open" | "half_open";

interface RoleFailureState {
  /** 窗口内的故障时间戳（毫秒），升序。 */
  failures: number[];
  /** 打开时刻；`null` 表示闭合。 */
  openedAt: number | null;
}

export interface CircuitBreakerOptions {
  readonly windowMs?: number;
  readonly threshold?: number;
}

/** 按角色维护的 L1 熔断器。纯内存、无 I/O，时钟由调用方给出。 */
export class L1CircuitBreaker {
  readonly #windowMs: number;
  readonly #threshold: number;
  readonly #states = new Map<AiRole, RoleFailureState>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.#windowMs = options.windowMs ?? L1_WINDOW_MS;
    this.#threshold = options.threshold ?? L1_CONSECUTIVE_FAILURE_THRESHOLD;
  }

  #prune(failures: readonly number[], nowMs: number): number[] {
    return failures.filter((at) => nowMs - at < this.#windowMs);
  }

  /** 当前状态：闭合 / 打开 / 半开（窗口滑出后自动半开）。 */
  state(role: AiRole, nowMs: number): CircuitState {
    const state = this.#states.get(role);
    if (state === undefined || state.openedAt === null) return "closed";
    return nowMs - state.openedAt >= this.#windowMs ? "half_open" : "open";
  }

  /** 是否允许尝试真实调用：打开期间不允许，半开允许探测一次。 */
  canAttempt(role: AiRole, nowMs: number): boolean {
    return this.state(role, nowMs) !== "open";
  }

  /** 记录一次瞬时故障；连续达到阈值即打开，半开态失败则重新打开。 */
  recordTransientFailure(role: AiRole, nowMs: number): void {
    const current = this.#states.get(role) ?? { failures: [], openedAt: null };
    if (this.state(role, nowMs) === "half_open") {
      this.#states.set(role, { failures: [nowMs], openedAt: nowMs });
      return;
    }
    const failures = [...this.#prune(current.failures, nowMs), nowMs];
    const openedAt = failures.length >= this.#threshold ? nowMs : current.openedAt;
    this.#states.set(role, { failures, openedAt });
  }

  /** 记录一次成功：清空连续故障计数并闭合（半开探测成功即闭合）。 */
  recordSuccess(role: AiRole): void {
    this.#states.delete(role);
  }
}

/** L2：月度累计是否达到阈值（达到即关闭全部角色）。 */
export const isMonthlyBudgetBreached = (usedCny: number, threshold: BudgetThreshold): boolean =>
  usedCny >= threshold.monthly_budget_cny;
