import { Client } from "pg";

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

interface QueryBaseline {
  readonly name: string;
  readonly sql: string;
  readonly expectedRows: number;
  readonly requiredRelations: readonly string[];
}

const baselines: readonly QueryBaseline[] = [
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

async function verify(): Promise<void> {
  const client = new Client({
    connectionString: requiredEnvironment("DATABASE_URL"),
    application_name: "logiplan-query-plan-verifier",
  });
  await client.connect();
  try {
    const summaries: Array<Record<string, string | number | readonly string[]>> = [];
    for (const baseline of baselines) {
      const result = await client.query<ExplainRow>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${baseline.sql}`,
      );
      const document = result.rows[0]?.["QUERY PLAN"][0];
      assert(document !== undefined, `${baseline.name} 未返回查询计划`);
      const nodes = flattenPlan(document.Plan);
      const relationNames = new Set(
        nodes
          .map((node) => node["Relation Name"])
          .filter((name): name is string => name !== undefined),
      );
      for (const relation of baseline.requiredRelations) {
        assert(relationNames.has(relation), `${baseline.name} 未访问必要关系 ${relation}`);
      }
      assert(
        (document.Plan["Actual Rows"] ?? -1) === baseline.expectedRows,
        `${baseline.name} 结果行数与基线不一致`,
      );
      const tempWrittenBlocks = nodes.reduce(
        (total, node) => total + (node["Temp Written Blocks"] ?? 0),
        0,
      );
      assert(tempWrittenBlocks === 0, `${baseline.name} 发生临时磁盘写入`);
      assert(document["Execution Time"] < 1_000, `${baseline.name} 单次执行超过 1 秒`);
      summaries.push({
        name: baseline.name,
        planning_ms: document["Planning Time"],
        execution_ms: document["Execution Time"],
        top_node: document.Plan["Node Type"],
        actual_rows: document.Plan["Actual Rows"] ?? 0,
        temp_written_blocks: tempWrittenBlocks,
        relations: [...relationNames].sort(),
      });
    }
    process.stdout.write(`${JSON.stringify(summaries)}\n`);
  } finally {
    await client.end();
  }
}

await verify().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "未知查询计划验证错误";
  process.stderr.write(`查询计划验证失败：${message}\n`);
  process.exitCode = 1;
});
