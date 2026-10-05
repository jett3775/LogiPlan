import { z } from "zod";

/**
 * 不可变证据快照的六项版本校验（docs/gate2-design.md §4.2）。
 *
 * 契约版本、数据发布版本、供应商、模型、提示词版本、输出模式版本任一不一致，
 * 即视为不可恢复：丢弃快照并回到固定示例，**不得静默降级为「部分可用」**。
 */

/** 六项校验字段；顺序即校验顺序。 */
export const SNAPSHOT_VERSION_FIELDS = [
  "contract_version",
  "data_release_id",
  "provider",
  "model",
  "prompt_version",
  "output_schema_version",
] as const;

export type SnapshotVersionField = (typeof SNAPSHOT_VERSION_FIELDS)[number];

export type SnapshotVersions = Readonly<Record<SnapshotVersionField, string>>;

export const snapshotVersionsSchema = z
  .object({
    contract_version: z.string().min(1),
    data_release_id: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    prompt_version: z.string().min(1),
    output_schema_version: z.string().min(1),
  })
  .strict();

export interface SnapshotVersionMismatch {
  readonly field: SnapshotVersionField;
  readonly stored: string;
  readonly expected: string;
}

export interface SnapshotVersionCheck {
  readonly matches: boolean;
  readonly mismatches: readonly SnapshotVersionMismatch[];
}

/**
 * 逐项比较六项版本，返回**全部**不一致项。
 *
 * 实现按字段名显式展开六个比较分支：新增字段或漏掉某一项都会被
 * `snapthotVersionFieldsAreFrozen` 之类的穷尽性测试捕获。
 */
export const compareSnapshotVersions = (
  stored: SnapshotVersions,
  expected: SnapshotVersions,
): readonly SnapshotVersionMismatch[] => {
  const mismatches: SnapshotVersionMismatch[] = [];
  const compare = (field: SnapshotVersionField): void => {
    if (stored[field] !== expected[field]) {
      mismatches.push({ field, stored: stored[field], expected: expected[field] });
    }
  };
  compare("contract_version");
  compare("data_release_id");
  compare("provider");
  compare("model");
  compare("prompt_version");
  compare("output_schema_version");
  return mismatches;
};

export const checkSnapshotVersions = (
  stored: SnapshotVersions,
  expected: SnapshotVersions,
): SnapshotVersionCheck => {
  const mismatches = compareSnapshotVersions(stored, expected);
  return { matches: mismatches.length === 0, mismatches };
};
