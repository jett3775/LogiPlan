import { describe, expect, it } from "vitest";

import { managementAnalysisSchema, type ManagementAnalysis } from "@logiplan/contracts";

import {
  REQUIRED_LIMITATION_LABEL_ZH,
  ORDER_LEVEL_NOT_AVAILABLE_MESSAGE_ZH,
} from "../labels/zh-labels";
import {
  FIXED_EXAMPLE_EVALUATION_IDS,
  FIXED_EXAMPLE_EVALUATION_QUESTIONS,
  FIXED_EXAMPLE_SUPPORTED_NUMBERS,
} from "./evaluation-baseline";
import { buildFixedExampleAnalysis } from "./fixed-example";
import {
  findUnsupportedNumbers,
  findUnsupportedSavingsClaims,
  inspectAnswerText,
  isMoneyLikeToken,
  supportedFormsOf,
} from "./output-guards";

/**
 * AC1.4：固定示例覆盖 E01、E05—E10、E20；每条建议 `scenario_validation_status` 为
 * `NOT_RUN`；输出中不含任何未经情景计算支持的节省金额。
 *
 * AC1.3（部分）：`answer_type` 恒为 `FIXED_EXAMPLE`。
 */

const analysis = buildFixedExampleAnalysis();

/** 五个区块 + 建议；证据 ID 断言统一遍历这一组。 */
const fixedExampleSections = (
  value: ManagementAnalysis = analysis,
): readonly { readonly evidence_ids: readonly string[] }[] => [
  value.conclusion,
  value.evidence,
  value.impact,
  value.limitations,
  ...value.recommendations,
];

const narrativeTexts = (value: ManagementAnalysis): string[] => [
  value.scope_label,
  value.conclusion.text,
  value.evidence.text,
  value.impact.text,
  value.limitations.text,
  ...value.recommendations.map((recommendation) => recommendation.text),
];

describe("固定示例出口", () => {
  it("通过公共 Zod 模式校验，且每次构造返回独立对象", () => {
    const again = buildFixedExampleAnalysis();
    expect(managementAnalysisSchema.safeParse(analysis).success).toBe(true);
    expect(again).toEqual(analysis);
    expect(again).not.toBe(analysis);
  });

  it("覆盖 E01、E05—E10、E20 且顺序固定", () => {
    expect(FIXED_EXAMPLE_EVALUATION_IDS).toEqual([
      "E01",
      "E05",
      "E06",
      "E07",
      "E08",
      "E09",
      "E10",
      "E20",
    ]);
    expect(analysis.evaluation_question_ids).toEqual([...FIXED_EXAMPLE_EVALUATION_IDS]);
    expect(FIXED_EXAMPLE_EVALUATION_QUESTIONS.map((question) => question.id)).toEqual([
      ...FIXED_EXAMPLE_EVALUATION_IDS,
    ]);
  });

  it("每条建议一律标记 NOT_RUN 且可行性未验证", () => {
    expect(analysis.recommendations.length).toBeGreaterThan(0);
    for (const recommendation of analysis.recommendations) {
      expect(recommendation.scenario_validation_status).toBe("NOT_RUN");
      expect(recommendation.feasibility_status).toBe("NOT_VALIDATED");
      expect(recommendation.evidence_ids.length).toBeGreaterThan(0);
    }
  });

  it("输出中不含任何未经情景计算支持的节省金额或不可回指数字", () => {
    expect(inspectAnswerText(analysis, FIXED_EXAMPLE_SUPPORTED_NUMBERS)).toEqual([]);
  });

  it("守卫是有效的：编造的节省金额与额外数字都会被判违规", () => {
    const fabricated: ManagementAnalysis = {
      ...analysis,
      recommendations: [
        {
          ...(analysis.recommendations[0] ?? {
            text: "",
            evidence_ids: [],
            scenario_validation_status: "NOT_RUN" as const,
            feasibility_status: "NOT_VALIDATED" as const,
          }),
          text: "调整承运商结构预计可节省约 120,000 CNY。",
        },
      ],
    };
    const violations = inspectAnswerText(fabricated, FIXED_EXAMPLE_SUPPORTED_NUMBERS);
    expect(violations.map((violation) => violation.kind)).toContain("UNSUPPORTED_SAVINGS_AMOUNT");
    expect(
      inspectAnswerText(
        {
          ...analysis,
          impact: { ...analysis.impact, text: "本月承运商成本为 999,999.9999 CNY。" },
        },
        FIXED_EXAMPLE_SUPPORTED_NUMBERS,
      ).map((violation) => violation.value),
    ).toContain("999,999.9999");
  });

  it("「尚未做情景计算 / 不给出任何节省金额」这类否定陈述不算节省声明", () => {
    for (const recommendation of analysis.recommendations) {
      expect(recommendation.text).toContain("尚未做情景计算");
      expect(findUnsupportedSavingsClaims(recommendation.text)).toEqual([]);
    }
    // 每条建议都显式声明未做情景计算且不给出节省金额。
    expect(
      analysis.recommendations.filter((recommendation) =>
        recommendation.text.includes("不给出任何节省金额"),
      ),
    ).toHaveLength(analysis.recommendations.length);
  });

  it("守卫扫描非空：叙述里确实存在被逐个核对的金额与比例", () => {
    const narrative = narrativeTexts(analysis).join("\n");
    const moneyLike = [...narrative.matchAll(/[0-9][0-9,]*(?:\.[0-9]+)?/gu)].filter((match) =>
      isMoneyLikeToken(match[0], narrative.slice((match.index ?? 0) + match[0].length)),
    );
    // 评估基线里 E09 的 largest_component 是枚举值（BASE_FREIGHT），其余都是数字。
    const numericBaseline = FIXED_EXAMPLE_SUPPORTED_NUMBERS.filter((value) => /^\d/u.test(value));
    expect(moneyLike.length).toBeGreaterThanOrEqual(numericBaseline.length);
    expect(findUnsupportedNumbers(narrative, FIXED_EXAMPLE_SUPPORTED_NUMBERS)).toEqual([]);
  });

  it("每道引用题目的每个 required_number 都在叙述中出现", () => {
    const narrative = narrativeTexts(analysis).join("\n");
    for (const question of FIXED_EXAMPLE_EVALUATION_QUESTIONS) {
      for (const value of Object.values(question.required_numbers)) {
        if (!/^\d+(\.\d+)?$/u.test(value)) continue;
        // 千分位形式（891,643.2815）与百分比形式（13.69）都是合法呈现。
        const forms = supportedFormsOf(value).flatMap((form) => [
          form,
          Number(form).toLocaleString("en-US", {
            minimumFractionDigits: form.includes(".") ? (form.split(".")[1]?.length ?? 0) : 0,
            maximumFractionDigits: form.includes(".") ? (form.split(".")[1]?.length ?? 0) : 0,
            useGrouping: true,
          }),
        ]);
        expect(
          forms.some((form) => narrative.includes(form)),
          `${question.id} 的 ${value} 未出现在固定示例中（允许形式：${forms.join(" / ")}）`,
        ).toBe(true);
      }
    }
  });

  /**
   * P1-1 双源断言之一：ID 合法性只由**真实证据体系**判定。
   *
   * 前缀白名单归纳自 `packages/db` 的产出点
   * （`query-service.ts:1316/1349/1404/1412/1581/1874/1907`、
   * `diagnostic-metrics.ts:274-297`），与评估集无关，因此不会自我循环。
   * `packages/db/**` 不在可写范围，只能以静态前缀表锁定形态。
   */
  it("证据 ID 前缀属于 packages/db 真实产出的证据体系", () => {
    const realPrefixes = [
      /^E\d{2}-/u,
      /^ATTRIBUTION_BRIDGE:(VOLUME|MIX|EFFICIENCY|PRICE|FX)$/u,
      /^DIAGNOSTIC_METRICS:(ORDERS|AIR_SHARE|CARRIER_C_SHARE|ON_TIME_RATE|SERVICE_MATURITY):/u,
      /^ATTRIBUTION_DRILLDOWN:FC:[A-Z_]+$/u,
    ];
    const sections = fixedExampleSections();
    for (const section of sections) {
      expect(section.evidence_ids.length).toBeGreaterThan(0);
      for (const evidenceId of section.evidence_ids) {
        expect(
          realPrefixes.some((prefix) => prefix.test(evidenceId)),
          `证据 ${evidenceId} 不属于真实证据体系`,
        ).toBe(true);
      }
    }
  });

  /**
   * P1-1 双源断言之二：可回溯到评估集对应题目——作为**独立**的溯源检查。
   *
   * 评估集 `evidence` 字段（`country_summary|...`）是溯源标签，不是
   * `EvidenceObject.evidence_id`，所以这里只断言「每题都被引用、且输出未引用
   * 评估集范围外的题目」，不再拿它当 ID 合法性的依据。
   */
  it("每道固定示例题目都被 evaluation_question_ids 覆盖且引用范围未溢出", () => {
    expect(analysis.evaluation_question_ids).toEqual([...FIXED_EXAMPLE_EVALUATION_IDS]);
    const cited = new Set(analysis.evaluation_question_ids);
    for (const question of FIXED_EXAMPLE_EVALUATION_QUESTIONS) {
      expect(question.evidence.length, `${question.id} 缺少溯源标签`).toBeGreaterThan(0);
      expect(cited.has(question.id), `${question.id} 未被引用`).toBe(true);
    }
    for (const id of analysis.evaluation_question_ids) {
      expect(
        FIXED_EXAMPLE_EVALUATION_QUESTIONS.some((question) => question.id === id),
        `引用了固定示例范围外的题目 ${id}`,
      ).toBe(true);
    }
  });

  /**
   * P1-1：范围纪律。驾驶舱范围与公司口径发货仓范围的证据 ID 在本页不可解析
   * （`query-service.ts:2080` 的范围硬隔离），因此不得出现在固定示例里。
   */
  it("不引用驾驶舱范围或公司口径范围的证据 ID", () => {
    const forbidden = [
      "E04-total",
      "FIXED_COST_BREAKDOWN:",
      "MONTHLY_COST_TREND:",
      "TOP_ADVERSE_ANOMALIES:",
      "E08-",
    ];
    const used = fixedExampleSections().flatMap((section) => [...section.evidence_ids]);
    for (const prefix of forbidden) {
      expect(
        used.filter((evidenceId) => evidenceId.startsWith(prefix)),
        `${prefix} 不在固定示例范围（英国归因口径）内`,
      ).toEqual([]);
    }
  });

  it("限制标签含因果边界标签与订单粒度保护中文说明", () => {
    const labels = analysis.limitations.status_labels ?? [];
    expect(labels).toContain(REQUIRED_LIMITATION_LABEL_ZH);
    expect(labels.some((label) => label.includes(ORDER_LEVEL_NOT_AVAILABLE_MESSAGE_ZH))).toBe(true);
    expect(analysis.limitations.text).toContain(ORDER_LEVEL_NOT_AVAILABLE_MESSAGE_ZH);
    expect(JSON.stringify(analysis)).not.toContain("ORDER_LEVEL_NOT_AVAILABLE");
  });
});
