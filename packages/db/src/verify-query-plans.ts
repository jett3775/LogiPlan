import { Client, Pool } from "pg";
import type { QueryIntent } from "@logiplan/contracts";

import { runDeterministicQuery } from "./query-service";

interface PlanNode {
  readonly "Node Type": string;
  readonly "Relation Name"?: string;
  readonly "Actual Rows"?: number;
  readonly "Temp Written Blocks"?: number;
  readonly Plans?: readonly PlanNode[];
}

interface ExplainDocument {
  readonly Plan: PlanNode;
  readonly "Planning Time": number;
  readonly "Execution Time": number;
}

interface ExplainRow {
  readonly "QUERY PLAN": readonly ExplainDocument[];
}

interface PlanExpectation {
  readonly name: string;
  readonly expectedRows: number;
  readonly requiredRelations: readonly string[];
}

interface StaticQueryBaseline extends PlanExpectation {
  readonly sql: string;
}

interface ServiceQueryBaseline extends PlanExpectation {
  readonly marker: string;
  readonly intent: QueryIntent;
}

type PlanSummary = Record<string, string | number | readonly string[]>;

const staticBaselines: readonly StaticQueryBaseline[] = [
  {
    name: "dashboard-variable-cost-by-series",
    expectedRows: 3,
    requiredRelations: ["fulfillment_scenario_fact", "scenario_cost_component_fact"],
    sql: `
      SELECT f.scenario_type, round(sum(c.model_cny_amount), 4)::text AS variable_cost
      FROM logiplan.active_fulfillment_scenario_fact AS f
      JOIN logiplan.active_scenario_cost_component_fact AS c
        ON c.data_release_id = f.data_release_id
       AND c.fulfillment_fact_id = f.fulfillment_fact_id
      GROUP BY f.scenario_type
      ORDER BY f.scenario_type
    `,
  },
  {
    name: "august-gb-chain-attribution",
    expectedRows: 5,
    requiredRelations: ["variance_attribution_fact", "fulfillment_route"],
    sql: `
      SELECT a.factor, round(sum(a.attribution_cny), 4)::text AS amount
      FROM logiplan.active_variance_attribution_fact AS a
      JOIN logiplan.active_fulfillment_route AS r
        ON r.data_release_id = a.data_release_id
       AND r.route_id = a.route_id
      WHERE a.comparison_id = 'ACTUAL_VS_BUDGET'
        AND a.month_id = DATE '2026-08-01'
        AND a.attribution_method = 'CHAIN_SUBSTITUTION'
        AND r.destination_country_id = 'GB'
      GROUP BY a.factor
      ORDER BY a.factor
    `,
  },
];

function dashboardIntent(
  questionType: "MONTHLY_COST_TREND" | "TOP_ADVERSE_ANOMALIES" | "FIXED_COST_BREAKDOWN",
): QueryIntent {
  const fixedCost = questionType === "FIXED_COST_BREAKDOWN";
  const adverse = questionType === "TOP_ADVERSE_ANOMALIES";
  return {
    question_type: questionType,
    scope: {
      period: { from: "2026-01", to: "2026-12", grain: fixedCost ? "RANGE" : "MONTH" },
      comparison: "LATEST_OUTLOOK_VS_BUDGET",
      budget_version_id: "BUDGET_2026_V1",
      actual_version_id: "ACTUAL_2026_08_CLOSE_V1",
      forecast_version_id: "FORECAST_2026_08_V1",
      calculation_version: "D-092",
    },
    metrics: [
      fixedCost
        ? "LOGISTICS_FIXED_COST"
        : adverse
          ? "FULFILLMENT_VARIABLE_COST"
          : "LOGISTICS_TOTAL_COST",
    ],
    group_by: fixedCost
      ? ["FIXED_COST_CATEGORY", "FULFILLMENT_CENTER"]
      : adverse
        ? ["MONTH", "DESTINATION_COUNTRY"]
        : ["MONTH"],
    ...(adverse ? { top_n: 5 } : {}),
    output_locale: "zh-CN",
    context_sources: ["FIXED_TEMPLATE"],
  };
}

const serviceBaselines: readonly ServiceQueryBaseline[] = [
  {
    name: "monthly-cost-trend",
    marker: "/* MONTHLY_COST_TREND */",
    expectedRows: 24,
    requiredRelations: [
      "active_data_release",
      "fixed_cost_scenario_fact",
      "fulfillment_scenario_fact",
      "scenario_cost_component_fact",
      "scenario_version",
    ],
    intent: dashboardIntent("MONTHLY_COST_TREND"),
  },
  {
    name: "top-adverse-anomalies",
    marker: "/* TOP_ADVERSE_ANOMALIES */",
    expectedRows: 72,
    requiredRelations: [
      "active_data_release",
      "fulfillment_route",
      "fulfillment_scenario_fact",
      "scenario_cost_component_fact",
    ],
    intent: dashboardIntent("TOP_ADVERSE_ANOMALIES"),
  },
  {
    name: "fixed-cost-breakdown",
    marker: "/* FIXED_COST_FACTS */",
    expectedRows: 168,
    requiredRelations: ["active_data_release", "fixed_cost_scenario_fact", "scenario_version"],
    intent: dashboardIntent("FIXED_COST_BREAKDOWN"),
  },
];

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`缺少环境变量：${name}`);
  }
  return value;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function flattenPlan(node: PlanNode): readonly PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap((child) => flattenPlan(child))];
}

async function explainAndVerify(
  client: Client,
  baseline: PlanExpectation,
  sql: string,
  values: readonly unknown[] = [],
): Promise<PlanSummary> {
  const result = await client.query<ExplainRow>({
    text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    values: [...values],
  });
  const document = result.rows[0]?.["QUERY PLAN"][0];
  assert(document !== undefined, `${baseline.name} 未返回查询计划`);
  const nodes = flattenPlan(document.Plan);
  const relationNames = new Set(
    nodes.map((node) => node["Relation Name"]).filter((name): name is string => name !== undefined),
  );
  for (const relation of baseline.requiredRelations) {
    assert(relationNames.has(relation), `${baseline.name} 未访问必要关系 ${relation}`);
  }
  const actualRows = document.Plan["Actual Rows"] ?? -1;
  assert(
    actualRows === baseline.expectedRows,
    `${baseline.name} 结果行数 ${actualRows} 与基线 ${baseline.expectedRows} 不一致`,
  );
  const tempWrittenBlocks = nodes.reduce(
    (total, node) => total + (node["Temp Written Blocks"] ?? 0),
    0,
  );
  assert(tempWrittenBlocks === 0, `${baseline.name} 发生临时磁盘写入`);
  assert(document["Execution Time"] < 1_000, `${baseline.name} 单次执行超过 1 秒`);
  return {
    name: baseline.name,
    planning_ms: document["Planning Time"],
    execution_ms: document["Execution Time"],
    top_node: document.Plan["Node Type"],
    actual_rows: document.Plan["Actual Rows"] ?? 0,
    temp_written_blocks: tempWrittenBlocks,
    relations: [...relationNames].sort(),
  };
}

async function verify(): Promise<void> {
  const connectionString = requiredEnvironment("DATABASE_URL");
  const client = new Client({
    connectionString,
    application_name: "logiplan-query-plan-verifier",
  });
  const pool = new Pool({
    connectionString,
    application_name: "logiplan-query-plan-service-runner",
    max: 2,
  });
  await client.connect();
  try {
    const identity = await client.query<{ current_user: string }>("SELECT current_user");
    assert(identity.rows[0]?.current_user === "app_reader", "查询计划必须使用 app_reader 执行");
    const summaries: PlanSummary[] = [];
    for (const baseline of staticBaselines) {
      summaries.push(await explainAndVerify(client, baseline, baseline.sql));
    }

    for (const baseline of serviceBaselines) {
      let captures = 0;
      const instrumentedPool = new Proxy(pool, {
        get(target, property) {
          if (property === "query") {
            return async (sql: string, values: readonly unknown[] = []) => {
              if (sql.includes(baseline.marker)) {
                captures += 1;
                summaries.push(await explainAndVerify(client, baseline, sql, values));
              }
              return target.query(sql, [...values]);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const result = await runDeterministicQuery(
        instrumentedPool,
        baseline.intent,
        `query-plan-${baseline.name}`,
      );
      assert(!("code" in result), `${baseline.name} 查询服务返回业务错误`);
      assert(
        result.query_intent.question_type === baseline.intent.question_type,
        `${baseline.name} 未返回预期查询类型`,
      );
      assert(captures === 1, `${baseline.name} 应且仅应捕获一次参数化主 SQL`);
    }
    process.stdout.write(`${JSON.stringify(summaries)}\n`);
  } finally {
    await Promise.allSettled([client.end(), pool.end()]);
  }
}

await verify().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "未知查询计划验证错误";
  process.stderr.write(`查询计划验证失败：${message}\n`);
  process.exitCode = 1;
});
