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
export const queryIntentSchema = z
  .object({
    question_type: questionTypeSchema,
    scope: analysisScopeSchema,
    metrics: z.array(z.string().min(1).max(80)).max(50),
    group_by: z.array(dimensionSchema).max(6),
    top_n: z.number().int().min(1).max(100).optional(),
    output_locale: z.literal("zh-CN"),
    context_sources: z.array(z.enum(["USER", "PAGE_VISIBLE_STATE", "FIXED_TEMPLATE"])).max(3),
  })
  .strict();
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
export type QueryIntent = z.infer<typeof queryIntentSchema>;
export type MoneyValue = z.infer<typeof moneyValueSchema>;
export type DecimalValue = z.infer<typeof decimalValueSchema>;
export type EvidenceObject = z.infer<typeof evidenceObjectSchema>;
export type ResultWarning = z.infer<typeof resultWarningSchema>;
export type QueryError = z.infer<typeof queryErrorSchema>;
export type InfrastructureError = z.infer<typeof infrastructureErrorSchema>;
