import type { Client } from "pg";

// packages/db 内部的事务结果契约。本模块不通过 packages/db/src/index.ts 对外导出。
//
// 三类结果必须可机器识别，且不能用同一种退出码或同一段叙述互相冒充：
// 1. rollbackConfirmed：业务写入已确认回滚或从未开始，退出码 1，重试安全。
// 2. writeOutcomeUnknown：COMMIT 是否生效未知，退出码 75，必须先只读核对再重试。
// 3. writeCommittedObservationFailed：写入已确认提交，失败发生在提交后的观察或清理阶段，退出码 1。
//    advisory 锁释放失败不属于业务写入未知：关闭连接本身会释放会话级锁，但清理失败必须可见。

export type TransactionOutcomeFlag =
  "rollbackConfirmed" | "writeOutcomeUnknown" | "writeCommittedObservationFailed";

export interface SubsequentFailure {
  readonly stage: string;
  readonly error: unknown;
}

export type TransactionFailure = Error & {
  rollbackConfirmed?: true;
  writeOutcomeUnknown?: true;
  writeCommittedObservationFailed?: true;
  subsequentFailures?: readonly { stage: string; message: string }[];
  cause?: unknown;
};

export interface AdvisoryUnlock {
  readonly statement: string;
  readonly parameters: readonly string[];
}

// 唯一的显式隔离级别入口：既有调用点不传该参数时仍发出裸 BEGIN，行为逐字不变。
export type TransactionIsolationLevel = "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

// 与 scripts/neon-baseline.mjs 的 writeOutcomeUnknownExitCode 保持一致；本包不反向依赖脚本。
export const writeOutcomeUnknownExitCode = 75;
export const writeCommittedObservationFailedLogPrefix = "[WRITE_COMMITTED_OBSERVATION_FAILED]";

// COMMIT 阶段只有在 SQLSTATE 明确表示事务已终止且不可能提交时，才允许判定为确定失败。
// 40003（statement completion unknown）、08xxx（连接异常）、57014（查询取消）以及任何
// 未枚举的错误码都必须归入写入结果未知，避免把已提交的写入误报为已知失败。
const definitelyUncommittedCodePrefixes = ["25"];
const definitelyUncommittedCodes = new Set(["2D000"]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeFailures(
  failures: readonly SubsequentFailure[],
): readonly { stage: string; message: string }[] {
  return failures.map(({ stage, error }) => ({ stage, message: errorMessage(error) }));
}

function detailOf(failures: readonly SubsequentFailure[]): string {
  return failures.map(({ stage, error }) => `${stage}：${errorMessage(error)}`).join("；");
}

export function hasOutcomeFlag(error: unknown, flag: TransactionOutcomeFlag): boolean {
  if (typeof error !== "object" || error === null || !(flag in error)) return false;
  return (error as Record<string, unknown>)[flag] === true;
}

export function exitCodeForTransactionFailure(error: unknown): number {
  return hasOutcomeFlag(error, "writeOutcomeUnknown") ? writeOutcomeUnknownExitCode : 1;
}

export function transactionFailureLogPrefix(error: unknown): string {
  if (hasOutcomeFlag(error, "writeOutcomeUnknown")) return "[WRITE_OUTCOME_UNKNOWN] ";
  if (hasOutcomeFlag(error, "writeCommittedObservationFailed")) {
    return `${writeCommittedObservationFailedLogPrefix} `;
  }
  return "";
}

export function isConfirmedCommitFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = error.code;
  if (typeof code !== "string") return false;
  return (
    definitelyUncommittedCodes.has(code) ||
    definitelyUncommittedCodePrefixes.some((prefix) => code.startsWith(prefix))
  );
}

export function markRollbackConfirmed(error: unknown): TransactionFailure {
  const confirmed = error instanceof Error ? error : new Error("数据库事务失败");
  Object.assign(confirmed, { rollbackConfirmed: true });
  return confirmed as TransactionFailure;
}

export function unknownCommitOutcome(scope: string): TransactionFailure {
  const error = new Error(`COMMIT 确认丢失，${scope}结果未知；必须先只读核对再重试`);
  Object.assign(error, { writeOutcomeUnknown: true });
  return error as TransactionFailure;
}

export function unknownRollbackOutcome(scope: string): TransactionFailure {
  const error = new Error(`事务回滚确认丢失，${scope}结果未知；必须先只读核对再重试`);
  Object.assign(error, { writeOutcomeUnknown: true });
  return error as TransactionFailure;
}

export function writeCommittedObservationFailed(
  scope: string,
  detail: string,
  failures: readonly SubsequentFailure[] = [],
): TransactionFailure {
  const error = new Error(
    `${scope}写入已提交，失败发生在后续观察或清理阶段：${detail}；不得把它当作写入失败重做`,
  ) as TransactionFailure;
  Object.assign(error, { writeCommittedObservationFailed: true });
  const [firstFailure] = failures;
  if (firstFailure !== undefined) {
    Object.assign(error, {
      subsequentFailures: describeFailures(failures),
      cause: firstFailure.error,
    });
  }
  return error;
}

export function combineOutcomeWithSubsequentFailures(
  primaryError: unknown,
  subsequentFailures: readonly SubsequentFailure[],
  scope: string,
  subsequentStageLabel: string,
): TransactionFailure | undefined {
  if (subsequentFailures.length === 0) {
    return primaryError === undefined ? undefined : (primaryError as TransactionFailure);
  }

  if (primaryError === undefined) {
    return writeCommittedObservationFailed(scope, detailOf(subsequentFailures), subsequentFailures);
  }

  const merged = primaryError instanceof Error ? primaryError : new Error("未知事务错误");
  const failure = merged as TransactionFailure;
  if (hasOutcomeFlag(primaryError, "writeOutcomeUnknown")) {
    // 主错误已经是未知写入：清理失败只作为附加证据，绝不被描述成业务写入未知。
    Object.assign(failure, {
      subsequentFailures: describeFailures(subsequentFailures),
      message: `${merged.message}（${subsequentStageLabel}阶段另有失败：${detailOf(subsequentFailures)}）`,
    });
    return failure;
  }

  if (subsequentFailures.some(({ error }) => hasOutcomeFlag(error, "writeOutcomeUnknown"))) {
    // 后续写入（例如标记发布失败状态）的 COMMIT 结果未知：必须升级为未知写入并保留原错误。
    const unknown = new Error(
      `${merged.message}；${subsequentStageLabel}阶段的写入 COMMIT 确认丢失，${scope}结果未知，必须先只读核对再重试`,
    );
    Object.assign(unknown, {
      writeOutcomeUnknown: true,
      subsequentFailures: describeFailures(subsequentFailures),
      cause: merged,
    });
    if (hasOutcomeFlag(primaryError, "rollbackConfirmed")) {
      Object.assign(unknown, { rollbackConfirmed: true });
    }
    return unknown as TransactionFailure;
  }

  // 主错误不是未知写入，后续失败已确认回滚：保留主错误标志，只附加清理或后续写入证据。
  Object.assign(failure, {
    subsequentFailures: describeFailures(subsequentFailures),
    message: `${merged.message}（${subsequentStageLabel}阶段另有失败：${detailOf(subsequentFailures)}）`,
  });
  return failure;
}

export async function runTransaction(
  client: Client,
  operation: () => Promise<void>,
  scope: string,
  isolationLevel?: TransactionIsolationLevel,
): Promise<void> {
  await client.query(
    isolationLevel === undefined ? "BEGIN" : `BEGIN ISOLATION LEVEL ${isolationLevel}`,
  );
  let commitAttempted = false;
  try {
    await operation();
    commitAttempted = true;
    await client.query("COMMIT");
  } catch (error: unknown) {
    if (commitAttempted && !isConfirmedCommitFailure(error)) {
      try {
        await client.query("ROLLBACK");
      } catch {
        throw unknownRollbackOutcome(scope);
      }
      throw unknownCommitOutcome(scope);
    }
    try {
      await client.query("ROLLBACK");
    } catch {
      throw unknownRollbackOutcome(scope);
    }
    throw markRollbackConfirmed(error);
  }
}

// 读取“已提交写入”之后的状态：读取失败必须表达为写入已提交、观察失败，而不是写入失败。
export async function observeCommittedWrite<T>(
  scope: string,
  detail: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error: unknown) {
    throw writeCommittedObservationFailed(scope, `${detail}（${errorMessage(error)}）`, [
      { stage: detail, error },
    ]);
  }
}

// 按固定顺序分别尝试释放 advisory 锁与关闭连接；任一步失败都不阻止另一步执行。
// closeConnection=false 时只释放 advisory 锁：连接由调用方拥有，不得代其关闭。
async function releaseConnection(
  client: Client,
  unlock: AdvisoryUnlock,
  closeConnection: boolean,
): Promise<readonly SubsequentFailure[]> {
  const failures: SubsequentFailure[] = [];
  try {
    await client.query(unlock.statement, [...unlock.parameters]);
  } catch (error: unknown) {
    failures.push({ stage: "释放 advisory 锁", error });
  }
  if (!closeConnection) {
    return failures;
  }
  try {
    await client.end();
  } catch (error: unknown) {
    failures.push({ stage: "关闭数据库连接", error });
  }
  return failures;
}

export async function runWithConnectionCleanup<T = void>(
  client: Client,
  unlock: AdvisoryUnlock,
  scope: string,
  operation: () => Promise<T>,
  closeConnection = true,
): Promise<T> {
  let primaryError: unknown;
  let hasPrimaryError = false;
  let result: T | undefined;
  try {
    result = await operation();
  } catch (error: unknown) {
    primaryError = error;
    hasPrimaryError = true;
  }

  const cleanupFailures = await releaseConnection(client, unlock, closeConnection);
  const failure = combineOutcomeWithSubsequentFailures(
    hasPrimaryError ? primaryError : undefined,
    cleanupFailures,
    scope,
    "连接清理",
  );
  if (failure !== undefined) {
    throw failure;
  }
  // 能走到这里等价于「主流程成功且清理无失败」，result 必定已赋值。
  return result as T;
}
