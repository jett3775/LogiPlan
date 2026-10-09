/**
 * 成本包围的最小 Redis 抽象（docs/gate2-design.md §3.1—§3.3、docs/decisions.md D-181）。
 *
 * 每个方法都对应**一次**服务端调用：滑动窗口的计数与判定、预算预留、预算结算都在
 * 同一次调用内完成。调用方无法把「读—改—写」拆成多次往返，因此原子性由存储侧保证
 * ——这正是 AC2.2 的口径（「Redis 侧单次脚本调用完成计数与判定」）。
 *
 * 生产实现见 `upstash-redis.ts`（中立的 Upstash Redis 客户端，动态导入，不进浏览器包）；
 * 测试注入内存替身（`test-doubles.ts`）。
 *
 * **真实 Redis 的并发原子性无法在本机验证**：本机没有 Upstash 凭据，替身只能验证
 * 「单次调用完成计数与判定」这一接口形态与调用方逻辑，不能验证 Lua 脚本本身的原子性。
 */

/** 滑动窗口一次调用的结果。 */
export interface SlidingWindowOutcome {
  readonly allowed: boolean;
  /** 窗口内已计入的请求数（含本次，若本次被计入）。 */
  readonly count: number;
  readonly limit: number;
}

/** 预算预留一次调用的结果。 */
export interface BudgetReserveOutcome {
  /** 该次预留是否被接受（未超上限，或为幂等重放）。 */
  readonly ok: boolean;
  /** 变更后的账本累计值（人民币）。 */
  readonly totalCny: number;
  /** 账本上限（人民币）。 */
  readonly capCny: number;
  /** 本次调用是否真正改变了账本；幂等重放为 false。 */
  readonly applied: boolean;
}

/** 预算结算一次调用的结果。 */
export interface BudgetSettleOutcome {
  /** 结算后的账本累计值（人民币）。 */
  readonly totalCny: number;
  /** 本次调用是否真正改变了账本；幂等重放为 false。 */
  readonly applied: boolean;
}

export interface RedisLike {
  /** 原子滑动窗口：同一次调用内完成计数与判定。 */
  slidingWindow(
    key: string,
    member: string,
    nowMs: number,
    windowMs: number,
    limit: number,
  ): Promise<SlidingWindowOutcome>;
  /** 原子预留：同一 `requestId` 重复预留不再计费。 */
  budgetReserve(
    ledgerKey: string,
    requestId: string,
    amountCny: number,
    capCny: number,
  ): Promise<BudgetReserveOutcome>;
  /** 原子结算：同一 `requestId` 重复结算不再计费。 */
  budgetSettle(
    ledgerKey: string,
    requestId: string,
    actualCny: number,
  ): Promise<BudgetSettleOutcome>;
  /** 只读读取账本累计值；不存在返回 null（不产生任何写入）。 */
  budgetRead(ledgerKey: string): Promise<number | null>;
}

/**
 * 成本包围控制面不可用（连接失败、超时、返回不确定状态）。
 *
 * 调用方必须据此**失败关闭**：不调用模型、页面回落固定示例、确定性分析不受影响
 * （docs/gate2-design.md §3.2、§7）。
 */
export class ControlPlaneUnavailableError extends Error {
  override readonly name = "ControlPlaneUnavailableError";
  constructor(message = "control plane storage unavailable") {
    super(message);
  }
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const isSlidingWindowOutcome = (value: unknown): value is SlidingWindowOutcome => {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.allowed === "boolean" &&
    isFiniteNumber(record.count) &&
    isFiniteNumber(record.limit)
  );
};

export const isBudgetReserveOutcome = (value: unknown): value is BudgetReserveOutcome => {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.ok === "boolean" &&
    isFiniteNumber(record.totalCny) &&
    isFiniteNumber(record.capCny) &&
    typeof record.applied === "boolean"
  );
};

export const isBudgetSettleOutcome = (value: unknown): value is BudgetSettleOutcome => {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return isFiniteNumber(record.totalCny) && typeof record.applied === "boolean";
};
