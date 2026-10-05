import { describe, expect, it } from "vitest";

import {
  AI_OUTPUT_SCHEMA_VERSION,
  aiAnswerTypeSchema,
  aiEvidenceSnapshotIdSchema,
  aiFeasibilityStatusSchema,
  aiOutputSchemaVersionSchema,
  aiScenarioValidationStatusSchema,
  managementAnalysisSchema,
  managementRecommendationSchema,
  richSectionSchema,
} from "@logiplan/contracts";

/**
 * AC1.2：闸门二新增输出模式的 schema 测试。
 *
 * 说明：既有 `packages/contracts/src/index.test.ts` 不在本切片写范围内，
 * 因此新模式的测试放在本包内；覆盖率仍按文件汇总，`packages/contracts` 的
 * 95% 阈值（D-178）不受影响。
 */

const RICH_SECTION = {
  text: "英国 2026 年 8 月履约变动成本不利差异 574,474.2232 CNY。",
  evidence_ids: ["country_summary|ACTUAL|2026-08|GB"],
  status_labels: ["相关性不等于因果 · 不得推断未记录的经营因果"],
} as const;

const RECOMMENDATION = {
  text: "复核空运与 Carrier C 的分配规则；尚未做情景计算，不给出任何节省金额。",
  evidence_ids: ["driver_facts|ACTUAL|2026-08|GB|management_action_note"],
  scenario_validation_status: "NOT_RUN",
  feasibility_status: "NOT_VALIDATED",
} as const;

const VALID_ANALYSIS = {
  answer_id: "ANSWER_FIXED_GB_2026_08_V1",
  answer_type: "FIXED_EXAMPLE",
  scope_label: "2026 年 8 月｜英国｜Actual vs Budget｜固定示例",
  conclusion: RICH_SECTION,
  evidence: RICH_SECTION,
  impact: RICH_SECTION,
  recommendations: [RECOMMENDATION],
  limitations: RICH_SECTION,
  evidence_snapshot_id: "SNAPSHOT_GB_2026_08_V1",
  evaluation_question_ids: ["E01", "E05", "E06", "E07", "E08", "E09", "E10", "E20"],
} as const;

const analysisWith = (overrides: Record<string, unknown>) => ({
  ...VALID_ANALYSIS,
  ...overrides,
});

describe("ManagementAnalysis 合法样例", () => {
  it("接受完整的固定示例形状", () => {
    const parsed = managementAnalysisSchema.parse(VALID_ANALYSIS);
    expect(parsed.answer_type).toBe("FIXED_EXAMPLE");
    expect(parsed.recommendations[0]?.scenario_validation_status).toBe("NOT_RUN");
    expect(parsed.evaluation_question_ids).toHaveLength(8);
    expect(managementAnalysisSchema.safeParse(parsed).success).toBe(true);
  });

  it("输出模式独立版本化，不吸收 V1.0/V1.1 契约版本字段", () => {
    expect(AI_OUTPUT_SCHEMA_VERSION).toBe("G2_ANSWER_V1_0");
    expect(aiOutputSchemaVersionSchema.safeParse("G2_ANSWER_V1_0").success).toBe(true);
    for (const wrong of ["V1.0", "V1.1", "G2_ANSWER_V1_1", "", null, 1]) {
      expect(aiOutputSchemaVersionSchema.safeParse(wrong).success).toBe(false);
    }
    const parsed = managementAnalysisSchema.parse(VALID_ANALYSIS);
    expect(Object.keys(parsed)).not.toContain("contract_version");
    expect(
      managementAnalysisSchema.safeParse(analysisWith({ contract_version: "V1.1" })).success,
    ).toBe(false);
  });
});

describe("ManagementAnalysis 拒绝缺字段", () => {
  it("十个必填字段逐个缺失都必须失败", () => {
    for (const field of Object.keys(VALID_ANALYSIS)) {
      const incomplete: Record<string, unknown> = { ...VALID_ANALYSIS };
      delete incomplete[field];
      expect(managementAnalysisSchema.safeParse(incomplete).success, `缺少 ${field}`).toBe(false);
    }
  });

  it("枚举成员与推荐字段缺失都必须失败", () => {
    for (const field of Object.keys(RECOMMENDATION)) {
      const incomplete: Record<string, unknown> = { ...RECOMMENDATION };
      delete incomplete[field];
      expect(managementRecommendationSchema.safeParse(incomplete).success, `缺少 ${field}`).toBe(
        false,
      );
    }
    for (const field of ["text", "evidence_ids"]) {
      const incomplete: Record<string, unknown> = { ...RICH_SECTION };
      delete incomplete[field];
      expect(richSectionSchema.safeParse(incomplete).success, `缺少 ${field}`).toBe(false);
    }
  });

  it("status_labels 是唯一可选字段，省略后仍合法（query-contract §10）", () => {
    const withoutLabels: Record<string, unknown> = { ...RICH_SECTION };
    delete withoutLabels.status_labels;
    expect(richSectionSchema.safeParse(withoutLabels).success).toBe(true);
    expect(richSectionSchema.safeParse({ ...RICH_SECTION, status_labels: undefined }).success).toBe(
      true,
    );
  });
});

describe("ManagementAnalysis 拒绝多字段", () => {
  it("顶层、RichSection 与建议上的未知字段都必须失败", () => {
    expect(managementAnalysisSchema.safeParse(analysisWith({ internal_note: "x" })).success).toBe(
      false,
    );
    expect(
      managementAnalysisSchema.safeParse(
        analysisWith({ conclusion: { ...RICH_SECTION, extra: true } }),
      ).success,
    ).toBe(false);
    expect(
      managementRecommendationSchema.safeParse({ ...RECOMMENDATION, provider: "x" }).success,
    ).toBe(false);
    expect(richSectionSchema.safeParse({ ...RICH_SECTION, order_level_top: 10 }).success).toBe(
      false,
    );
  });
});

describe("ManagementAnalysis 拒绝错误枚举值", () => {
  it("answer_type 与状态枚举必须精确匹配", () => {
    for (const value of ["FIXED", "fixed_example", "LIVE", "", null, 1, {}]) {
      expect(managementAnalysisSchema.safeParse(analysisWith({ answer_type: value })).success).toBe(
        false,
      );
    }
    for (const value of ["NOT_RUN_DONE", "not_run", "", null]) {
      expect(
        managementRecommendationSchema.safeParse({
          ...RECOMMENDATION,
          scenario_validation_status: value,
        }).success,
      ).toBe(false);
    }
    for (const value of ["VALID", "validated", "", null]) {
      expect(
        managementRecommendationSchema.safeParse({
          ...RECOMMENDATION,
          feasibility_status: value,
        }).success,
      ).toBe(false);
    }
    expect(aiAnswerTypeSchema.options).toEqual(["FIXED_EXAMPLE", "LIVE_GENERATED"]);
    expect(aiScenarioValidationStatusSchema.options).toEqual(["NOT_RUN", "RUN"]);
    expect(aiFeasibilityStatusSchema.options).toEqual([
      "NOT_VALIDATED",
      "PARTIALLY_VALIDATED",
      "VALIDATED",
    ]);
  });
});

describe("ManagementAnalysis 拒绝空字符串与空白字符串", () => {
  it("所有文本字段的空值都必须失败", () => {
    for (const value of ["", " ", "\t\n"]) {
      expect(richSectionSchema.safeParse({ ...RICH_SECTION, text: value }).success).toBe(false);
      expect(
        managementRecommendationSchema.safeParse({ ...RECOMMENDATION, text: value }).success,
      ).toBe(false);
      expect(managementAnalysisSchema.safeParse(analysisWith({ scope_label: value })).success).toBe(
        false,
      );
      expect(managementAnalysisSchema.safeParse(analysisWith({ answer_id: value })).success).toBe(
        false,
      );
      expect(
        managementAnalysisSchema.safeParse(analysisWith({ evidence_snapshot_id: value })).success,
      ).toBe(false);
      expect(richSectionSchema.safeParse({ ...RICH_SECTION, status_labels: [value] }).success).toBe(
        false,
      );
      expect(
        richSectionSchema.safeParse({
          ...RICH_SECTION,
          evidence_ids: [value],
        }).success,
      ).toBe(false);
      expect(
        richSectionSchema.safeParse({
          ...RICH_SECTION,
          status_labels: [],
        }).success,
      ).toBe(false);
    }
    expect(aiEvidenceSnapshotIdSchema.safeParse(" ").success).toBe(false);
  });
});

describe("ManagementAnalysis 拒绝超长字符串与超量集合", () => {
  it("文本长度上限必须生效", () => {
    expect(richSectionSchema.safeParse({ ...RICH_SECTION, text: "x".repeat(2_001) }).success).toBe(
      false,
    );
    expect(richSectionSchema.safeParse({ ...RICH_SECTION, text: "x".repeat(2_000) }).success).toBe(
      true,
    );
    expect(
      managementRecommendationSchema.safeParse({ ...RECOMMENDATION, text: "x".repeat(1_001) })
        .success,
    ).toBe(false);
    expect(
      managementAnalysisSchema.safeParse(analysisWith({ scope_label: "x".repeat(121) })).success,
    ).toBe(false);
    expect(
      managementAnalysisSchema.safeParse(analysisWith({ answer_id: "x".repeat(121) })).success,
    ).toBe(false);
    expect(
      managementAnalysisSchema.safeParse(analysisWith({ evidence_snapshot_id: "x".repeat(121) }))
        .success,
    ).toBe(false);
    expect(
      richSectionSchema.safeParse({ ...RICH_SECTION, status_labels: ["x".repeat(121)] }).success,
    ).toBe(false);
    expect(
      richSectionSchema.safeParse({
        ...RICH_SECTION,
        evidence_ids: ["x".repeat(121)],
      }).success,
    ).toBe(false);
  });

  it("集合长度上限必须生效", () => {
    expect(
      richSectionSchema.safeParse({
        ...RICH_SECTION,
        evidence_ids: Array.from({ length: 51 }, (_unused, index) => `e${index}`),
      }).success,
    ).toBe(false);
    expect(
      richSectionSchema.safeParse({
        ...RICH_SECTION,
        status_labels: Array.from({ length: 11 }, (_unused, index) => `标签${index}`),
      }).success,
    ).toBe(false);
    expect(managementAnalysisSchema.safeParse(analysisWith({ recommendations: [] })).success).toBe(
      false,
    );
    expect(
      managementAnalysisSchema.safeParse(
        analysisWith({
          recommendations: Array.from({ length: 21 }, () => RECOMMENDATION),
        }),
      ).success,
    ).toBe(false);
    expect(
      managementRecommendationSchema.safeParse({
        ...RECOMMENDATION,
        evidence_ids: Array.from({ length: 21 }, (_unused, index) => `e${index}`),
      }).success,
    ).toBe(false);
    expect(
      managementAnalysisSchema.safeParse(analysisWith({ evaluation_question_ids: [] })).success,
    ).toBe(false);
    expect(
      managementAnalysisSchema.safeParse(
        analysisWith({
          evaluation_question_ids: Array.from({ length: 21 }, (_unused, index) => `E${index}`),
        }),
      ).success,
    ).toBe(false);
  });

  it("评估题 ID 必须是 E01—E20", () => {
    for (const value of ["E1", "E00", "E21", "e01", "01", "", " E01"]) {
      expect(
        managementAnalysisSchema.safeParse(analysisWith({ evaluation_question_ids: [value] }))
          .success,
      ).toBe(false);
    }
    expect(
      managementAnalysisSchema.safeParse(analysisWith({ evaluation_question_ids: ["E01", "E20"] }))
        .success,
    ).toBe(true);
  });
});
