import type { Pool } from "pg";
import { evidenceObjectSchema, type QueryIntent } from "@logiplan/contracts";
import { describe, expect, it, vi } from "vitest";

import { runDeterministicQuery } from "./query-service";

const versions = {
  budget: "BUDGET_2026_V1",
  actual: "ACTUAL_2026_08_CLOSE_V1",
  forecast: "FORECAST_2026_08_V1",
};

const versionRows = (selected = versions) => [
  {
    scenario_version_id: selected.budget,
    scenario_type: "BUDGET",
    latest_closed_month: null,
  },
  {
    scenario_version_id: selected.actual,
    scenario_type: "ACTUAL",
    latest_closed_month: "2026-08-01",
  },
  {
    scenario_version_id: selected.forecast,
    scenario_type: "FORECAST",
    latest_closed_month: "2026-08-01",
  },
];

const canonicalRoutes = [
  { route_id: "R_DE", destination_country_id: "DE", valid_from: "2026-01-01", valid_to: null },
  { route_id: "R_FR", destination_country_id: "FR", valid_from: "2026-01-01", valid_to: null },
  { route_id: "R_GB", destination_country_id: "GB", valid_from: "2026-01-01", valid_to: null },
];

const variableCoverageRows = (selected = versions) =>
  Array.from({ length: 12 }, (_, index) => {
    const month = `2026-${String(index + 1).padStart(2, "0")}-01`;
    const currentVersion = index < 8 ? selected.actual : selected.forecast;
    return [selected.budget, currentVersion].flatMap((version) =>
      canonicalRoutes.map((route) => ({
        scenario_version_id: version,
        month_id: month,
        route_id: route.route_id,
        component_count: 6,
      })),
    );
  }).flat();

const completeFixedCostRows = (selected = versions) =>
  Array.from({ length: 12 }, (_, index) => {
    const month = `2026-${String(index + 1).padStart(2, "0")}-01`;
    const currentVersion = index < 8 ? selected.actual : selected.forecast;
    const keys = [
      ["WAREHOUSE_RENT", "DE_FC"],
      ["WAREHOUSE_RENT", "FR_FC"],
      ["FRONTLINE_BASE_LABOR", "DE_FC"],
      ["FRONTLINE_BASE_LABOR", "FR_FC"],
      ["WAREHOUSE_MANAGEMENT_LABOR", "DE_FC"],
      ["WAREHOUSE_MANAGEMENT_LABOR", "FR_FC"],
      ["SYSTEM_COST", "SHARED"],
    ] as const;
    return [selected.budget, currentVersion].flatMap((version) =>
      keys.map(([category, scope]) => ({
        scenario_version_id: version,
        month_id: month,
        cost_scope_type: scope === "SHARED" ? "SHARED" : "FULFILLMENT_CENTER",
        fulfillment_center_id: scope === "SHARED" ? null : scope,
        fixed_cost_category: category,
        amount: "0",
      })),
    );
  }).flat();

const intent = (
  question_type: QueryIntent["question_type"],
  group_by: QueryIntent["group_by"],
  top_n?: number,
): QueryIntent => ({
  question_type,
  scope: {
    period: {
      from: "2026-01",
      to: "2026-12",
      grain: question_type === "FIXED_COST_BREAKDOWN" ? "RANGE" : "MONTH",
    },
    comparison: "LATEST_OUTLOOK_VS_BUDGET",
    budget_version_id: versions.budget,
    actual_version_id: versions.actual,
    forecast_version_id: versions.forecast,
    calculation_version: "CALC_V1",
  },
  metrics: [
    question_type === "MONTHLY_COST_TREND"
      ? "LOGISTICS_TOTAL_COST"
      : question_type === "TOP_ADVERSE_ANOMALIES"
        ? "FULFILLMENT_VARIABLE_COST"
        : question_type === "FIXED_COST_BREAKDOWN"
          ? "LOGISTICS_FIXED_COST"
          : "COST",
  ],
  group_by,
  top_n,
  output_locale: "zh-CN",
  context_sources: ["FIXED_TEMPLATE"],
});

const poolFor = (
  marker: string,
  rows: unknown[],
  metadata = versionRows(),
  coverage?: {
    routes?: unknown[];
    variable?: unknown[];
    fixed?: unknown[];
  },
) =>
  ({
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM logiplan.active_scenario_version\n")) {
        return { rows: metadata, rowCount: metadata.length };
      }
      if (sql.includes("/* CANONICAL_ROUTES */")) {
        const result = coverage?.routes ?? canonicalRoutes;
        return { rows: result, rowCount: result.length };
      }
      if (sql.includes("/* VARIABLE_COVERAGE */")) {
        const result = coverage?.variable ?? variableCoverageRows();
        return { rows: result, rowCount: result.length };
      }
      if (sql.includes("/* FIXED_COST_FACTS */")) {
        const result =
          marker === "/* FIXED_COST_FACTS */" ? rows : (coverage?.fixed ?? completeFixedCostRows());
        return { rows: result, rowCount: result.length };
      }
      if (sql.includes(marker)) return { rows, rowCount: rows.length };
      throw new Error(`未模拟 SQL：${sql}`);
    }),
  }) as unknown as Pool;

const payloadOf = (result: Awaited<ReturnType<typeof runDeterministicQuery>>) => {
  if (!("payload" in result)) throw new Error(`查询失败：${result.code}`);
  return result;
};

const monthlyRows = (selected = versions) =>
  Array.from({ length: 12 }, (_, index) => {
    const month = `2026-${String(index + 1).padStart(2, "0")}-01`;
    const currentVersion = index < 8 ? selected.actual : selected.forecast;
    const currentVariable = index < 8 ? "110.123456789" : "120.123456789";
    const currentFixed = index < 8 ? "22.1111" : "24.1111";
    return [
      {
        scenario_version_id: selected.budget,
        month_id: month,
        variable_cost: "100.123456789",
        fixed_cost: "20.1111",
        variable_present: 1,
        fixed_present: 1,
      },
      {
        scenario_version_id: currentVersion,
        month_id: month,
        variable_cost: currentVariable,
        fixed_cost: currentFixed,
        variable_present: 1,
        fixed_present: 1,
      },
    ];
  }).flat();

describe("dashboard deterministic query payloads", () => {
  it("returns 12 monthly total-cost points across the Actual/Forecast close boundary", async () => {
    const rows = monthlyRows();
    const result = payloadOf(
      await runDeterministicQuery(
        poolFor("/* MONTHLY_COST_TREND */", rows),
        intent("MONTHLY_COST_TREND", ["MONTH"]),
        "monthly",
      ),
    );
    const payload = result.payload as {
      months: Array<{
        month_id: string;
        series_type: string;
        baseline: { total_cost: { high_precision: string } };
        current: { total_cost: { high_precision: string } };
        variance: { high_precision: string };
      }>;
      closing_boundary: { latest_closed_month: string; first_forecast_month: string };
    };

    expect(payload.months).toHaveLength(12);
    expect(payload.months[7]).toMatchObject({ month_id: "2026-08", series_type: "ACTUAL" });
    expect(payload.months[8]).toMatchObject({ month_id: "2026-09", series_type: "FORECAST" });
    expect(payload.months[0]?.baseline.total_cost.high_precision).toBe("120.234556789");
    expect(payload.months[0]?.current.total_cost.high_precision).toBe("132.234556789");
    expect(payload.months[0]?.variance.high_precision).toBe("12");
    expect(payload.closing_boundary).toEqual({
      latest_closed_month: "2026-08",
      first_forecast_month: "2026-09",
    });
    expect(result.evidence).toHaveLength(12);
    for (const item of result.evidence) {
      expect(evidenceObjectSchema.safeParse(item).success).toBe(true);
      expect(item.group_by).toEqual(["MONTH"]);
      expect(item.period.from).toBe(item.period.to);
      expect(item.filters).toEqual({});
      expect(item.source_result_id).toBe(result.result_id);
    }
  });

  it("rejects unsupported dashboard scopes, fields and extreme years before data access", async () => {
    const base = intent("MONTHLY_COST_TREND", ["MONTH"]);
    const invalid: Array<[QueryIntent, string]> = [
      [
        {
          ...base,
          scope: { ...base.scope, period: { from: "9999-12", to: "9999-12", grain: "MONTH" } },
        },
        "INVALID_PERIOD",
      ],
      [{ ...base, metrics: ["COST"] }, "INVALID_METRIC"],
      [{ ...base, group_by: ["DESTINATION_COUNTRY"] }, "INVALID_DIMENSION"],
      [{ ...base, scope: { ...base.scope, destination_country_ids: ["GB"] } }, "INVALID_FILTER"],
      [{ ...base, scope: { ...base.scope, forecast_version_id: undefined } }, "INVALID_FILTER"],
    ];
    const pool = {
      query: vi.fn(() => Promise.reject(new Error("不得访问数据库"))),
    } as unknown as Pool;
    for (const [query, code] of invalid) {
      const result = await runDeterministicQuery(pool, query, `invalid-${code}`);
      expect(result).toMatchObject({ code, request_id: `invalid-${code}` });
    }
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("returns request-bound structured errors for missing versions and monthly facts", async () => {
    const query = intent("MONTHLY_COST_TREND", ["MONTH"]);
    const missingVersion = await runDeterministicQuery(
      poolFor("/* MONTHLY_COST_TREND */", monthlyRows(), versionRows().slice(0, 2)),
      query,
      "missing-version",
    );
    expect(missingVersion).toMatchObject({
      code: "VERSION_NOT_FOUND",
      request_id: "missing-version",
    });

    const missingFactRows = monthlyRows().filter(
      (row) =>
        !(
          row.scenario_version_id === versions.actual && String(row.month_id).startsWith("2026-08")
        ),
    );
    const missingFact = await runDeterministicQuery(
      poolFor("/* MONTHLY_COST_TREND */", missingFactRows),
      query,
      "missing-fact",
    );
    expect(missingFact).toMatchObject({
      code: "RECONCILIATION_FAILED",
      request_id: "missing-fact",
    });

    const commonFixedGap = completeFixedCostRows().filter(
      (row) =>
        !(
          row.month_id === "2026-01-01" &&
          row.fixed_cost_category === "SYSTEM_COST" &&
          [versions.budget, versions.actual].includes(row.scenario_version_id)
        ),
    );
    const missingFixed = await runDeterministicQuery(
      poolFor("/* MONTHLY_COST_TREND */", monthlyRows(), versionRows(), {
        fixed: commonFixedGap,
      }),
      query,
      "common-fixed-gap",
    );
    expect(missingFixed).toMatchObject({
      code: "RECONCILIATION_FAILED",
      request_id: "common-fixed-gap",
    });

    const commonVariableGap = variableCoverageRows().filter(
      (row) =>
        !(
          row.month_id === "2026-01-01" &&
          row.route_id === "R_GB" &&
          [versions.budget, versions.actual].includes(row.scenario_version_id)
        ),
    );
    const missingVariable = await runDeterministicQuery(
      poolFor("/* MONTHLY_COST_TREND */", monthlyRows(), versionRows(), {
        variable: commonVariableGap,
      }),
      query,
      "common-variable-gap",
    );
    expect(missingVariable).toMatchObject({
      code: "RECONCILIATION_FAILED",
      request_id: "common-variable-gap",
    });
  });

  it("uses complete-intent hashes without collisions across question, scope and version", async () => {
    const aggregatePool = {
      query: vi.fn(async (sql: string) =>
        sql.includes("AS variable_cost")
          ? { rows: [{ variable_cost: "1" }], rowCount: 1 }
          : { rows: [{ fixed_cost: "1" }], rowCount: 1 },
      ),
    } as unknown as Pool;
    const dashboard = intent("DASHBOARD_OVERVIEW", []);
    dashboard.scope.period.grain = "RANGE";
    const country = intent("COUNTRY_VARIANCE_SUMMARY", []);
    country.scope.period.grain = "RANGE";
    country.scope.destination_country_ids = ["GB"];
    const otherScope = { ...dashboard, scope: { ...dashboard.scope, carrier_ids: ["CARRIER_A"] } };
    const otherVersion = {
      ...dashboard,
      scope: { ...dashboard.scope, budget_version_id: "BUDGET_2026_V2" },
    };
    const results = await Promise.all(
      [dashboard, country, otherScope, otherVersion].map(async (query, index) =>
        payloadOf(await runDeterministicQuery(aggregatePool, query, `hash-${index}`)),
      ),
    );
    expect(new Set(results.map((result) => result.result_id)).size).toBe(4);
    for (const result of results) {
      expect(result.result_id).toMatch(/^Q-[a-f0-9]{64}$/u);
      expect(result.evidence.every((item) => item.source_result_id === result.result_id)).toBe(
        true,
      );
    }
  });

  it("ranks only adverse month-country variable-cost variances using the full adverse pool", async () => {
    const cases = [
      ["2026-08", "GB", "100", "250", versions.actual],
      ["2026-08", "FR", "100", "200", versions.actual],
      ["2026-06", "GB", "0", "95", versions.actual],
      ["2026-09", "DE", "100", "190", versions.forecast],
      ["2026-09", "GB", "100", "190", versions.forecast],
      ["2026-07", "DE", "100", "170", versions.actual],
      ["2026-07", "FR", "100", "170", versions.actual],
      ["2026-05", "DE", "100", "80", versions.actual],
    ] as const;
    const overrides = new Map(
      cases.map(([month, country, baseline, current]) => [
        `${month}|${country}`,
        { baseline, current },
      ]),
    );
    const rows = Array.from({ length: 12 }, (_, index) => {
      const month = `2026-${String(index + 1).padStart(2, "0")}`;
      const currentVersion = index < 8 ? versions.actual : versions.forecast;
      return ["DE", "FR", "GB"].flatMap((country) => {
        const values = overrides.get(`${month}|${country}`) ?? { baseline: "100", current: "100" };
        return [
          {
            scenario_version_id: versions.budget,
            month_id: `${month}-01`,
            destination_country_id: country,
            amount: values.baseline,
          },
          {
            scenario_version_id: currentVersion,
            month_id: `${month}-01`,
            destination_country_id: country,
            amount: values.current,
          },
        ];
      });
    }).flat();
    const result = payloadOf(
      await runDeterministicQuery(
        poolFor("/* TOP_ADVERSE_ANOMALIES */", rows),
        intent("TOP_ADVERSE_ANOMALIES", ["MONTH", "DESTINATION_COUNTRY"], 5),
        "top",
      ),
    );
    const payload = result.payload as {
      adverse_pool_total: { high_precision: string };
      anomalies: Array<{
        month_id: string;
        destination_country_id: string;
        series_type: string;
        variance: { high_precision: string };
        variance_rate: { high_precision: string } | null;
        adverse_contribution_share: { high_precision: string; report: string };
      }>;
    };

    expect(payload.adverse_pool_total.high_precision).toBe("665");
    expect(payload.anomalies).toHaveLength(5);
    expect(payload.anomalies.map((row) => `${row.month_id}:${row.destination_country_id}`)).toEqual(
      ["2026-08:GB", "2026-08:FR", "2026-06:GB", "2026-09:DE", "2026-09:GB"],
    );
    expect(payload.anomalies[2]?.variance_rate).toBeNull();
    expect(payload.anomalies[0]?.adverse_contribution_share.report).toBe("0.2256");
    expect(payload.anomalies[3]?.series_type).toBe("FORECAST");
    for (const item of result.evidence) {
      expect(evidenceObjectSchema.safeParse(item).success).toBe(true);
      expect(item.group_by).toEqual(["MONTH", "DESTINATION_COUNTRY"]);
      expect(item.period.from).toBe(item.period.to);
      expect(item.filters.destination_country_id).toHaveLength(1);
    }
    const missing = await runDeterministicQuery(
      poolFor(
        "/* TOP_ADVERSE_ANOMALIES */",
        rows.filter(
          (row) =>
            !(
              row.scenario_version_id === versions.actual &&
              row.month_id === "2026-08-01" &&
              row.destination_country_id === "GB"
            ),
        ),
      ),
      intent("TOP_ADVERSE_ANOMALIES", ["MONTH", "DESTINATION_COUNTRY"], 5),
      "missing-top-fact",
    );
    expect(missing).toMatchObject({
      code: "RECONCILIATION_FAILED",
      request_id: "missing-top-fact",
    });
    const commonCountryGap = await runDeterministicQuery(
      poolFor(
        "/* TOP_ADVERSE_ANOMALIES */",
        rows.filter(
          (row) => !(row.month_id === "2026-08-01" && row.destination_country_id === "GB"),
        ),
      ),
      intent("TOP_ADVERSE_ANOMALIES", ["MONTH", "DESTINATION_COUNTRY"], 5),
      "common-country-gap",
    );
    expect(commonCountryGap).toMatchObject({
      code: "RECONCILIATION_FAILED",
      request_id: "common-country-gap",
    });
  });

  it("reconciles fixed cost from category to warehouse or shared ownership", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const add = (
      category: string,
      scope: string,
      january: [string, string],
      september: [string, string],
    ) => {
      const shared = scope === "SHARED";
      for (let index = 0; index < 12; index += 1) {
        const month = `2026-${String(index + 1).padStart(2, "0")}-01`;
        const [baseline, current] = index < 8 ? january : september;
        const currentVersion = index < 8 ? versions.actual : versions.forecast;
        rows.push(
          {
            scenario_version_id: versions.budget,
            month_id: month,
            cost_scope_type: shared ? "SHARED" : "FULFILLMENT_CENTER",
            fulfillment_center_id: shared ? null : scope,
            fixed_cost_category: category,
            amount: baseline,
          },
          {
            scenario_version_id: currentVersion,
            month_id: month,
            cost_scope_type: shared ? "SHARED" : "FULFILLMENT_CENTER",
            fulfillment_center_id: shared ? null : scope,
            fixed_cost_category: category,
            amount: current,
          },
        );
      }
    };
    for (const category of [
      "WAREHOUSE_RENT",
      "FRONTLINE_BASE_LABOR",
      "WAREHOUSE_MANAGEMENT_LABOR",
    ]) {
      add(category, "DE_FC", ["10", "12"], ["20", "25"]);
      add(category, "FR_FC", ["8", "9"], ["16", "18"]);
    }
    add("SYSTEM_COST", "SHARED", ["10", "13"], ["20", "25"]);
    const result = payloadOf(
      await runDeterministicQuery(
        poolFor("/* FIXED_COST_FACTS */", rows),
        intent("FIXED_COST_BREAKDOWN", ["FIXED_COST_CATEGORY", "FULFILLMENT_CENTER"]),
        "fixed",
      ),
    );
    const payload = result.payload as {
      total: { baseline: { high_precision: string }; current: { high_precision: string } };
      categories: Array<{
        fixed_cost_category: string;
        baseline: { high_precision: string };
        current: { high_precision: string };
        variance: { high_precision: string };
        allocations: Array<{ scope_id: string; fulfillment_center_id: string | null }>;
      }>;
      reconciliation: Record<string, { high_precision: string }>;
    };

    expect(payload.categories).toHaveLength(4);
    expect(payload.total).toMatchObject({
      baseline: { high_precision: "1024" },
      current: { high_precision: "1224" },
    });
    const rent = payload.categories.find((row) => row.fixed_cost_category === "WAREHOUSE_RENT");
    expect(rent).toMatchObject({
      baseline: { high_precision: "288" },
      current: { high_precision: "340" },
      variance: { high_precision: "52" },
    });
    expect(rent?.allocations.map((row) => row.scope_id)).toEqual(["DE_FC", "FR_FC"]);
    const system = payload.categories.find((row) => row.fixed_cost_category === "SYSTEM_COST");
    expect(system?.allocations).toEqual([
      expect.objectContaining({ scope_id: "SHARED", fulfillment_center_id: null }),
    ]);
    expect(Object.values(payload.reconciliation).every((row) => row.high_precision === "0")).toBe(
      true,
    );
    expect(result.evidence.find((item) => item.evidence_id.endsWith(":TOTAL"))).toMatchObject({
      filters: {},
      group_by: [],
    });
    expect(
      result.evidence.find((item) => item.evidence_id === "FIXED_COST_BREAKDOWN:WAREHOUSE_RENT"),
    ).toMatchObject({
      filters: { fixed_cost_category: ["WAREHOUSE_RENT"] },
      group_by: ["FIXED_COST_CATEGORY"],
    });
    expect(
      result.evidence.find((item) => item.evidence_id.endsWith(":SYSTEM_COST:SHARED")),
    ).toMatchObject({
      filters: { fixed_cost_category: ["SYSTEM_COST"], cost_scope_type: ["SHARED"] },
      group_by: ["FIXED_COST_CATEGORY", "FULFILLMENT_CENTER"],
    });
    for (const item of result.evidence) {
      expect(evidenceObjectSchema.safeParse(item).success).toBe(true);
      expect(item.source_refs).not.toContain("logiplan.active_*");
      expect(item.source_result_id).toBe(result.result_id);
    }
    const missing = await runDeterministicQuery(
      poolFor(
        "/* FIXED_COST_FACTS */",
        rows.filter(
          (row) =>
            !(
              row.scenario_version_id === versions.forecast &&
              row.month_id === "2026-12-01" &&
              row.fixed_cost_category === "SYSTEM_COST"
            ),
        ),
      ),
      intent("FIXED_COST_BREAKDOWN", ["FIXED_COST_CATEGORY", "FULFILLMENT_CENTER"]),
      "missing-fixed-fact",
    );
    expect(missing).toMatchObject({
      code: "RECONCILIATION_FAILED",
      request_id: "missing-fixed-fact",
    });
  });
});
