import { z } from "zod";

export const compatibilityStatusSchema = z
  .object({
    state: z.literal("ready"),
  })
  .strict();

export type CompatibilityStatus = z.infer<typeof compatibilityStatusSchema>;

export const dataSeriesSchema = z.enum([
  "BUDGET",
  "ACTUAL",
  "FORECAST",
  "LATEST_OUTLOOK",
  "SCENARIO_BASE",
  "SCENARIO_GROWTH",
  "SCENARIO_COST_SAVING",
]);
export const comparisonSchema = z.enum([
  "ACTUAL_VS_BUDGET",
  "LATEST_OUTLOOK_VS_BUDGET",
  "FORECAST_VS_BUDGET",
  "SCENARIO_GROWTH_VS_FORECAST",
  "SCENARIO_COST_SAVING_VS_FORECAST",
]);
export const dimensionSchema = z.enum([
  "MONTH",
  "DESTINATION_COUNTRY",
  "FULFILLMENT_CENTER",
  "TRANSPORT_MODE",
  "CARRIER",
  "COST_COMPONENT",
  "FIXED_COST_CATEGORY",
]);
export const attributionFactorSchema = z.enum(["VOLUME", "MIX", "EFFICIENCY", "PRICE", "FX"]);
export const questionTypeSchema = z.enum([
  "DASHBOARD_OVERVIEW",
  "MONTHLY_COST_TREND",
  "TOP_ADVERSE_ANOMALIES",
  "FIXED_COST_BREAKDOWN",
  "WAREHOUSE_VARIANCE_CONTEXT",
  "COUNTRY_VARIANCE_SUMMARY",
  "ATTRIBUTION_BRIDGE",
  "ATTRIBUTION_DRILLDOWN",
  "DIAGNOSTIC_METRICS",
  "EVIDENCE_LOOKUP",
  "MANAGEMENT_ANALYSIS",
]);
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "月份必须为 YYYY-MM");
const idListSchema = z.array(z.string().min(1).max(80)).max(100).optional();
const nonBlankStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
export const analysisScopeSchema = z
  .object({
    period: z
      .object({ from: monthSchema, to: monthSchema, grain: z.enum(["MONTH", "RANGE"]) })
      .strict(),
    comparison: comparisonSchema,
    destination_country_ids: idListSchema,
    fulfillment_center_ids: idListSchema,
    transport_mode_ids: idListSchema,
    carrier_ids: idListSchema,
    cost_component_ids: idListSchema,
    factor_id: attributionFactorSchema.optional(),
    budget_version_id: z.string().min(1).max(120),
    actual_version_id: z.string().min(1).max(120).optional(),
    forecast_version_id: z.string().min(1).max(120).optional(),
    scenario_version_id: z.string().min(1).max(120).optional(),
    calculation_version: z.string().min(1).max(120),
  })
  .strict();
const queryIntentFields = {
  question_type: questionTypeSchema,
  scope: analysisScopeSchema,
  metrics: z.array(z.string().min(1).max(80)).max(50),
  group_by: z.array(dimensionSchema).max(6),
  top_n: z.number().int().min(1).max(100).optional(),
  output_locale: z.literal("zh-CN"),
  context_sources: z.array(z.enum(["USER", "PAGE_VISIBLE_STATE", "FIXED_TEMPLATE"])).max(3),
} as const;
export const evidenceSnapshotIdSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => value.trim().length > 0, "快照 ID 不能全为空白")
  .refine((value) => value.trim() === value, "快照 ID 不得包含首尾空格");
export const queryIntentV1Schema = z.object(queryIntentFields).strict();
export const queryIntentV11Schema = z
  .object({
    contract_version: z.literal("V1.1"),
    ...queryIntentFields,
    evidence_snapshot_id: evidenceSnapshotIdSchema.optional(),
    evidence_id: z
      .string()
      .min(1)
      .max(240)
      .refine((value) => value.trim() === value, "evidence_id 不得包含首尾空格")
      .optional(),
  })
  .strict()
  .superRefine((intent, context) => {
    if (intent.question_type !== "EVIDENCE_LOOKUP" && intent.evidence_snapshot_id !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["evidence_snapshot_id"],
        message: "只有 EVIDENCE_LOOKUP 可以提供 evidence_snapshot_id",
      });
    }
    if (intent.question_type === "EVIDENCE_LOOKUP" && intent.evidence_id === undefined) {
      context.addIssue({
        code: "custom",
        path: ["evidence_id"],
        message: "EVIDENCE_LOOKUP 必须提供 evidence_id",
      });
    }
    if (intent.question_type !== "EVIDENCE_LOOKUP" && intent.evidence_id !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["evidence_id"],
        message: "只有 EVIDENCE_LOOKUP 可以提供 evidence_id",
      });
    }
  });
export const queryIntentSchema = z.union([queryIntentV11Schema, queryIntentV1Schema]);
export const queryContractVersionSchema = z.enum(["V1.0", "V1.1"]);
export const moneyValueSchema = z
  .object({
    high_precision: z.string(),
    report: z.string(),
    display: z.string(),
    currency: z.literal("CNY"),
  })
  .strict();
export const decimalValueSchema = z
  .object({
    high_precision: z.string(),
    report: z.string(),
    display: z.string(),
    unit: z.enum(["RATIO", "PERCENT", "PERCENTAGE_POINT"]),
  })
  .strict();
export const evidenceObjectSchema = z
  .object({
    evidence_id: z.string(),
    evidence_snapshot_id: evidenceSnapshotIdSchema.optional(),
    data_release_id: z.string().min(1).optional(),
    metric: z.string(),
    value: z.string(),
    unit: z.string(),
    period: z.object({ from: monthSchema, to: monthSchema }).strict(),
    comparison: comparisonSchema,
    filters: z.record(z.string(), z.array(z.string())),
    group_by: z.array(dimensionSchema),
    versions: z
      .object({
        budget: z.string(),
        actual: z.string().optional(),
        forecast: z.string().optional(),
        scenario: z.string().optional(),
        calculation: z.string(),
      })
      .strict(),
    calculation_method: z.string(),
    source_result_id: z.string(),
    snapshot_generated_at: z.string(),
    source_refs: z.array(z.string()),
  })
  .strict();
const evidenceObjectV1Schema = evidenceObjectSchema.omit({
  evidence_snapshot_id: true,
  data_release_id: true,
});
const evidenceObjectV11Schema = evidenceObjectSchema.extend({
  evidence_id: nonBlankStringSchema,
  value: nonBlankStringSchema,
  evidence_snapshot_id: evidenceSnapshotIdSchema,
  data_release_id: nonBlankStringSchema,
  source_result_id: nonBlankStringSchema,
});
export const resultWarningSchema = z
  .object({
    code: z.enum([
      "SERVICE_NOT_MATURE",
      "CAPACITY_NOT_VALIDATED",
      "HISTORICAL_VERSION",
      "REPORT_ROUNDING",
    ]),
    message: z.string(),
  })
  .strict();
const deterministicResultFields = {
  result_id: z.string().min(1),
  scope_label: z.string(),
  data_as_of: z.string(),
  generated_at: z.string(),
  reporting_currency: z.literal("CNY"),
  precision: z
    .object({
      calculation: z.literal("HIGH_PRECISION_DECIMAL"),
      report_places: z.literal(4),
      display_places: z.literal(2),
    })
    .strict(),
  payload: z.unknown(),
  warnings: z.array(resultWarningSchema),
} as const;
const payloadEvidenceIssue = (
  result: {
    contract_version: QueryContractVersion;
    query_intent: QueryIntent;
    payload: unknown;
    evidence: unknown[];
  },
  context: z.RefinementCtx,
  evidenceSchema: z.ZodType = evidenceObjectV11Schema,
) => {
  const payload =
    result.payload !== null && typeof result.payload === "object" && !Array.isArray(result.payload)
      ? (result.payload as Record<string, unknown>)
      : undefined;
  const payloadEvidence = payload?.evidence;
  const hasPayloadEvidence = payload !== undefined && "evidence" in payload;
  if (result.contract_version === "V1.0" && hasPayloadEvidence) {
    context.addIssue({
      code: "custom",
      path: ["payload", "evidence"],
      message: "V1.0 payload 不得包含 evidence",
    });
    return;
  }
  if (result.query_intent.question_type === "EVIDENCE_LOOKUP") {
    if (payload === undefined || !("evidence" in payload)) {
      context.addIssue({
        code: "custom",
        path: ["payload", "evidence"],
        message: "EVIDENCE_LOOKUP payload 必须包含 evidence",
      });
      return;
    }
    const parsedPayloadEvidence = evidenceSchema.safeParse(payloadEvidence);
    if (!parsedPayloadEvidence.success) {
      context.addIssue({
        code: "custom",
        path: ["payload", "evidence"],
        message: "EVIDENCE_LOOKUP payload.evidence 不符合 V1.1 证据结构",
      });
      return;
    }
    if (result.evidence.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "EVIDENCE_LOOKUP 必须只有一个对应的顶层 evidence",
      });
      return;
    }
    const parsedTopEvidence = evidenceSchema.safeParse(result.evidence[0]);
    if (
      !parsedTopEvidence.success ||
      JSON.stringify(canonicalizeForComparison(parsedTopEvidence.data)) !==
        JSON.stringify(canonicalizeForComparison(parsedPayloadEvidence.data))
    ) {
      context.addIssue({
        code: "custom",
        path: ["payload", "evidence"],
        message: "payload.evidence 必须与顶层 evidence 完全一致",
      });
    }
  } else if (payload !== undefined && "evidence" in payload) {
    context.addIssue({
      code: "custom",
      path: ["payload", "evidence"],
      message: "只有 EVIDENCE_LOOKUP payload 可以包含 evidence",
    });
  }
};
const canonicalizeForComparison = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeForComparison);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalizeForComparison(child)]),
    );
  }
  return value;
};
const deterministicResultEnvelope = z
  .object({
    contract_version: queryContractVersionSchema,
    query_intent: queryIntentSchema,
    evidence: z.array(evidenceObjectSchema),
    ...deterministicResultFields,
  })
  .strict();
export const deterministicResultSchema = deterministicResultEnvelope.superRefine(
  (result, context) => {
    const isV11 = result.contract_version === "V1.1";
    const intentIsV11 = "contract_version" in result.query_intent;
    if (isV11 !== intentIsV11) {
      context.addIssue({
        code: "custom",
        path: ["query_intent", "contract_version"],
        message: "结果外层版本必须与 query_intent 版本一致",
      });
    }
    const evidenceSchema = isV11 ? evidenceObjectV11Schema : evidenceObjectV1Schema;
    for (const [index, item] of result.evidence.entries()) {
      if (!evidenceSchema.safeParse(item).success) {
        context.addIssue({
          code: "custom",
          path: ["evidence", index],
          message: isV11 ? "V1.1 证据必须包含完整快照元数据" : "V1.0 禁止快照元数据",
        });
      }
    }
    payloadEvidenceIssue(result, context);
  },
);
/** Result shape before realtime or publisher snapshot metadata is attached. */
export const deterministicResultInputSchema = deterministicResultEnvelope.superRefine(
  (result, context) => {
    const isV11 = result.contract_version === "V1.1";
    if (isV11 !== "contract_version" in result.query_intent) {
      context.addIssue({
        code: "custom",
        path: ["query_intent", "contract_version"],
        message: "待保存结果外层版本必须与 query_intent 版本一致",
      });
    }
    if (!isV11) {
      for (const [index, item] of result.evidence.entries()) {
        if (!evidenceObjectV1Schema.safeParse(item).success)
          context.addIssue({
            code: "custom",
            path: ["evidence", index],
            message: "V1.0 待保存结果禁止快照元数据",
          });
      }
    }
    payloadEvidenceIssue(result, context, evidenceObjectSchema);
  },
);
export const queryErrorSchema = z
  .object({
    error_id: z.string(),
    code: z.enum([
      "INVALID_METRIC",
      "INVALID_DIMENSION",
      "INVALID_FILTER",
      "INVALID_PERIOD",
      "VERSION_NOT_FOUND",
      "UNSUPPORTED_GRAIN",
      "ORDER_LEVEL_NOT_AVAILABLE",
      "EVIDENCE_NOT_FOUND",
      "RECONCILIATION_FAILED",
    ]),
    message_zh: z.string(),
    missing_capabilities: z.array(z.string()).optional(),
    request_id: z.string(),
  })
  .strict();
export const infrastructureErrorSchema = z
  .object({ type: z.literal("QUERY_TIMEOUT"), message_zh: z.string(), request_id: z.string() })
  .strict();
export type DataSeries = z.infer<typeof dataSeriesSchema>;
export type Comparison = z.infer<typeof comparisonSchema>;
export type Dimension = z.infer<typeof dimensionSchema>;
export type AttributionFactor = z.infer<typeof attributionFactorSchema>;
export type QuestionType = z.infer<typeof questionTypeSchema>;
export type AnalysisScope = z.infer<typeof analysisScopeSchema>;
export type QueryIntentV1 = z.infer<typeof queryIntentV1Schema>;
export type QueryIntentV11 = z.infer<typeof queryIntentV11Schema>;
export type QueryIntent = z.infer<typeof queryIntentSchema>;
export type QueryContractVersion = z.infer<typeof queryContractVersionSchema>;
export type DeterministicResultEnvelope = z.infer<typeof deterministicResultSchema>;
export type MoneyValue = z.infer<typeof moneyValueSchema>;
export type DecimalValue = z.infer<typeof decimalValueSchema>;
export type EvidenceObject = z.infer<typeof evidenceObjectSchema>;
export type ResultWarning = z.infer<typeof resultWarningSchema>;
export type QueryError = z.infer<typeof queryErrorSchema>;
export type InfrastructureError = z.infer<typeof infrastructureErrorSchema>;
