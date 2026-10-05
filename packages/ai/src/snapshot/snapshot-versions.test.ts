import { describe, expect, it } from "vitest";

import {
  SNAPSHOT_VERSION_FIELDS,
  checkSnapshotVersions,
  compareSnapshotVersions,
  snapshotVersionsSchema,
  type SnapshotVersions,
} from "./snapshot-versions";

/** AC1.6：六项版本校验（契约 / 数据发布 / 供应商 / 模型 / 提示词 / 输出模式）。 */

const STORED: SnapshotVersions = {
  contract_version: "V1.1",
  data_release_id: "LOGIPLAN_2026_DEMO_V2",
  provider: "PROVIDER_A",
  model: "MODEL_A",
  prompt_version: "PROMPT_V1",
  output_schema_version: "G2_ANSWER_V1_0",
};

const expected = (field: (typeof SNAPSHOT_VERSION_FIELDS)[number]): SnapshotVersions => ({
  ...STORED,
  [field]: `${STORED[field]}_OTHER`,
});

describe("快照版本字段集合", () => {
  it("六项字段与顺序被冻结", () => {
    expect([...SNAPSHOT_VERSION_FIELDS]).toEqual([
      "contract_version",
      "data_release_id",
      "provider",
      "model",
      "prompt_version",
      "output_schema_version",
    ]);
    expect(SNAPSHOT_VERSION_FIELDS).toHaveLength(6);
  });

  it("版本元组必须字段齐全且不接受额外字段", () => {
    expect(snapshotVersionsSchema.safeParse(STORED).success).toBe(true);
    const incomplete = { ...STORED } as Record<string, string>;
    delete incomplete.prompt_version;
    expect(snapshotVersionsSchema.safeParse(incomplete).success).toBe(false);
    expect(
      snapshotVersionsSchema.safeParse({ ...STORED, adapter_version: "ADAPTER_1" }).success,
    ).toBe(false);
    for (const field of SNAPSHOT_VERSION_FIELDS) {
      expect(snapshotVersionsSchema.safeParse({ ...STORED, [field]: "" }).success, field).toBe(
        false,
      );
    }
  });
});

describe("六项校验的六个不一致分支", () => {
  it.each([...SNAPSHOT_VERSION_FIELDS])("%s 不一致即判定不可恢复", (field) => {
    const mismatches = compareSnapshotVersions(STORED, expected(field));
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.field).toBe(field);
    expect(mismatches[0]?.stored).toBe(STORED[field]);
    expect(mismatches[0]?.expected).toBe(`${STORED[field]}_OTHER`);
    expect(checkSnapshotVersions(STORED, expected(field)).matches).toBe(false);
  });

  it("六项全部不一致时逐项报出，不做任何部分放行", () => {
    const mismatches = compareSnapshotVersions(STORED, {
      contract_version: "V1.0",
      data_release_id: "LOGIPLAN_2026_DEMO_V1",
      provider: "PROVIDER_B",
      model: "MODEL_B",
      prompt_version: "PROMPT_V2",
      output_schema_version: "G2_ANSWER_V0_9",
    });
    expect(mismatches.map((mismatch) => mismatch.field)).toEqual([...SNAPSHOT_VERSION_FIELDS]);
    expect(checkSnapshotVersions(STORED, STORED).matches).toBe(true);
    expect(checkSnapshotVersions(STORED, STORED).mismatches).toEqual([]);
  });

  it("首尾字段的不一致分别落在路径首位与末位", () => {
    expect(compareSnapshotVersions(STORED, expected("contract_version"))[0]?.field).toBe(
      "contract_version",
    );
    expect(compareSnapshotVersions(STORED, expected("output_schema_version"))[0]?.field).toBe(
      "output_schema_version",
    );
  });
});
