import type { GatewayErrorCode } from "../gateway/gateway-error-code";
import { isThresholdCurrent, type BudgetThreshold } from "./pricing";
import {
  ControlPlaneUnavailableError,
  isBudgetReserveOutcome,
  isBudgetSettleOutcome,
  type RedisLike,
} from "./redis-like";

/**
 * 费用预留、结算与月度累计（docs/gate2-design.md §3.3、D-181、D-190）。
 *
 * 账本按「价格版本 + 汇率版本 + 自然月」命名空间，键 `budget:{price}:{fx}:{YYYY-MM}`：
 * - **价格/汇率版本变化** → 换命名空间，旧账本不再计入，等价于「人工调预算版本后恢复」
 *   （D-190 决策一）；同时旧阈值被 `isThresholdCurrent` 判为过期并**拒绝**（AC2.6）。
 * - **自然月切换** → 换月戳，新账本从 0 开始，L2 自动恢复（AC2.8）。
 *
 * `reserve` / `settle` 的幂等性由存储侧单次调用保证（同一 `request_id` 只计一次，AC2.5）。
 */

/** 自然月戳 `YYYY-MM`（UTC）。 */
export const monthStamp = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 7);

/** 账本键：`budget:{price_version}:{fx_version}:{YYYY-MM}`。 */
export const budgetLedgerKey = (threshold: BudgetThreshold, nowMs: number): string =>
  `budget:${threshold.price_version}:${threshold.fx_version}:${monthStamp(nowMs)}`;

export type BudgetReserveResult =
  | { readonly ok: true; readonly totalCny: number; readonly capCny: number }
  | {
      readonly ok: false;
      readonly reason: "stale_threshold";
      readonly totalCny: number;
      readonly capCny: number;
    }
  | {
      readonly ok: false;
      readonly reason: "cap_exceeded";
      readonly totalCny: number;
      readonly capCny: number;
    };

export interface BudgetReserveInput {
  readonly threshold: BudgetThreshold;
  readonly nowMs: number;
  readonly requestId: string;
  readonly amountCny: number;
  /** 当前生效的价格/汇率版本；与阈值不一致即拒绝（AC2.6）。 */
  readonly currentPriceVersion: string;
  readonly currentFxVersion: string;
}

/**
 * 原子预留。阈值过期即拒绝（`stale_threshold`），上限不足即拒绝（`cap_exceeded`）；
 * 同一 `request_id` 重复预留为幂等重放，账本不变。
 */
export const reserveBudget = async (
  redis: RedisLike,
  input: BudgetReserveInput,
): Promise<BudgetReserveResult> => {
  if (!isThresholdCurrent(input.threshold, input.currentPriceVersion, input.currentFxVersion)) {
    const staleTotal = (await redis.budgetRead(budgetLedgerKey(input.threshold, input.nowMs))) ?? 0;
    return {
      ok: false,
      reason: "stale_threshold",
      totalCny: staleTotal,
      capCny: input.threshold.monthly_budget_cny,
    };
  }
  const key = budgetLedgerKey(input.threshold, input.nowMs);
  const outcome = await redis.budgetReserve(
    key,
    input.requestId,
    input.amountCny,
    input.threshold.monthly_budget_cny,
  );
  if (!isBudgetReserveOutcome(outcome)) {
    throw new ControlPlaneUnavailableError("budget reserve outcome malformed");
  }
  return outcome.ok
    ? { ok: true, totalCny: outcome.totalCny, capCny: outcome.capCny }
    : { ok: false, reason: "cap_exceeded", totalCny: outcome.totalCny, capCny: outcome.capCny };
};

export interface BudgetSettleInput {
  readonly threshold: BudgetThreshold;
  readonly nowMs: number;
  readonly requestId: string;
  readonly actualCny: number;
}

export interface BudgetSettleResult {
  readonly totalCny: number;
  /** 是否真正改变了账本；重复结算为 false（只计一次）。 */
  readonly applied: boolean;
}

/** 原子结算：把预留额替换为实际额，同一 `request_id` 只结算一次。 */
export const settleBudget = async (
  redis: RedisLike,
  input: BudgetSettleInput,
): Promise<BudgetSettleResult> => {
  const key = budgetLedgerKey(input.threshold, input.nowMs);
  const outcome = await redis.budgetSettle(key, input.requestId, input.actualCny);
  if (!isBudgetSettleOutcome(outcome)) {
    throw new ControlPlaneUnavailableError("budget settle outcome malformed");
  }
  return { totalCny: outcome.totalCny, applied: outcome.applied };
};

/** 只读的月度累计用量（AC2.11）：不写入、不改变任何熔断逻辑。 */
export interface MonthlyUsage {
  readonly month: string;
  readonly used_cny: number;
  readonly cap_cny: number;
  readonly price_version: string;
  readonly fx_version: string;
}

export interface MonthlyUsageInput {
  readonly threshold: BudgetThreshold;
  readonly nowMs: number;
}

export const readMonthlyUsage = async (
  redis: RedisLike,
  input: MonthlyUsageInput,
): Promise<MonthlyUsage> => {
  const used = (await redis.budgetRead(budgetLedgerKey(input.threshold, input.nowMs))) ?? 0;
  return {
    month: monthStamp(input.nowMs),
    used_cny: used,
    cap_cny: input.threshold.monthly_budget_cny,
    price_version: input.threshold.price_version,
    fx_version: input.threshold.fx_version,
  };
};

/** 预留失败原因 → 标准化错误码：阈值过期视为控制面不可信（失败关闭）。 */
export const reserveFailureErrorCode = (
  reason: Extract<BudgetReserveResult, { ok: false }>["reason"],
): GatewayErrorCode =>
  reason === "stale_threshold" ? "CONTROL_PLANE_UNAVAILABLE" : "BUDGET_EXCEEDED";
