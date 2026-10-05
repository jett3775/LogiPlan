import { readFileSync } from "node:fs";
import { join } from "node:path";

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
   * P1-1 断言 (a)：ID 合法性只由**真实证据体系**判定，且是回归锁之一。
   *
   * 前缀白名单归纳自 `packages/db` 的产出点
   * （`query-service.ts:1316/1349/1404/1412/1581/1874/1907`、
   * `diagnostic-metrics.ts:274-297`），与评估集无关，因此不会自我循环。
   * `packages/db/**` 不在可写范围，只能以静态前缀表锁定形态。
   *
   * 本条只锁**形态族**；逐字存在性由下面「源码产出点命中」用例负责。
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
   * 题目覆盖检查（**不是** ID 合法性的依据，也不构成独立回归锁）。
   *
   * 评估集 `evidence` 字段（`country_summary|...`）是溯源标签，不是
   * `EvidenceObject.evidence_id`，故本用例只检查题目 ID 的双向覆盖。
   *
   * 已知局限：这条断言**恒真**——`analysis.evaluation_question_ids` 直接来自
   * `FIXED_EXAMPLE_EVALUATION_IDS`，而 `FIXED_EXAMPLE_EVALUATION_QUESTIONS` 也由同一
   * 列表派生，三者同源。保留它是为了锁住「固定示例引用的题号集合不漂移」这一意图，
   * 但它检不出任何 P1-1 缺陷。真正的 P1-1 回归锁只有上面那条形态族校验与下面那条
   * 越界族负向断言。
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
   * P1-1 断言 (c)：范围纪律（负向），是回归锁之二。
   *
   * 驾驶舱范围与公司口径发货仓范围的证据 ID 在本页不可解析
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

  /**
   * P1-1 残留收口：把形态族校验升级为**逐字存在性**校验。
   *
   * 形态族校验会漏掉三类漂移（形态都合法，只是取值不存在）：
   * `E01-country`→`E01-typo`、`…:CURRENT`→`…:NONEXISTENT`、
   * `FC:FR_FC`→`FC:XX_FC`。
   *
   * ## ID 划分方式
   *
   * `packages/db` 用两种方式构造证据 ID，两类都归入同一个可枚举集合：
   *
   * 1. **字面量构造** —— `evidence("E01-country", …)`（`query-service.ts:1349`）、
   *    `evidence_id: "FIXED_COST_BREAKDOWN:TOTAL"`（`:1146`）、
   *    `diagnostic-metrics.ts:274-296` 的 `"DIAGNOSTIC_METRICS:<指标>:<槽位>"`。
   *    源码里存在完整字符串 → 直接逐字命中。
   * 2. **模板构造** —— `` `ATTRIBUTION_BRIDGE:${factor.factor_id}` ``（`:1411`）、
   *    `` `ATTRIBUTION_DRILLDOWN:${rowId}` ``（`:1581`、`:1802`）。取值来自数据，
   *    源码里不存在完整字符串；但**取值槽位本身是源码里的枚举常量**：
   *    `factorIds`（`:1425`，五因素）与 `drilldownLabels.fulfillmentCenter`
   *    （`:1482`，真实发货仓）。因此把「模板 × 槽位枚举」展开成完整 ID 集合，
   *    仍可逐字比对——比只比前缀更强：`FC:XX_FC` 的槽位 `XX_FC` 不在发货仓枚举内，
   *    前缀匹配会漏，逐字匹配不会。
   *
   * 只读源码文本，不 import `packages/db`：`gate2-design.md` §1.1 的单向依赖不允许
   * 反向依赖。静态扫描沿用 `neutral-boundary.test.ts` 已有的 `readFileSync` 模式，
   * 零 DB、零新依赖。
   */
  const dbEvidenceSource = (): string =>
    ["query-service.ts", "diagnostic-metrics.ts"]
      .map((name) =>
        readFileSync(join(import.meta.dirname, "..", "..", "..", "db", "src", name), "utf8"),
      )
      .join("\n");

  /** 从 `packages/db` 源码枚举出全部**可判定**的真实证据 ID 集合。 */
  const realEvidenceIdsFromSource = (): ReadonlySet<string> => {
    const source = dbEvidenceSource();
    const ids = new Set<string>();
    // (1) 字面量产出点：`evidence("X"`、`evidence_id: "X"`，以及
    // `diagnostic-metrics.ts:274` 的 `evidenceIds` 字面量表。
    for (const match of source.matchAll(/evidence(?:_id)?:\s*"([^"]+)"|evidence\(\s*"([^"]+)"/gu)) {
      ids.add(match[1] ?? match[2] ?? "");
    }
    const diagnosticTable = /const evidenceIds = \{([\s\S]*?)\} as const/u.exec(source)?.[1] ?? "";
    for (const match of diagnosticTable.matchAll(/"(DIAGNOSTIC_METRICS:[^"]+)"/gu)) {
      ids.add(match[1] ?? "");
    }
    // (2) 模板槽位枚举：五因素与真实发货仓都写死在源码常量里。
    const factors = /const factorIds = \[([^\]]+)\]/u.exec(source)?.[1] ?? "";
    for (const match of factors.matchAll(/"([A-Z_]+)"/gu)) {
      ids.add(`ATTRIBUTION_BRIDGE:${match[1] ?? ""}`);
    }
    const centers = /fulfillmentCenter:\s*\{([^}]*)\}/u.exec(source)?.[1] ?? "";
    for (const match of centers.matchAll(/([A-Z][A-Z_]*):/gu)) {
      ids.add(`ATTRIBUTION_DRILLDOWN:FC:${match[1] ?? ""}`);
    }
    ids.delete("");
    return ids;
  };

  /** (a) 的形态族判定；保留用于对照，见下一条自证用例。 */
  const passesShapeFamily = (id: string): boolean =>
    /^E\d{2}-/u.test(id) ||
    /^ATTRIBUTION_BRIDGE:(VOLUME|MIX|EFFICIENCY|PRICE|FX)$/u.test(id) ||
    /^DIAGNOSTIC_METRICS:(ORDERS|AIR_SHARE|CARRIER_C_SHARE|ON_TIME_RATE|SERVICE_MATURITY):/u.test(
      id,
    ) ||
    /^ATTRIBUTION_DRILLDOWN:FC:[A-Z_]+$/u.test(id);

  it("每个证据 ID 都逐字命中 packages/db 源码中的 evidence_id 产出点", () => {
    const realIds = realEvidenceIdsFromSource();
    // 集合非空且覆盖两类构造，防止扫描正则整体失配后一律放行。
    expect(realIds.has("E01-country")).toBe(true);
    expect(realIds.has("E05-bridge")).toBe(true);
    expect(realIds.has("DIAGNOSTIC_METRICS:SERVICE_MATURITY:CURRENT")).toBe(true);
    expect(realIds.has("ATTRIBUTION_BRIDGE:MIX")).toBe(true);
    expect(realIds.has("ATTRIBUTION_DRILLDOWN:FC:DE_FC")).toBe(true);
    expect(realIds.has("ATTRIBUTION_DRILLDOWN:FC:FR_FC")).toBe(true);

    const used = [...new Set(fixedExampleSections().flatMap((s) => [...s.evidence_ids]))];
    expect(used.length).toBeGreaterThan(0);
    for (const id of used) {
      expect(realIds.has(id), `${id} 未逐字命中 packages/db 的 evidence_id 产出点`).toBe(true);
    }
  });

  /**
   * 上一条的**自证**：三类漂移必须被逐字校验拒绝，证明它不是恒真。
   * 这三例在形态族校验下全部漏网——断言同时记录两者的差异。
   */
  it("逐字校验能捕获形态族校验漏掉的三类漂移", () => {
    const realIds = realEvidenceIdsFromSource();
    for (const [real, drifted, why] of [
      ["E01-country", "E01-typo", "字面量 ID 拼写漂移"],
      [
        "DIAGNOSTIC_METRICS:SERVICE_MATURITY:CURRENT",
        "DIAGNOSTIC_METRICS:SERVICE_MATURITY:NONEXISTENT",
        "模板槽位取值不存在",
      ],
      [
        "ATTRIBUTION_DRILLDOWN:FC:FR_FC",
        "ATTRIBUTION_DRILLDOWN:FC:XX_FC",
        "发货仓槽位不是真实取值",
      ],
    ] as const) {
      // 真实取值必须通过，确保不是「一律拒绝」。
      expect(passesShapeFamily(real), why).toBe(true);
      expect(realIds.has(real), why).toBe(true);
      // 三例漂移在形态族校验下全部漏网。
      expect(passesShapeFamily(drifted), `${why}：形态族校验漏网`).toBe(true);
      // 逐字校验必须拒绝。
      expect(realIds.has(drifted), `${why}：逐字校验未拦截`).toBe(false);
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
