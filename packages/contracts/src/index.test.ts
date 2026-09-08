import { describe, expect, it } from "vitest";

import {
  compatibilityStatusSchema,
  deterministicResultInputSchema,
  queryIntentSchema,
  queryIntentV11Schema,
  queryIntentV1Schema,
  deterministicResultSchema,
} from "./index";

describe("compatibilityStatusSchema", () => {
  it("accepts the frozen ready state and rejects unknown fields", () => {
    expect(compatibilityStatusSchema.parse({ state: "ready" })).toEqual({ state: "ready" });
    expect(() => compatibilityStatusSchema.parse({ state: "ready", internal: true })).toThrow();
  });
});

const baseIntent = {
  question_type: "COUNTRY_VARIANCE_SUMMARY",
  scope: {
    period: { from: "2026-08", to: "2026-08", grain: "MONTH" },
    comparison: "ACTUAL_VS_BUDGET",
    destination_country_ids: ["GB"],
    budget_version_id: "BUDGET_2026_V1",
    actual_version_id: "ACTUAL_2026_08_CLOSE_V1",
    calculation_version: "D-092",
  },
  metrics: ["FULFILLMENT_VARIABLE_COST"],
  group_by: [],
  output_locale: "zh-CN",
  context_sources: ["FIXED_TEMPLATE"],
} as const;

describe("QueryIntent V1.1", () => {
  it("accepts a nonempty snapshot ID only on an explicit V1.1 evidence lookup", () => {
    const lookup = {
      ...baseIntent,
      contract_version: "V1.1",
      question_type: "EVIDENCE_LOOKUP",
      evidence_id: "E01-country",
      evidence_snapshot_id: "ES-old-release",
      metrics: [],
    };
    expect(queryIntentSchema.safeParse(lookup).success).toBe(true);
    for (const value of ["", " ", " ES-id", "ES-id ", null, 42, "x".repeat(241)]) {
      expect(queryIntentSchema.safeParse({ ...lookup, evidence_snapshot_id: value }).success).toBe(
        false,
      );
    }
    expect(queryIntentSchema.safeParse({ ...lookup, contract_version: undefined }).success).toBe(
      false,
    );
    expect(queryIntentSchema.safeParse({ ...lookup, evidence_id: undefined }).success).toBe(false);
    expect(
      queryIntentSchema.safeParse({ ...lookup, question_type: "COUNTRY_VARIANCE_SUMMARY" }).success,
    ).toBe(false);
    expect(
      queryIntentSchema.safeParse({
        ...lookup,
        scope: { ...lookup.scope, evidence_snapshot_id: "ES-id" },
      }).success,
    ).toBe(false);
    expect(queryIntentSchema.safeParse({ ...lookup, unexpected: true }).success).toBe(false);
  });
  it("keeps strict V1.0 compatibility while requiring an explicit V1.1 marker", () => {
    expect(queryIntentV1Schema.safeParse(baseIntent).success).toBe(true);
    expect(
      queryIntentV11Schema.safeParse({ ...baseIntent, contract_version: "V1.1" }).success,
    ).toBe(true);
    expect(queryIntentSchema.safeParse({ ...baseIntent, contract_version: "V1.2" }).success).toBe(
      false,
    );
  });

  it("accepts evidence_id only for an exact V1.1 EVIDENCE_LOOKUP", () => {
    const lookup = {
      ...baseIntent,
      contract_version: "V1.1",
      question_type: "EVIDENCE_LOOKUP",
      evidence_id: "ATTRIBUTION_DRILLDOWN:FC:DE_FC",
      metrics: [],
    } as const;
    expect(queryIntentV11Schema.safeParse(lookup).success).toBe(true);
    expect(queryIntentV11Schema.safeParse({ ...lookup, evidence_id: "  " }).success).toBe(false);
    expect(queryIntentV11Schema.safeParse({ ...lookup, evidence_id: " E01-country" }).success).toBe(
      false,
    );
    expect(queryIntentV11Schema.safeParse({ ...lookup, evidence_id: undefined }).success).toBe(
      false,
    );
    expect(
      queryIntentV11Schema.safeParse({
        ...baseIntent,
        contract_version: "V1.1",
        evidence_id: "E01-country",
      }).success,
    ).toBe(false);
    expect(
      queryIntentV1Schema.safeParse({
        ...baseIntent,
        question_type: "EVIDENCE_LOOKUP",
        evidence_id: "E01-country",
      }).success,
    ).toBe(false);
  });
});

const evidenceFixture = (metadata: Record<string, string> = {}) => ({
  evidence_id: "E01-country",
  metric: "差异",
  value: "1",
  unit: "CNY",
  period: { from: "2026-08", to: "2026-08" },
  comparison: "ACTUAL_VS_BUDGET",
  filters: {},
  group_by: [],
  versions: {
    budget: "BUDGET_2026_V1",
    actual: "ACTUAL_2026_08_CLOSE_V1",
    calculation: "D-092",
  },
  calculation_method: "fixture",
  source_result_id: "Q-fixture",
  snapshot_generated_at: "2026-09-01T00:00:00.000Z",
  source_refs: ["fixture"],
  ...metadata,
});

const resultFixture = (overrides: Record<string, unknown> = {}) => ({
  result_id: "Q-fixture",
  scope_label: "英国",
  data_as_of: "2026-09-01T00:00:00.000Z",
  generated_at: "2026-09-01T00:00:00.000Z",
  reporting_currency: "CNY",
  precision: { calculation: "HIGH_PRECISION_DECIMAL", report_places: 4, display_places: 2 },
  payload: { variance: "1" },
  warnings: [],
  ...overrides,
});

describe("deterministic result version boundaries", () => {
  it("rejects V1.0/V1.1 envelope and evidence metadata mixing", () => {
    expect(
      deterministicResultSchema.safeParse({
        ...resultFixture({
          contract_version: "V1.0",
          query_intent: baseIntent,
          evidence: [
            evidenceFixture({ evidence_snapshot_id: "ES-forbidden", data_release_id: "R1" }),
          ],
        }),
      }).success,
    ).toBe(false);
    expect(
      deterministicResultSchema.safeParse({
        ...resultFixture({
          contract_version: "V1.1",
          query_intent: { ...baseIntent, contract_version: "V1.1" },
          evidence: [evidenceFixture()],
        }),
      }).success,
    ).toBe(false);
    expect(
      deterministicResultSchema.safeParse({
        ...resultFixture({
          contract_version: "V1.0",
          query_intent: { ...baseIntent, contract_version: "V1.1" },
          evidence: [evidenceFixture()],
        }),
      }).success,
    ).toBe(false);
    expect(
      deterministicResultSchema.safeParse({
        ...resultFixture({
          contract_version: "V1.1",
          query_intent: { ...baseIntent, contract_version: "V1.1" },
          evidence: [evidenceFixture({ evidence_snapshot_id: "ES-valid", data_release_id: "R1" })],
        }),
      }).success,
    ).toBe(true);
  });

  it("enforces version and metadata boundaries before snapshot attachment", () => {
    expect(
      deterministicResultInputSchema.safeParse({
        ...resultFixture({
          contract_version: "V1.1",
          query_intent: baseIntent,
          evidence: [evidenceFixture()],
        }),
      }).success,
    ).toBe(false);

    expect(
      deterministicResultInputSchema.safeParse({
        ...resultFixture({
          contract_version: "V1.0",
          query_intent: baseIntent,
          evidence: [
            evidenceFixture({ evidence_snapshot_id: "ES-forbidden", data_release_id: "R1" }),
          ],
        }),
      }).success,
    ).toBe(false);
  });

  it("requires and validates payload.evidence only for V1.1 EVIDENCE_LOOKUP", () => {
    const lookupIntent = {
      ...baseIntent,
      contract_version: "V1.1" as const,
      question_type: "EVIDENCE_LOOKUP" as const,
      evidence_id: "E01-country",
      metrics: [],
    };
    const savedEvidence = evidenceFixture({
      evidence_snapshot_id: "ES-valid",
      data_release_id: "R1",
    });
    expect(
      deterministicResultSchema.safeParse({
        ...resultFixture({
          contract_version: "V1.1",
          query_intent: lookupIntent,
          evidence: [savedEvidence],
          payload: {},
        }),
      }).success,
    ).toBe(false);
    expect(
      deterministicResultSchema.safeParse({
        ...resultFixture({
          contract_version: "V1.1",
          query_intent: lookupIntent,
          evidence: [savedEvidence],
          payload: { evidence: { evidence_id: "E01-country" } },
        }),
      }).success,
    ).toBe(false);
    expect(
      deterministicResultSchema.safeParse({
        ...resultFixture({
          contract_version: "V1.1",
          query_intent: lookupIntent,
          evidence: [savedEvidence],
          payload: { evidence: savedEvidence },
        }),
      }).success,
    ).toBe(true);
    expect(
      deterministicResultSchema.safeParse({
        ...resultFixture({
          contract_version: "V1.1",
          query_intent: { ...baseIntent, contract_version: "V1.1" },
          evidence: [savedEvidence],
          payload: { evidence: savedEvidence },
        }),
      }).success,
    ).toBe(false);

    const mismatchedEvidence = { ...savedEvidence, value: "2" };
    expect(
      deterministicResultSchema.safeParse({
        ...resultFixture({
          contract_version: "V1.1",
          query_intent: lookupIntent,
          evidence: [savedEvidence],
          payload: { evidence: mismatchedEvidence },
        }),
      }).success,
    ).toBe(false);
    expect(
      deterministicResultInputSchema.safeParse({
        ...resultFixture({
          contract_version: "V1.1",
          query_intent: lookupIntent,
          evidence: [evidenceFixture()],
          payload: { evidence: { ...evidenceFixture(), value: "2" } },
        }),
      }).success,
    ).toBe(false);

    expect(
      deterministicResultSchema.safeParse({
        ...resultFixture({
          contract_version: "V1.0",
          query_intent: { ...baseIntent, question_type: "EVIDENCE_LOOKUP" },
          evidence: [evidenceFixture()],
          payload: { evidence: savedEvidence },
        }),
      }).success,
    ).toBe(false);

    expect(
      deterministicResultSchema.safeParse({
        ...resultFixture({
          contract_version: "V1.1",
          query_intent: lookupIntent,
          evidence: [evidenceFixture({ evidence_snapshot_id: " ", data_release_id: " " })],
          payload: {
            evidence: evidenceFixture({ evidence_snapshot_id: " ", data_release_id: " " }),
          },
        }),
      }).success,
    ).toBe(false);
  });
});
