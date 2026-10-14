import { managementAnalysisSchema, type ManagementAnalysis } from "@logiplan/contracts";

import {
  findUnsupportedNumbers,
  normalizeNumberToken,
  supportedFormsOf,
} from "../fixed-example/output-guards";
import {
  ORDER_LEVEL_NOT_AVAILABLE_MESSAGE_ZH,
  REQUIRED_LIMITATION_LABEL_ZH,
} from "../labels/zh-labels";
import {
  allWhitelistedEvidenceIds,
  whitelistIsSingleScope,
  type EvidenceWhitelist,
} from "./evidence-port";

/**
 * 输出三检（docs/gate2-design.md §4.3；AC3.5—AC3.8）。
 *
 * 三检按序执行，**任一不过即整体失败**：调用方（网关）必须整体丢弃模型输出并回落固定
 * 示例，**不得**裁剪、修补或部分展示（§4.3、AC3.7），也**不得**把失败结果标为真实生成
 * （AC3.8）。本模块只做机械判定，不做语义判断。
 *
 * | 检 | 内容 | 失败码 |
 * | -- | ---- | ------ |
 * | ① | 公共 Zod 模式（`ManagementAnalysis`，含五区块完整字段） | `SCHEMA_VALIDATION_FAILED` |
 * | ①b | 输出契约（§4.4 的中文 `limitations` 与建议状态） | `SCHEMA_VALIDATION_FAILED` |
 * | ② | 证据白名单（只能取自注入白名单） | `EVIDENCE_WHITELIST_VIOLATION` |
 * | ③ | 数值回指（同一次确定性结果；额外数字 / 跨结果集 / 范围不一致） | `NUMERIC_MISMATCH` |
 *
 * 失败原因只记录**机械分类**，绝不携带任何正文、证据值或数字（D-138 日志边界）。
 */

export type OutputCheckCode =
  "SCHEMA_VALIDATION_FAILED" | "EVIDENCE_WHITELIST_VIOLATION" | "NUMERIC_MISMATCH";

export type NumericFailureReason =
  "scope_anchor_mismatch" | "extra_number" | "cross_result_set_number";

export interface OutputCheckFailure {
  readonly code: OutputCheckCode;
  /** 机械细分原因；不含正文、证据值或具体数字（D-138）。 */
  readonly reason: string;
}

export type OutputCheckResult =
  | { readonly ok: true; readonly analysis: ManagementAnalysis }
  | { readonly ok: false; readonly failure: OutputCheckFailure };

const fail = (code: OutputCheckCode, reason: string): OutputCheckResult => ({
  ok: false,
  failure: { code, reason },
});

/** 输出中的全部陈述文本（与 `fixed-example/output-guards.ts` 的扫描面一致）。 */
export const answerStatementTexts = (analysis: ManagementAnalysis): readonly string[] => [
  analysis.scope_label,
  analysis.conclusion.text,
  analysis.evidence.text,
  analysis.impact.text,
  analysis.limitations.text,
  ...analysis.recommendations.map((recommendation) => recommendation.text),
];

/** 输出引用的全部证据 ID（五区块 + 建议）。 */
export const citedEvidenceIds = (analysis: ManagementAnalysis): readonly string[] => [
  ...analysis.conclusion.evidence_ids,
  ...analysis.evidence.evidence_ids,
  ...analysis.impact.evidence_ids,
  ...analysis.limitations.evidence_ids,
  ...analysis.recommendations.flatMap((recommendation) => recommendation.evidence_ids),
];

/**
 * ①b 输出契约（§4.4）：`limitations` 必含强制限制标签与订单粒度保护中文说明，
 * 且建议的 `scenario_validation_status` 首期一律 `NOT_RUN`。
 */
const checkOutputContract = (analysis: ManagementAnalysis): OutputCheckFailure | null => {
  const limitationLabels = analysis.limitations.status_labels ?? [];
  const limitationTexts = [analysis.limitations.text, ...limitationLabels];
  if (!limitationLabels.includes(REQUIRED_LIMITATION_LABEL_ZH)) {
    return { code: "SCHEMA_VALIDATION_FAILED", reason: "required_limitation_label_missing" };
  }
  if (!limitationTexts.some((text) => text.includes(ORDER_LEVEL_NOT_AVAILABLE_MESSAGE_ZH))) {
    return { code: "SCHEMA_VALIDATION_FAILED", reason: "order_level_protection_missing" };
  }
  if (analysis.recommendations.some((r) => r.scenario_validation_status !== "NOT_RUN")) {
    return {
      code: "SCHEMA_VALIDATION_FAILED",
      reason: "scenario_validation_status_not_run_required",
    };
  }
  return null;
};

/** ② 证据白名单：出现未知证据即失败。 */
const checkEvidenceWhitelist = (
  analysis: ManagementAnalysis,
  whitelist: EvidenceWhitelist,
): OutputCheckFailure | null => {
  const whitelisted = new Set(allWhitelistedEvidenceIds(whitelist));
  const unknownCount = citedEvidenceIds(analysis).filter((id) => !whitelisted.has(id)).length;
  return unknownCount === 0
    ? null
    : { code: "EVIDENCE_WHITELIST_VIOLATION", reason: `unknown_evidence_id_count=${unknownCount}` };
};

/**
 * ③ 数值回指：输出中每个金额/比例数字都必须回指**同一次**确定性结果。
 *
 * - 范围不一致（白名单整体锚点 ≠ 请求锚点，或白名单内部锚点不一致）→ `scope_anchor_mismatch`。
 * - 输出引用某结果集的证据，却使用了**未被引用结果集**里的数字 → `cross_result_set_number`
 *   （AC3.6：跨结果集引用同一数字必须失败）。
 * - 数字不在任何结果集里 → `extra_number`（AC3.5）。
 */
const checkNumericTraceback = (
  analysis: ManagementAnalysis,
  whitelist: EvidenceWhitelist,
  expectedScopeAnchor: string,
): OutputCheckFailure | null => {
  if (whitelist.scope_anchor !== expectedScopeAnchor) {
    return { code: "NUMERIC_MISMATCH", reason: "scope_anchor_mismatch" };
  }
  if (!whitelistIsSingleScope(whitelist)) {
    return { code: "NUMERIC_MISMATCH", reason: "scope_anchor_mismatch" };
  }

  const cited = new Set(citedEvidenceIds(analysis));
  const referencedSets = whitelist.result_sets.filter((set) =>
    set.evidence_ids.some((id) => cited.has(id)),
  );
  const referencedNumbers = referencedSets.flatMap((set) => set.numbers);
  const anySetNumbers = new Set(
    whitelist.result_sets.flatMap((set) => set.numbers.flatMap(supportedFormsOf)),
  );

  const violations = answerStatementTexts(analysis).flatMap((text) =>
    findUnsupportedNumbers(text, referencedNumbers),
  );
  if (violations.length === 0) return null;

  const isCrossResultSet = violations.some((violation) =>
    anySetNumbers.has(normalizeNumberToken(violation.value)),
  );
  return {
    code: "NUMERIC_MISMATCH",
    reason: isCrossResultSet ? "cross_result_set_number" : "extra_number",
  };
};

export interface OutputChecksInput {
  readonly output: unknown;
  readonly evidence: EvidenceWhitelist;
  /** 调用方请求的范围锚点；与白名单锚点比对（范围不一致即失败）。 */
  readonly expectedScopeAnchor: string;
}

/**
 * 依次执行输出三检。任一不过即返回失败（整体丢弃语义由调用方保证）。
 * `ManagementAnalysis` 类型不在这里凭空断言——只有 ① 通过后才用解析结果做后续两检。
 */
export const runOutputChecks = (input: OutputChecksInput): OutputCheckResult => {
  const parsed = managementAnalysisSchema.safeParse(input.output);
  if (!parsed.success) return fail("SCHEMA_VALIDATION_FAILED", "schema_parse_failed");

  const contractFailure = checkOutputContract(parsed.data);
  if (contractFailure !== null) return { ok: false, failure: contractFailure };

  const evidenceFailure = checkEvidenceWhitelist(parsed.data, input.evidence);
  if (evidenceFailure !== null) return { ok: false, failure: evidenceFailure };

  const numericFailure = checkNumericTraceback(
    parsed.data,
    input.evidence,
    input.expectedScopeAnchor,
  );
  if (numericFailure !== null) return { ok: false, failure: numericFailure };

  return { ok: true, analysis: parsed.data };
};
