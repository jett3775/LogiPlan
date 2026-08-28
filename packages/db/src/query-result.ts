import { createHash } from "node:crypto";
import { type Comparison, type EvidenceObject, type QueryIntent } from "@logiplan/contracts";

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export const resultId = (intent: QueryIntent) =>
  `Q-${createHash("sha256").update(canonicalJson(intent)).digest("hex")}`;

export const evidence = (
  id: string,
  intent: QueryIntent,
  metric: string,
  value: string,
  method: string,
  options?: {
    period?: EvidenceObject["period"];
    filters?: Record<string, string[]>;
    group_by?: EvidenceObject["group_by"];
    source_refs?: string[];
    unit?: string;
  },
): EvidenceObject => ({
  evidence_id: id,
  metric,
  value,
  unit: options?.unit ?? "CNY",
  period: options?.period ?? { from: intent.scope.period.from, to: intent.scope.period.to },
  comparison: intent.scope.comparison as Comparison,
  filters: options?.filters ?? {},
  group_by: options?.group_by ?? intent.group_by,
  versions: {
    budget: intent.scope.budget_version_id,
    actual: intent.scope.actual_version_id,
    forecast: intent.scope.forecast_version_id,
    scenario: intent.scope.scenario_version_id,
    calculation: intent.scope.calculation_version,
  },
  calculation_method: method,
  source_result_id: resultId(intent),
  snapshot_generated_at: new Date().toISOString(),
  source_refs: options?.source_refs ?? ["logiplan.active_*"],
});
