import { randomUUID } from "node:crypto";

import type { QueryIntent } from "@logiplan/contracts";
import { Client, Pool } from "pg";

import { runDeterministicQuery } from "./query-service";

const immutableV1ReleaseId = "LOGIPLAN_2026_DEMO_V1";
const upgradedV2ReleaseId = "LOGIPLAN_2026_DEMO_V2";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function diagnosticDisplay(payload: unknown, diagnosticId: string, field: "current" | "delta") {
  assert(isRecord(payload), "升级验收的诊断 payload 不是对象");
  const diagnostics = payload.diagnostics;
  assert(Array.isArray(diagnostics), "升级验收的诊断 payload 缺少 diagnostics");
  const diagnostic = diagnostics.find(
    (item) => isRecord(item) && item.diagnostic_id === diagnosticId,
  );
  assert(isRecord(diagnostic), `升级验收缺少诊断指标 ${diagnosticId}`);
  const value = diagnostic[field];
  assert(isRecord(value) && typeof value.display === "string", `${diagnosticId}.${field} 无效`);
  return value.display;
}

const diagnosticIntent: QueryIntent = {
  question_type: "DIAGNOSTIC_METRICS",
  scope: {
    period: { from: "2026-08", to: "2026-08", grain: "MONTH" },
    comparison: "ACTUAL_VS_BUDGET",
    destination_country_ids: ["GB"],
    budget_version_id: "BUDGET_2026_V1",
    actual_version_id: "ACTUAL_2026_08_CLOSE_V1",
    calculation_version: "D-092",
  },
  metrics: ["ORDERS", "AIR_SHARE", "CARRIER_C_SHARE", "ON_TIME_RATE", "SERVICE_MATURITY"],
  group_by: [],
  output_locale: "zh-CN",
  context_sources: ["FIXED_TEMPLATE"],
};

async function verify(): Promise<void> {
  const publisher = new Client({
    connectionString: requiredEnvironment("PUBLISHER_DATABASE_URL"),
    application_name: "logiplan-release-workflow-verifier",
  });
  const reader = new Client({
    connectionString: requiredEnvironment("DATABASE_URL"),
    application_name: "logiplan-release-reader-verifier",
  });
  const readerPool = new Pool({
    connectionString: requiredEnvironment("DATABASE_URL"),
    application_name: "logiplan-upgrade-query-service-verifier",
    max: 2,
  });
  await Promise.all([publisher.connect(), reader.connect()]);
  try {
    const before = await reader.query<{ data_release_id: string; status: string }>(
      "SELECT data_release_id, status FROM logiplan.active_release",
    );
    const active = before.rows[0];
    assert(before.rowCount === 1 && active?.status === "ACTIVE", "验证前必须存在唯一活动发布");
    assert(
      active.data_release_id === upgradedV2ReleaseId,
      `兼容结构验证后活动发布应为 ${upgradedV2ReleaseId}`,
    );

    const releaseMetadata = await publisher.query<{
      data_release_id: string;
      status: string;
      database_schema_version: string;
      input_checksum_sha256: string;
    }>(
      `SELECT data_release_id, status, database_schema_version, input_checksum_sha256
       FROM logiplan.data_release
       WHERE data_release_id = ANY($1::text[])
       ORDER BY data_release_id`,
      [[immutableV1ReleaseId, upgradedV2ReleaseId]],
    );
    const releases = new Map(releaseMetadata.rows.map((row) => [row.data_release_id, row]));
    assert(releases.get(immutableV1ReleaseId)?.status === "RETIRED", "V1 应在 V2 激活后退役");
    assert(
      releases.get(immutableV1ReleaseId)?.database_schema_version === "0003" &&
        releases.get(immutableV1ReleaseId)?.input_checksum_sha256 ===
          "4d7285a9d3cbe0671e98be3f0409e01847870a824f41e53fe4e4d8532862c674",
      "V1 发布元数据或校验和被升级流程改写",
    );
    assert(
      releases.get(upgradedV2ReleaseId)?.status === "ACTIVE" &&
        releases.get(upgradedV2ReleaseId)?.database_schema_version === "0004" &&
        releases.get(upgradedV2ReleaseId)?.input_checksum_sha256 ===
          "4cbd7759d4a85a0c2c755fcf58fcbe49156083e4a81f22bf7506928148d35dfc",
      "V2 发布元数据、状态或校验和不正确",
    );

    const activeOrders = await reader.query<{
      scenario_type: string;
      order_qty: string;
      source_model: string;
    }>(
      `SELECT scenario_type, order_qty::text, source_model
       FROM logiplan.active_country_order_fact
       WHERE month_id = DATE '2026-08-01'
         AND destination_country_id = 'GB'
         AND scenario_type IN ('BUDGET', 'ACTUAL')
       ORDER BY scenario_type`,
    );
    const orders = new Map(activeOrders.rows.map((row) => [row.scenario_type, row]));
    assert(
      orders.get("BUDGET")?.order_qty === "4800.0000" &&
        orders.get("BUDGET")?.source_model === "budget_country_month",
      "活动 Budget 目的国真实订单事实错误",
    );
    assert(
      orders.get("ACTUAL")?.order_qty === "8932.0000" &&
        orders.get("ACTUAL")?.source_model === "actual_country_warehouse_fulfillment",
      "活动 Actual 目的国真实订单事实错误",
    );

    const diagnostic = await runDeterministicQuery(
      readerPool,
      diagnosticIntent,
      "release-upgrade-diagnostic",
    );
    if ("code" in diagnostic) {
      throw new Error(
        `升级后 DIAGNOSTIC_METRICS 返回业务错误：${diagnostic.code} ${diagnostic.message_zh}`,
      );
    }
    assert(
      diagnosticDisplay(diagnostic.payload, "ORDERS", "current") === "8932.00" &&
        diagnosticDisplay(diagnostic.payload, "AIR_SHARE", "delta") === "52.32" &&
        diagnosticDisplay(diagnostic.payload, "CARRIER_C_SHARE", "delta") === "35.96" &&
        diagnosticDisplay(diagnostic.payload, "ON_TIME_RATE", "current") === "96.16" &&
        diagnosticDisplay(diagnostic.payload, "SERVICE_MATURITY", "current") === "92.00",
      "升级后 DIAGNOSTIC_METRICS 固定值不正确",
    );
    assert(
      diagnostic.warnings.some((warning) => warning.code === "SERVICE_NOT_MATURE"),
      "升级后 DIAGNOSTIC_METRICS 缺少服务未成熟警告",
    );

    const probeId = `rollback-probe-${randomUUID()}`;
    await publisher.query("BEGIN");
    try {
      await publisher.query(
        `SELECT logiplan.create_data_release_candidate(
           $1, $1, repeat('0', 64), '0009', 'verify', 'verify', '回切事务验收', clock_timestamp()
         )`,
        [probeId],
      );
      await publisher.query("SELECT logiplan.mark_data_release_validated($1, $2::jsonb)", [
        probeId,
        JSON.stringify({ status: "PASS", purpose: "rollback-verification" }),
      ]);
      await publisher.query("SELECT logiplan.activate_data_release($1)", [probeId]);
      await publisher.query("SELECT logiplan.activate_data_release($1)", [active.data_release_id]);

      const inside = await publisher.query<{ data_release_id: string; status: string }>(
        `SELECT a.data_release_id, r.status
         FROM logiplan.active_data_release AS a
         JOIN logiplan.data_release AS r USING (data_release_id)
         WHERE a.singleton`,
      );
      assert(
        inside.rowCount === 1 &&
          inside.rows[0]?.data_release_id === active.data_release_id &&
          inside.rows[0].status === "ACTIVE",
        "退役发布未能在同一事务中安全回切",
      );
    } finally {
      await publisher.query("ROLLBACK");
    }

    const after = await reader.query<{ data_release_id: string; status: string }>(
      "SELECT data_release_id, status FROM logiplan.active_release",
    );
    assert(
      after.rowCount === 1 &&
        after.rows[0]?.data_release_id === active.data_release_id &&
        after.rows[0].status === "ACTIVE",
      "回切验收事务回滚后活动发布发生变化",
    );
  } finally {
    await Promise.all([publisher.end(), reader.end(), readerPool.end()]);
  }
}

await verify()
  .then(() => {
    process.stdout.write("0003→0009 不可变发布升级、活动订单事实和诊断查询验证通过\n");
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "未知发布流程验证错误";
    process.stderr.write(`发布流程验证失败：${message}\n`);
    process.exitCode = 1;
  });
