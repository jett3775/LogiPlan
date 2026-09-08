import type { Pool } from "pg";
import { evidenceObjectSchema, type MoneyValue, type QueryIntent } from "@logiplan/contracts";
import { LogiPlanDecimal } from "@logiplan/domain";
import { describe, expect, it, vi } from "vitest";

import { runDiagnosticMetrics } from "./diagnostic-metrics";
import { checkReadiness, runDeterministicQuery } from "./query-service";

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

const diagnosticIntent = (): QueryIntent => ({
  question_type: "DIAGNOSTIC_METRICS",
  scope: {
    period: { from: "2026-08", to: "2026-08", grain: "MONTH" },
    comparison: "ACTUAL_VS_BUDGET",
    destination_country_ids: ["GB"],
    budget_version_id: versions.budget,
    actual_version_id: versions.actual,
    calculation_version: "CALC_V1",
  },
  metrics: ["ORDERS", "AIR_SHARE", "CARRIER_C_SHARE", "ON_TIME_RATE", "SERVICE_MATURITY"],
  group_by: [],
  output_locale: "zh-CN",
  context_sources: ["FIXED_TEMPLATE"],
});

const diagnosticRows = () => [
  {
    scenario_version_id: versions.budget,
    scenario_type: "BUDGET",
    latest_closed_month: null,
    expected_route_count: 5,
    route_count: 5,
    order_qty: "4800",
    order_source_model: "budget_country_month",
    package_qty: "5381.7600",
    air_package_qty: "736.8960",
    carrier_c_package_qty: "154.8288",
    due_package_qty: "5381.7600",
    on_time_delivered_package_qty: "5064.7702272",
    missing_service_count: 0,
  },
  {
    scenario_version_id: versions.actual,
    scenario_type: "ACTUAL",
    latest_closed_month: "2026-08-01",
    expected_route_count: 5,
    route_count: 5,
    order_qty: "8932",
    order_source_model: "actual_country_warehouse_fulfillment",
    package_qty: "10886.3215",
    air_package_qty: "7186.7765",
    carrier_c_package_qty: "4228.0515",
    due_package_qty: "10015.415780",
    on_time_delivered_package_qty: "9631.032390836",
    missing_service_count: 0,
  },
];

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
      if (sql.includes("FROM logiplan.evidence_snapshot")) return { rows: [], rowCount: 0 };
      if (sql.includes(marker)) return { rows, rowCount: rows.length };
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

describe("remaining deterministic query paths", () => {
  const serviceRows = {
    variable: [{ variable_cost: "10.25" }],
    fixed: [{ fixed_cost: "2.75" }],
    bridge: [
      { factor: "VOLUME", amount: "3.5001" },
      { factor: "PRICE", amount: "-1.25" },
    ],
    drilldownCosts: [
      {
        scenario_version_id: versions.budget,
        fulfillment_center_id: "DE_FC",
        transport_mode_id: "AIR",
        carrier_id: "CARRIER_C",
        cost_category: "BASE_FREIGHT",
        amount: "10",
      },
      {
        scenario_version_id: versions.actual,
        fulfillment_center_id: "DE_FC",
        transport_mode_id: "AIR",
        carrier_id: "CARRIER_C",
        cost_category: "BASE_FREIGHT",
        amount: "13.0001",
      },
    ],
    drilldownFactors: [
      {
        fulfillment_center_id: "DE_FC",
        transport_mode_id: "AIR",
        carrier_id: "CARRIER_C",
        cost_category: "BASE_FREIGHT",
        factor: "MIX",
        amount: "3.0001",
      },
    ],
    warehouse: [
      { scenario_version_id: versions.budget, fulfillment_center_id: "DE_FC", amount: "10" },
      { scenario_version_id: versions.actual, fulfillment_center_id: "DE_FC", amount: "13.0001" },
    ],
  };

  const pathPool = ({ empty = false } = {}) => {
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("FROM logiplan.evidence_snapshot")) return { rows: [], rowCount: 0 };
        if (empty) return { rows: [], rowCount: 0 };
        if (sql.includes("GROUP BY factor")) {
          return { rows: serviceRows.bridge, rowCount: serviceRows.bridge.length };
        }
        if (sql.includes("attribution_cny")) {
          return { rows: serviceRows.drilldownFactors, rowCount: 1 };
        }
        if (sql.includes("cost_category")) {
          return { rows: serviceRows.drilldownCosts, rowCount: serviceRows.drilldownCosts.length };
        }
        if (sql.includes("ORDER BY r.fulfillment_center_id")) {
          return { rows: serviceRows.warehouse, rowCount: serviceRows.warehouse.length };
        }
        if (sql.includes("model_cny_amount")) {
          const variable =
            params?.[0] === versions.actual ? [{ variable_cost: "12.5001" }] : serviceRows.variable;
          return { rows: variable, rowCount: 1 };
        }
        return { rows: serviceRows.fixed, rowCount: 1 };
      }),
    };
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
        if (sql.includes("SELECT data_release_id FROM logiplan.active_release"))
          return { rows: [{ data_release_id: "release-test" }], rowCount: 1 };
        if (sql.includes("persist_query_evidence_snapshot")) {
          const result = JSON.parse(String(params?.[0]));
          delete result._data_release_id;
          result.evidence = result.evidence.map((item: object) => ({
            ...item,
            evidence_snapshot_id: "ES-00000000-0000-4000-8000-000000000001",
            data_release_id: "release-test",
          }));
          if (result.query_intent.question_type === "EVIDENCE_LOOKUP")
            result.payload.evidence = result.evidence[0];
          return { rows: [{ result }], rowCount: 1 };
        }
        return pool.query(sql, params);
      }),
      release: vi.fn(),
    };
    return { ...pool, connect: vi.fn(async () => client) } as unknown as Pool;
  };
  it.each([undefined, "VOLUME", "MIX", "EFFICIENCY", "PRICE", "FX"] as const)(
    "preserves source factor %s independently of evidence metric in exact legacy lookup",
    async (factor) => {
      const query = {
        contract_version: "V1.1" as const,
        question_type: "ATTRIBUTION_DRILLDOWN" as const,
        scope: {
          period: { from: "2026-08", to: "2026-08", grain: "MONTH" as const },
          comparison: "ACTUAL_VS_BUDGET" as const,
          destination_country_ids: ["GB"],
          budget_version_id: versions.budget,
          actual_version_id: versions.actual,
          calculation_version: "D-092",
          ...(factor ? { factor_id: factor } : {}),
        },
        metrics: ["FULFILLMENT_VARIABLE_COST"],
        group_by: [
          "FULFILLMENT_CENTER",
          "TRANSPORT_MODE",
          "CARRIER",
          "COST_COMPONENT",
        ] as QueryIntent["group_by"],
        output_locale: "zh-CN" as const,
        context_sources: ["FIXED_TEMPLATE"] as QueryIntent["context_sources"],
      };
      const result = payloadOf(await runDeterministicQuery(pathPool(), query, "factor-query"));
      expect(result.query_intent.scope).toEqual(query.scope);
      expect(result.payload).toMatchObject({ primary_contribution: factor ?? "VARIANCE" });
      const baseId = "ATTRIBUTION_DRILLDOWN:FC:DE_FC";
      // A MIX source snapshot also proves PRICE, Budget, Actual and total variance.
      for (const id of [
        baseId,
        `${baseId}:BASELINE`,
        `${baseId}:CURRENT`,
        ...["VOLUME", "MIX", "EFFICIENCY", "PRICE", "FX"].map((f) => `${baseId}:FACTOR:${f}`),
      ]) {
        const original = result.evidence.find((item) => item.evidence_id === id)!;
        const restored = payloadOf(
          await runDeterministicQuery(
            pathPool(),
            {
              ...query,
              question_type: "EVIDENCE_LOOKUP",
              evidence_id: id,
              metrics: [],
              group_by: [],
            },
            "factor-lookup",
          ),
        );
        expect(restored.query_intent.scope).toEqual(query.scope);
        expect(restored.evidence[0]).toMatchObject({
          evidence_id: id,
          value: original.value,
          metric: original.metric,
          source_result_id: result.result_id,
        });
      }
      expect(
        await runDeterministicQuery(
          pathPool(),
          {
            ...query,
            question_type: "EVIDENCE_LOOKUP",
            evidence_id: `${baseId}:FACTOR:missing`,
            metrics: [],
            group_by: [],
          },
          "missing-factor-evidence",
        ),
      ).toMatchObject({ code: "EVIDENCE_NOT_FOUND" });
      expect(
        await runDeterministicQuery(
          pathPool(),
          {
            ...query,
            scope: { ...query.scope, carrier_ids: ["CARRIER_C"] },
            question_type: "EVIDENCE_LOOKUP",
            evidence_id: baseId,
            metrics: [],
            group_by: [],
          },
          "unsupported-source",
        ),
      ).toMatchObject({ code: "INVALID_FILTER" });
    },
  );

  it("returns country, bridge, drilldown and warehouse payloads", async () => {
    const countryIntent: QueryIntent = {
      ...intent("COUNTRY_VARIANCE_SUMMARY", []),
      scope: {
        ...intent("COUNTRY_VARIANCE_SUMMARY", []).scope,
        destination_country_ids: ["GB"],
      },
    };
    const countryPool = pathPool();
    const countryResult = payloadOf(
      await runDeterministicQuery(countryPool, countryIntent, "country-path"),
    );
    expect(countryResult.payload).toMatchObject({
      destination_country_id: "GB",
      baseline: { high_precision: "10.25" },
      current: { high_precision: "12.5001" },
      variance: { high_precision: "2.2501" },
    });
    expect(
      vi
        .mocked(countryPool.query)
        .mock.calls.some(
          ([sql]) =>
            String(sql).includes("SUM(c.model_cny_amount)") &&
            !String(sql).includes("report_cny_amount"),
        ),
    ).toBe(true);

    const bridgeResult = payloadOf(
      await runDeterministicQuery(pathPool(), intent("ATTRIBUTION_BRIDGE", []), "bridge-path"),
    );
    expect(bridgeResult.payload).toMatchObject({
      method: "CHAIN",
      baseline: { high_precision: "10.25" },
      current: { high_precision: "12.5001" },
      reconciliation_delta: { high_precision: "0" },
    });
    expect(bridgeResult.evidence[0]?.source_result_id).toBe(bridgeResult.result_id);

    const drilldownResult = payloadOf(
      await runDeterministicQuery(
        pathPool(),
        intent("ATTRIBUTION_DRILLDOWN", []),
        "drilldown-path",
      ),
    );
    const drilldownRows = (drilldownResult.payload as { rows: Array<Record<string, unknown>> })
      .rows;
    expect(drilldownRows.some((row) => row.row_id === "FC:DE_FC")).toBe(true);
    expect(drilldownRows.some((row) => row.row_id === "FC:DE_FC/MODE:AIR")).toBe(true);
    expect(drilldownRows.some((row) => row.row_id === "FC:DE_FC/MODE:AIR/CARRIER:CARRIER_C")).toBe(
      true,
    );
    expect(
      drilldownRows.some(
        (row) => row.row_id === "FC:DE_FC/MODE:AIR/CARRIER:CARRIER_C/COST:BASE_FREIGHT",
      ),
    ).toBe(true);
    const warehouseResult = payloadOf(
      await runDeterministicQuery(
        pathPool(),
        intent("WAREHOUSE_VARIANCE_CONTEXT", []),
        "warehouse-path",
      ),
    );
    expect(warehouseResult.payload).toMatchObject({
      scope: "COMPANY_VARIABLE_COST_ONLY",
      company_total: { variance: { high_precision: "3.0001" } },
    });
  });

  it("looks up exact evidence IDs, rejects unknown IDs and mismatched scopes", async () => {
    const lookupScope = {
      period: { from: "2026-08", to: "2026-08", grain: "MONTH" as const },
      comparison: "ACTUAL_VS_BUDGET" as const,
      destination_country_ids: ["GB"],
      budget_version_id: "BUDGET_2026_V1",
      actual_version_id: "ACTUAL_2026_08_CLOSE_V1",
      calculation_version: "D-092",
    };
    const lookup = (evidence_id: string, scope = lookupScope): QueryIntent => ({
      contract_version: "V1.1",
      question_type: "EVIDENCE_LOOKUP",
      scope,
      metrics: [],
      group_by: [],
      output_locale: "zh-CN",
      context_sources: ["PAGE_VISIBLE_STATE"],
      evidence_id,
    });

    const first = payloadOf(
      await runDeterministicQuery(pathPool(), lookup("E01-country"), "evidence-first"),
    );
    const second = payloadOf(
      await runDeterministicQuery(pathPool(), lookup("E01-country"), "evidence-second"),
    );
    const firstEvidence = first.evidence[0];
    const secondEvidence = second.evidence[0];
    expect(first.contract_version).toBe("V1.1");
    expect(firstEvidence).toMatchObject({
      evidence_id: "E01-country",
      filters: { destination_country_id: ["GB"] },
      value: "2.2501",
    });
    expect(secondEvidence).toMatchObject({
      evidence_id: firstEvidence?.evidence_id,
      source_result_id: firstEvidence?.source_result_id,
      value: firstEvidence?.value,
      versions: firstEvidence?.versions,
    });
    expect(firstEvidence?.snapshot_generated_at).not.toBe(firstEvidence?.source_result_id);

    const unknown = await runDeterministicQuery(
      pathPool(),
      lookup("E01-country:typo"),
      "evidence-unknown",
    );
    expect(unknown).toMatchObject({
      code: "EVIDENCE_NOT_FOUND",
      request_id: "evidence-unknown",
    });

    const mismatched = await runDeterministicQuery(
      pathPool(),
      lookup("E01-country", { ...lookupScope, destination_country_ids: ["DE"] }),
      "evidence-scope",
    );
    expect(mismatched).toMatchObject({
      code: "INVALID_FILTER",
      message_zh: expect.stringContaining("范围不匹配"),
      request_id: "evidence-scope",
    });
  });

  it("rejects malformed intents and unsupported contract branches without database access", async () => {
    const noAccessPool = {
      query: vi.fn(() => Promise.reject(new Error("不得访问数据库"))),
    } as unknown as Pool;
    const base = intent("COUNTRY_VARIANCE_SUMMARY", []);
    const invalid: Array<[unknown, string]> = [
      [null, "INVALID_FILTER"],
      [
        {
          ...base,
          scope: {
            ...base.scope,
            period: { from: "2026-12", to: "2026-01", grain: "RANGE" },
          },
        },
        "INVALID_PERIOD",
      ],
      [
        {
          ...base,
          scope: {
            ...base.scope,
            period: { from: "2026-01", to: "2026-12", grain: "RANGE" },
            destination_country_ids: ["GB"],
          },
          group_by: ["MONTH"],
        },
        "UNSUPPORTED_GRAIN",
      ],
      [{ ...base, question_type: "EVIDENCE_LOOKUP" }, "EVIDENCE_NOT_FOUND"],
      [{ ...base, metrics: ["ORDER_LEVEL_TOP"] }, "ORDER_LEVEL_NOT_AVAILABLE"],
      [{ ...base, question_type: "MANAGEMENT_ANALYSIS" }, "INVALID_METRIC"],
      [{ ...base, scope: { ...base.scope, destination_country_ids: undefined } }, "INVALID_FILTER"],
    ];
    for (const [rawIntent, code] of invalid) {
      const response = await runDeterministicQuery(noAccessPool, rawIntent, `invalid-${code}`);
      expect(response).toMatchObject({ code });
    }
    expect(noAccessPool.query).not.toHaveBeenCalled();

    const seamFilterCases: Array<[QueryIntent, string]> = [
      [
        { ...base, scope: { ...base.scope, destination_country_ids: undefined } },
        "diagnostic-missing-country",
      ],
      [
        { ...base, scope: { ...base.scope, actual_version_id: undefined } },
        "diagnostic-missing-actual",
      ],
    ];
    for (const [query, requestId] of seamFilterCases) {
      await expect(runDiagnosticMetrics(noAccessPool, query, requestId)).rejects.toMatchObject({
        error_id: `ERR-${requestId}`,
        code: "INVALID_FILTER",
        request_id: requestId,
      });
    }
    expect(noAccessPool.query).not.toHaveBeenCalled();
  });
});

describe("ATTRIBUTION_DRILLDOWN high-precision reconciliation", () => {
  const factors = ["VOLUME", "MIX", "EFFICIENCY", "PRICE", "FX"] as const;
  const queryIntent: QueryIntent = {
    contract_version: "V1.1",
    question_type: "ATTRIBUTION_DRILLDOWN",
    scope: {
      period: { from: "2026-08", to: "2026-08", grain: "MONTH" },
      comparison: "ACTUAL_VS_BUDGET",
      destination_country_ids: ["GB"],
      budget_version_id: versions.budget,
      actual_version_id: versions.actual,
      calculation_version: "D-092",
    },
    metrics: ["FULFILLMENT_VARIABLE_COST"],
    group_by: ["FULFILLMENT_CENTER", "TRANSPORT_MODE", "CARRIER", "COST_COMPONENT"],
    output_locale: "zh-CN",
    context_sources: ["PAGE_VISIBLE_STATE", "FIXED_TEMPLATE"],
  };
  // First cost pair reproduces R_GB_DE_B_AIR|BASE_FREIGHT. The other pairs and
  // factor allocations are synthetic, with branching at every parent level.
  const atoms = [
    ["DE_FC", "AIR", "CARRIER_B", "BASE_FREIGHT"],
    ["DE_FC", "AIR", "CARRIER_B", "FUEL_SURCHARGE"],
    ["DE_FC", "AIR", "CARRIER_C", "BASE_FREIGHT"],
    ["DE_FC", "ROAD", "CARRIER_A", "BASE_FREIGHT"],
    ["FR_FC", "ROAD", "CARRIER_A", "BASE_FREIGHT"],
  ].map(([center, mode, carrier, category], index) => ({
    fulfillment_center_id: center!,
    transport_mode_id: mode!,
    carrier_id: carrier!,
    cost_category: category!,
    baseline: index === 0 ? "18949.1871744" : "10.000000000000000000000001",
    current: index === 0 ? "160481.6719439568864768" : "13.000060000000000000000003",
    contributions:
      index === 0
        ? ["100000", "40000", "1000", "500", "32.4847695568864768"]
        : ["1", "2", "0.00001", "-0.00002", "0.000070000000000000000002"],
  }));
  const sum = (values: string[]) =>
    values.reduce((total, value) => total.plus(value), new LogiPlanDecimal("0"));

  const fixturePool = (factorErrors: readonly string[] = []) => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("persist_query_evidence_snapshot")) {
        const result = JSON.parse(String(params?.[0]));
        delete result._data_release_id;
        result.evidence = result.evidence.map((item: object) => ({
          ...item,
          evidence_snapshot_id: "ES-00000000-0000-4000-8000-000000000002",
          data_release_id: "LOGIPLAN_2026_DEMO_V2",
        }));
        return { rows: [{ result }], rowCount: 1 };
      }
      if (sql.includes("FROM logiplan.evidence_snapshot") || /^(BEGIN|COMMIT|ROLLBACK)/.test(sql))
        return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT data_release_id FROM logiplan.active_release"))
        return { rows: [{ data_release_id: "LOGIPLAN_2026_DEMO_V2" }], rowCount: 1 };
      if (sql.includes("AS variable_cost")) {
        expect(params?.[3]).toEqual(["GB"]);
        const amount = sum(
          atoms.map((atom) =>
            params?.[0] === versions.budget
              ? atom.baseline
              : sql.includes("c.report_cny_amount")
                ? new LogiPlanDecimal(atom.current).toFixed(4)
                : atom.current,
          ),
        );
        return { rows: [{ variable_cost: amount.toFixed() }], rowCount: 1 };
      }
      if (sql.includes("FROM logiplan.active_fixed_cost_scenario_fact"))
        return { rows: [{ fixed_cost: "0" }], rowCount: 1 };
      if (sql.includes("FROM logiplan.active_scenario_cost_component_fact")) {
        // Emulate the projected numeric column: the pre-fix SQL selects Actual
        // report values quantized per row, not the model values used by factors.
        const rows = atoms.flatMap((atom) => [
          { ...atom, scenario_version_id: versions.budget, amount: atom.baseline },
          {
            ...atom,
            scenario_version_id: versions.actual,
            amount: sql.includes("c.report_cny_amount")
              ? new LogiPlanDecimal(atom.current).toFixed(4)
              : atom.current,
          },
        ]);
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("FROM logiplan.active_variance_attribution_fact")) {
        const rows = atoms.flatMap((atom, atomIndex) =>
          factors.map((factor, factorIndex) => ({
            ...atom,
            factor,
            amount: new LogiPlanDecimal(atom.contributions[factorIndex]!)
              .plus(factorIndex === 0 ? (factorErrors[atomIndex] ?? "0") : "0")
              .toFixed(),
          })),
        );
        if (sql.includes("GROUP BY factor")) {
          expect(params?.[4]).toEqual(["GB"]);
          return {
            rows: factors.map((factor) => ({
              factor,
              amount: sum(
                rows.filter((row) => row.factor === factor).map((row) => row.amount),
              ).toFixed(),
            })),
            rowCount: factors.length,
          };
        }
        return { rows, rowCount: rows.length };
      }
      throw new Error(`未模拟 SQL：${sql}`);
    });
    const client = { query, release: vi.fn() };
    return { query, connect: vi.fn(async () => client) } as unknown as Pool;
  };

  it("reconciles model costs and all five factors at every level despite per-row report quantization", async () => {
    const baseline = sum(atoms.map((atom) => atom.baseline));
    const current = sum(atoms.map((atom) => atom.current));
    const rowReports = sum(atoms.map((atom) => new LogiPlanDecimal(atom.current).toFixed(4)));
    const contribution = sum(atoms.flatMap((atom) => atom.contributions));
    expect(rowReports.equals(current)).toBe(false);
    expect(rowReports.toFixed(4)).not.toBe(current.toFixed(4));
    expect(current.minus(baseline).equals(contribution)).toBe(true);

    const pool = fixturePool();
    const result = payloadOf(await runDeterministicQuery(pool, queryIntent, "quantized-report"));
    type Row = {
      row_id: string;
      parent_row_id: string | null;
      children_available: boolean;
      baseline_cost: MoneyValue;
      current_cost: MoneyValue;
      variance: MoneyValue;
      factor_contributions: Record<(typeof factors)[number], MoneyValue>;
    };
    const { rows } = result.payload as { rows: Row[] };
    const roots = rows.filter((row) => row.parent_row_id === null);
    expect(roots).toHaveLength(2);
    expect(rows.filter((row) => !row.children_available)).toHaveLength(atoms.length);
    expect(sum(roots.map((row) => row.baseline_cost.high_precision)).equals(baseline)).toBe(true);
    expect(sum(roots.map((row) => row.current_cost.high_precision)).equals(current)).toBe(true);
    expect(sum(roots.map((row) => row.variance.high_precision)).equals(contribution)).toBe(true);

    for (const row of rows) {
      expect(
        new LogiPlanDecimal(row.current_cost.high_precision)
          .minus(row.baseline_cost.high_precision)
          .equals(row.variance.high_precision),
      ).toBe(true);
      expect(
        sum(factors.map((factor) => row.factor_contributions[factor].high_precision)).equals(
          row.variance.high_precision,
        ),
      ).toBe(true);
      const children = rows.filter((child) => child.parent_row_id === row.row_id);
      const values: Array<[string, (item: Row) => MoneyValue]> = [
        ["", (item) => item.variance],
        [":BASELINE", (item) => item.baseline_cost],
        [":CURRENT", (item) => item.current_cost],
        ...factors.map((factor): [string, (item: Row) => MoneyValue] => [
          `:FACTOR:${factor}`,
          (item) => item.factor_contributions[factor],
        ]),
      ];
      if (row.children_available) expect(children.length).toBeGreaterThan(0);
      for (const [suffix, getValue] of values) {
        const value = getValue(row);
        if (row.children_available) {
          expect(sum(children.map((child) => getValue(child).high_precision)).toFixed()).toBe(
            value.high_precision,
          );
        }
        expect(value.report).toBe(new LogiPlanDecimal(value.high_precision).toFixed(4));
        expect(value.display).toBe(new LogiPlanDecimal(value.high_precision).toFixed(2));
        const item = result.evidence.find(
          (item) => item.evidence_id === `ATTRIBUTION_DRILLDOWN:${row.row_id}${suffix}`,
        );
        expect(item?.value).toBe(value.high_precision);
        expect(item?.calculation_method).not.toContain("report_cny_amount");
      }
    }
    expect(pool.query).toHaveBeenCalledWith("COMMIT");
    expect(pool.query).not.toHaveBeenCalledWith("ROLLBACK");
  });

  it.each(["1", "0.000000000000000000000001"])(
    "rejects a real model/factor mismatch of %s CNY without a report-level tolerance",
    async (factorError) => {
      const pool = fixturePool([factorError]);
      const result = await runDeterministicQuery(pool, queryIntent, "inconsistent-factors");
      expect(result).toMatchObject({
        code: "RECONCILIATION_FAILED",
        message_zh: "下钻顶层总差异未与五因素贡献合计勾稽",
        request_id: "inconsistent-factors",
      });
      expect(pool.query).toHaveBeenCalledWith("ROLLBACK");
      expect(pool.query).not.toHaveBeenCalledWith("COMMIT");
    },
  );

  it("keeps country summary and waterfall equal to the unrounded drilldown totals", async () => {
    const drilldown = payloadOf(
      await runDeterministicQuery(fixturePool(), queryIntent, "aligned-drilldown"),
    );
    const country = payloadOf(
      await runDeterministicQuery(
        fixturePool(),
        {
          ...queryIntent,
          question_type: "COUNTRY_VARIANCE_SUMMARY",
          group_by: [],
        },
        "aligned-country",
      ),
    );
    const bridge = payloadOf(
      await runDeterministicQuery(
        fixturePool(),
        {
          ...queryIntent,
          question_type: "ATTRIBUTION_BRIDGE",
          group_by: [],
        },
        "aligned-bridge",
      ),
    );
    const roots = (
      drilldown.payload as {
        rows: Array<{
          parent_row_id: string | null;
          baseline_cost: MoneyValue;
          current_cost: MoneyValue;
          variance: MoneyValue;
          factor_contributions: Record<(typeof factors)[number], MoneyValue>;
        }>;
      }
    ).rows.filter((row) => row.parent_row_id === null);
    const c = country.payload as {
      baseline: MoneyValue;
      current: MoneyValue;
      variance: MoneyValue;
    };
    const b = bridge.payload as {
      baseline: MoneyValue;
      current: MoneyValue;
      factors: Array<{ factor_id: string; amount: MoneyValue }>;
      reconciliation_delta: MoneyValue;
    };
    for (const [value, expected] of [
      [c.baseline, sum(roots.map((row) => row.baseline_cost.high_precision))],
      [c.current, sum(roots.map((row) => row.current_cost.high_precision))],
      [c.variance, sum(roots.map((row) => row.variance.high_precision))],
    ] as const) {
      expect(value.high_precision).toBe(expected.toFixed());
      expect(value.report).toBe(expected.toFixed(4));
      expect(value.display).toBe(expected.toFixed(2));
    }
    expect(b.baseline).toEqual(c.baseline);
    expect(b.current).toEqual(c.current);
    expect(b.reconciliation_delta.high_precision).toBe("0");
    expect(sum(b.factors.map((factor) => factor.amount.high_precision)).toFixed()).toBe(
      c.variance.high_precision,
    );
    for (const factor of factors) {
      expect(b.factors.find((item) => item.factor_id === factor)?.amount.high_precision).toBe(
        sum(roots.map((row) => row.factor_contributions[factor].high_precision)).toFixed(),
      );
    }
    expect(country.evidence[0]?.value).toBe(c.variance.high_precision);
    expect(bridge.evidence[0]?.value).toBe(c.variance.high_precision);
  });

  it("rolls back opposite atomic errors even when they cancel within the same carrier", async () => {
    const errors = ["1", "-1"];
    expect(sum(errors).toFixed()).toBe("0");
    const pool = fixturePool(errors);
    const result = await runDeterministicQuery(pool, queryIntent, "opposite-atomic-errors");
    expect("code" in result).toBe(true);
    expect(result).toMatchObject({
      code: "RECONCILIATION_FAILED",
      request_id: "opposite-atomic-errors",
    });
    expect(result).toHaveProperty(
      "message_zh",
      expect.stringContaining("FC:DE_FC/MODE:AIR/CARRIER:CARRIER_B/COST:BASE_FREIGHT"),
    );
    expect(pool.query).toHaveBeenCalledWith("ROLLBACK");
    expect(pool.query).not.toHaveBeenCalledWith("COMMIT");
  });
});

describe("DIAGNOSTIC_METRICS deterministic query", () => {
  it("returns the complete August GB order, structure, service and maturity payload", async () => {
    const result = await runDiagnosticMetrics(
      poolFor("/* DIAGNOSTIC_METRICS */", diagnosticRows()),
      diagnosticIntent(),
      "diagnostics",
    );
    const payload = result.payload as {
      scope: {
        period: { from: string; to: string; grain: string };
        comparison: string;
        destination_country_ids: string[];
        budget_version_id: string;
        actual_version_id: string;
        calculation_version: string;
      };
      diagnostics: Array<{
        diagnostic_id: string;
        current: { high_precision: string; report: string; display: string; unit: string };
        baseline: { high_precision: string; report: string; display: string; unit: string } | null;
        delta: { high_precision: string; report: string; display: string; unit: string } | null;
        delta_rate: {
          high_precision: string;
          report: string;
          display: string;
          unit: string;
        } | null;
        delta_label: string;
        evidence_ids: string[];
      }>;
      service_evaluation: {
        maturity_status: string;
        status_label_zh: string;
        on_time_denominator_policy_zh: string;
        maturity_definition_zh: string;
      };
      interpretation_boundary_zh: string;
    };
    const metric = (id: string) => payload.diagnostics.find((item) => item.diagnostic_id === id);

    expect(payload.scope).toEqual({
      period: { from: "2026-08", to: "2026-08", grain: "MONTH" },
      comparison: "ACTUAL_VS_BUDGET",
      destination_country_ids: ["GB"],
      budget_version_id: versions.budget,
      actual_version_id: versions.actual,
      calculation_version: "CALC_V1",
    });
    expect(payload.diagnostics.map((item) => item.diagnostic_id)).toEqual([
      "ORDERS",
      "AIR_SHARE",
      "CARRIER_C_SHARE",
      "ON_TIME_RATE",
      "SERVICE_MATURITY",
    ]);
    expect(metric("ORDERS")).toMatchObject({
      current: { high_precision: "8932", display: "8932.00", unit: "COUNT" },
      baseline: { high_precision: "4800", display: "4800.00", unit: "COUNT" },
      delta: { high_precision: "4132", display: "4132.00", unit: "COUNT" },
      delta_rate: { report: "86.0833", display: "86.08", unit: "PERCENT" },
    });
    expect(metric("AIR_SHARE")).toMatchObject({
      current: { report: "66.0166", display: "66.02", unit: "PERCENT" },
      baseline: { report: "13.6925", display: "13.69", unit: "PERCENT" },
      delta: { report: "52.3241", display: "52.32", unit: "PERCENTAGE_POINT" },
      delta_rate: null,
    });
    expect(metric("CARRIER_C_SHARE")).toMatchObject({
      current: { report: "38.8382", display: "38.84", unit: "PERCENT" },
      baseline: { report: "2.8769", display: "2.88", unit: "PERCENT" },
      delta: { report: "35.9613", display: "35.96", unit: "PERCENTAGE_POINT" },
      delta_rate: null,
    });
    expect(metric("ON_TIME_RATE")).toMatchObject({
      current: { report: "96.1621", display: "96.16", unit: "PERCENT" },
      baseline: { report: "94.1099", display: "94.11", unit: "PERCENT" },
      delta: { display: "2.05", unit: "PERCENTAGE_POINT" },
      delta_rate: null,
    });
    expect(metric("SERVICE_MATURITY")).toMatchObject({
      current: { high_precision: "92", report: "92.0000", display: "92.00", unit: "PERCENT" },
      baseline: null,
      delta: null,
      delta_rate: null,
      delta_label: "结果尚未最终成熟",
    });
    expect(payload.service_evaluation).toMatchObject({
      maturity_status: "NOT_FINAL",
      status_label_zh: "结果尚未最终成熟",
    });
    expect(payload.service_evaluation.on_time_denominator_policy_zh).toContain(
      "未到承诺截止日期的在途包裹不进入分母",
    );
    expect(payload.service_evaluation.maturity_definition_zh).toContain("不代表履约质量");
    expect(payload.interpretation_boundary_zh).toContain("不得推断未记录的经营因果");
    expect(result.warnings.map((warning) => warning.code)).toEqual(["SERVICE_NOT_MATURE"]);
    expect(result.warnings[0]?.message).toContain("不进入准时履约率分母");
    expect(result.evidence).toHaveLength(14);
    expect(new Set(result.evidence.map((item) => item.evidence_id)).size).toBe(14);
    for (const item of result.evidence) {
      expect(evidenceObjectSchema.safeParse(item).success).toBe(true);
      expect(item.period).toEqual({ from: "2026-08", to: "2026-08" });
      expect(item.comparison).toBe("ACTUAL_VS_BUDGET");
      expect(item.filters).toEqual({ destination_country_id: ["GB"] });
      expect(item.group_by).toEqual([]);
      expect(item.source_result_id).toMatch(/^Q-[a-f0-9]{64}$/u);
      expect(item.source_refs).toEqual([
        "logiplan.active_country_order_fact",
        "logiplan.active_fulfillment_scenario_fact",
        "logiplan.active_fulfillment_route",
        "logiplan.active_scenario_version",
      ]);
      expect(typeof item.value).toBe("string");
    }
    expect(
      result.evidence.find((item) => item.evidence_id.endsWith("AIR_SHARE:DELTA")),
    ).toMatchObject({ unit: "PERCENTAGE_POINT", value: expect.any(String) });
    expect(
      result.evidence.find((item) => item.evidence_id.endsWith("ON_TIME_RATE:CURRENT")),
    ).toMatchObject({ unit: "PERCENT", value: expect.any(String) });
  });

  it("returns request-bound errors for invalid scope, fields, versions and incomplete facts", async () => {
    const base = diagnosticIntent();
    const invalid: Array<[QueryIntent, string]> = [
      [
        {
          ...base,
          scope: { ...base.scope, period: { from: "2026-07", to: "2026-08", grain: "MONTH" } },
        },
        "INVALID_PERIOD",
      ],
      [
        {
          ...base,
          scope: { ...base.scope, period: { from: "2026-08", to: "2026-08", grain: "RANGE" } },
        },
        "UNSUPPORTED_GRAIN",
      ],
      [{ ...base, metrics: ["ORDERS"] }, "INVALID_METRIC"],
      [{ ...base, group_by: ["DESTINATION_COUNTRY"] }, "INVALID_DIMENSION"],
      [{ ...base, scope: { ...base.scope, destination_country_ids: ["DE"] } }, "INVALID_FILTER"],
      [{ ...base, scope: { ...base.scope, carrier_ids: ["CARRIER_C"] } }, "INVALID_FILTER"],
      [
        { ...base, scope: { ...base.scope, forecast_version_id: versions.forecast } },
        "INVALID_FILTER",
      ],
    ];
    const noAccessPool = {
      query: vi.fn(() => Promise.reject(new Error("不得访问数据库"))),
    } as unknown as Pool;
    for (const [query, code] of invalid) {
      const response = await runDeterministicQuery(noAccessPool, query, `diagnostic-${code}`);
      expect(response).toMatchObject({ code, request_id: `diagnostic-${code}` });
    }
    expect(noAccessPool.query).not.toHaveBeenCalled();

    const missingVersion = runDiagnosticMetrics(
      poolFor("/* DIAGNOSTIC_METRICS */", diagnosticRows().slice(0, 1)),
      base,
      "diagnostic-version",
    );
    await expect(missingVersion).rejects.toMatchObject({
      code: "VERSION_NOT_FOUND",
      request_id: "diagnostic-version",
    });

    const extraVersionRows = diagnosticRows();
    const extraVersionBase = extraVersionRows[0];
    if (extraVersionBase === undefined) throw new Error("测试缺少 Budget 行");
    extraVersionRows.push({
      ...extraVersionBase,
      scenario_version_id: "EXTRA_VERSION",
      scenario_type: "BUDGET",
    });
    const extraVersion = runDiagnosticMetrics(
      poolFor("/* DIAGNOSTIC_METRICS */", extraVersionRows),
      base,
      "diagnostic-extra-version",
    );
    await expect(extraVersion).rejects.toMatchObject({
      code: "VERSION_NOT_FOUND",
      request_id: "diagnostic-extra-version",
    });

    const monthMismatchRows = diagnosticRows();
    const monthMismatch = monthMismatchRows[1];
    if (monthMismatch === undefined) throw new Error("测试缺少 Actual 行");
    monthMismatch.latest_closed_month = "2026-07-01";
    const monthMismatchResult = runDiagnosticMetrics(
      poolFor("/* DIAGNOSTIC_METRICS */", monthMismatchRows),
      base,
      "diagnostic-month-mismatch",
    );
    await expect(monthMismatchResult).rejects.toMatchObject({
      code: "VERSION_NOT_FOUND",
      request_id: "diagnostic-month-mismatch",
    });

    const routeGapRows = diagnosticRows();
    const currentWithRouteGap = routeGapRows[1];
    if (currentWithRouteGap === undefined) throw new Error("测试缺少 Actual 行");
    currentWithRouteGap.route_count = 4;
    const routeGap = runDiagnosticMetrics(
      poolFor("/* DIAGNOSTIC_METRICS */", routeGapRows),
      base,
      "diagnostic-route-gap",
    );
    await expect(routeGap).rejects.toMatchObject({
      code: "RECONCILIATION_FAILED",
      request_id: "diagnostic-route-gap",
    });

    const serviceGapRows = diagnosticRows();
    const currentWithServiceGap = serviceGapRows[1];
    if (currentWithServiceGap === undefined) throw new Error("测试缺少 Actual 行");
    currentWithServiceGap.missing_service_count = 1;
    const serviceGap = runDiagnosticMetrics(
      poolFor("/* DIAGNOSTIC_METRICS */", serviceGapRows),
      base,
      "diagnostic-service-gap",
    );
    await expect(serviceGap).rejects.toMatchObject({
      code: "RECONCILIATION_FAILED",
      request_id: "diagnostic-service-gap",
    });

    const wrongOrderSourceRows = diagnosticRows();
    const wrongOrderSource = wrongOrderSourceRows[1];
    if (wrongOrderSource === undefined) throw new Error("测试缺少 Actual 行");
    wrongOrderSource.order_source_model = "equivalent_order_qty";
    const wrongOrderSourceResult = runDiagnosticMetrics(
      poolFor("/* DIAGNOSTIC_METRICS */", wrongOrderSourceRows),
      base,
      "diagnostic-order-source",
    );
    await expect(wrongOrderSourceResult).rejects.toMatchObject({
      code: "RECONCILIATION_FAILED",
      request_id: "diagnostic-order-source",
    });

    const quantityCases = [
      ["order_qty", "0"],
      ["package_qty", "0"],
      ["due_package_qty", "0"],
      ["air_package_qty", "-1"],
      ["carrier_c_package_qty", "-1"],
      ["on_time_delivered_package_qty", "-1"],
      ["air_package_qty", "20000"],
      ["carrier_c_package_qty", "20000"],
      ["due_package_qty", "20000"],
      ["on_time_delivered_package_qty", "20000"],
    ] as const;
    for (const [field, value] of quantityCases) {
      const rows = diagnosticRows();
      const actual = rows[1];
      if (actual === undefined) throw new Error("测试缺少 Actual 行");
      actual[field] = value;
      const result = runDiagnosticMetrics(
        poolFor("/* DIAGNOSTIC_METRICS */", rows),
        base,
        `diagnostic-quantity-${field}`,
      );
      await expect(result).rejects.toMatchObject({
        code: "RECONCILIATION_FAILED",
        request_id: `diagnostic-quantity-${field}`,
      });
    }

    const malformedFactCases = [
      ["package_qty", null, "diagnostic-null-fact"],
      ["order_qty", "not-a-decimal", "diagnostic-invalid-decimal"],
    ] as const;
    for (const [field, value, requestId] of malformedFactCases) {
      const rows = diagnosticRows();
      const actual = rows[1];
      if (actual === undefined) throw new Error("测试缺少 Actual 行");
      Object.assign(actual, { [field]: value });
      await expect(
        runDiagnosticMetrics(poolFor("/* DIAGNOSTIC_METRICS */", rows), base, requestId),
      ).rejects.toMatchObject({
        error_id: `ERR-${requestId}`,
        code: "RECONCILIATION_FAILED",
        request_id: requestId,
      });
    }
  });

  it("marks a 100% mature service result as final without a maturity warning", async () => {
    const rows = diagnosticRows();
    const current = rows[1];
    if (current === undefined) throw new Error("测试缺少 Actual 行");
    Object.assign(current, { latest_closed_month: new Date("2026-08-01T00:00:00.000Z") });
    current.due_package_qty = current.package_qty;
    current.on_time_delivered_package_qty = "10468.3741615";
    const result = await runDiagnosticMetrics(
      poolFor("/* DIAGNOSTIC_METRICS */", rows),
      diagnosticIntent(),
      "diagnostic-final",
    );
    const payload = result.payload as {
      service_evaluation: { maturity_status: string; status_label_zh: string };
    };
    expect(payload.service_evaluation).toEqual({
      maturity_status: "FINAL",
      status_label_zh: "结果已最终成熟",
      on_time_denominator_policy_zh:
        "准时履约率分母仅包含已到承诺截止日期的包裹；未到承诺截止日期的在途包裹不进入分母。",
      maturity_definition_zh:
        "服务成熟度是已到承诺截止日期包裹量占发运 cohort 全部包裹量的比例，不代表履约质量。",
    });
    expect(result.warnings).toEqual([]);
  });
});

describe("query service boundary paths", () => {
  it("dispatches diagnostic metrics through the dedicated service seam", async () => {
    const result = payloadOf(
      await runDeterministicQuery(
        poolFor("/* DIAGNOSTIC_METRICS */", diagnosticRows()),
        diagnosticIntent(),
        "diagnostic-dispatch",
      ),
    );

    expect(result.payload).toMatchObject({
      diagnostics: expect.arrayContaining([expect.objectContaining({ diagnostic_id: "ORDERS" })]),
    });
    expect(result.evidence.every((item) => item.source_result_id === result.result_id)).toBe(true);
  });

  it("rethrows infrastructure errors without converting them to business errors", async () => {
    const pool = {
      query: vi.fn(() => Promise.reject(new Error("数据库连接失败"))),
    } as unknown as Pool;

    await expect(
      runDeterministicQuery(pool, intent("DASHBOARD_OVERVIEW", []), "infrastructure-error"),
    ).rejects.toThrow("数据库连接失败");
  });

  it("reads readiness from schema and the singleton active release", async () => {
    const readyPool = {
      query: vi.fn(async (sql: string) =>
        sql.includes("current_schema_version")
          ? { rows: [{ version: "0004" }] }
          : { rows: [{ data_release_id: "LOGIPLAN_2026_DEMO_V2" }], rowCount: 1 },
      ),
    } as unknown as Pool;
    await expect(checkReadiness(readyPool)).resolves.toEqual({
      schema_version: "0004",
      active_release: "LOGIPLAN_2026_DEMO_V2",
    });

    const noActiveReleasePool = {
      query: vi.fn(async (sql: string) =>
        sql.includes("current_schema_version")
          ? { rows: [{ version: "0004" }] }
          : { rows: [], rowCount: 0 },
      ),
    } as unknown as Pool;
    await expect(checkReadiness(noActiveReleasePool)).rejects.toThrow("活动正式版本数量不是 1");
  });
});
