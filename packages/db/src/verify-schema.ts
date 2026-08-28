import { randomUUID } from "node:crypto";

import { Client, DatabaseError } from "pg";

const activeViews = [
  "active_release",
  "active_destination_country",
  "active_fulfillment_center",
  "active_carrier",
  "active_transport_mode",
  "active_fulfillment_route",
  "active_business_event_note",
  "active_scenario_version",
  "active_country_order_fact",
  "active_fulfillment_scenario_fact",
  "active_scenario_cost_component_fact",
  "active_scenario_gmv_fact",
  "active_fixed_cost_scenario_fact",
  "active_variance_comparison",
  "active_variance_attribution_fact",
  "active_attribution_sensitivity_result",
] as const;

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

async function expectPermissionDenied(
  client: Client,
  sql: string,
  description: string,
): Promise<void> {
  try {
    await client.query(sql);
  } catch (error: unknown) {
    if (error instanceof DatabaseError && error.code === "42501") {
      return;
    }
    throw error;
  }
  throw new Error(`${description}未被数据库权限拒绝`);
}

async function expectDatabaseErrorCode(
  client: Client,
  sql: string,
  expectedCode: string,
  description: string,
): Promise<void> {
  try {
    await client.query(sql);
  } catch (error: unknown) {
    if (error instanceof DatabaseError && error.code === expectedCode) {
      return;
    }
    throw error;
  }
  throw new Error(`${description}未按预期失败`);
}

async function verify(): Promise<void> {
  const migrator = new Client({
    connectionString: requiredEnvironment("MIGRATION_DATABASE_URL"),
    application_name: "logiplan-schema-verifier",
  });
  const publisher = new Client({
    connectionString: requiredEnvironment("PUBLISHER_DATABASE_URL"),
    application_name: "logiplan-publisher-permission-verifier",
  });
  const reader = new Client({
    connectionString: requiredEnvironment("DATABASE_URL"),
    application_name: "logiplan-reader-permission-verifier",
  });

  await Promise.all([migrator.connect(), publisher.connect(), reader.connect()]);
  try {
    const migration = await migrator.query<{ version: string }>(
      "SELECT version FROM public._schema_migrations ORDER BY version DESC LIMIT 1",
    );
    assert(migration.rows[0]?.version === "0004", "数据库未应用 Gate 1 当前迁移");

    const precision = await migrator.query<{ numeric_precision: number; numeric_scale: number }>(`
      SELECT numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'logiplan'
        AND table_name = 'variance_attribution_fact'
        AND column_name = 'attribution_cny'
    `);
    assert(
      precision.rows[0]?.numeric_precision === 50 && precision.rows[0].numeric_scale === 24,
      "归因事实未使用 numeric(50,24)",
    );

    const publisherPrivileges = await publisher.query<{
      can_insert_fact: boolean;
      can_insert_release: boolean;
      can_update_fact: boolean;
      can_delete_fact: boolean;
      can_activate: boolean;
    }>(`
      SELECT
        has_table_privilege(
          current_user, 'logiplan.fulfillment_scenario_fact', 'INSERT'
        ) AS can_insert_fact,
        has_table_privilege(
          current_user, 'logiplan.data_release', 'INSERT'
        ) AS can_insert_release,
        has_table_privilege(
          current_user, 'logiplan.fulfillment_scenario_fact', 'UPDATE'
        ) AS can_update_fact,
        has_table_privilege(
          current_user, 'logiplan.fulfillment_scenario_fact', 'DELETE'
        ) AS can_delete_fact,
        has_function_privilege(
          current_user, 'logiplan.activate_data_release(text)', 'EXECUTE'
        ) AS can_activate
    `);
    assert(
      publisherPrivileges.rows[0]?.can_insert_fact === true,
      "发布角色缺少候选业务数据写入权限",
    );
    assert(
      publisherPrivileges.rows[0]?.can_insert_release === false,
      "发布角色不应绕过受控函数登记发布版本",
    );
    assert(publisherPrivileges.rows[0]?.can_update_fact === false, "发布角色不应更新历史业务事实");
    assert(publisherPrivileges.rows[0]?.can_delete_fact === false, "发布角色不应删除历史业务事实");
    assert(publisherPrivileges.rows[0]?.can_activate === true, "发布角色缺少受控激活权限");

    const probeId = `verify-${randomUUID()}`;
    await publisher.query("BEGIN");
    try {
      await publisher.query(
        `SELECT logiplan.create_data_release_candidate(
           $1, $1, repeat('0', 64), '0004', 'verify', 'verify', '权限验收', clock_timestamp()
         )`,
        [probeId],
      );
      await publisher.query(
        `INSERT INTO logiplan.dim_destination_country (
           data_release_id, destination_country_id, destination_country_name_zh, active_from
         ) VALUES ($1, 'VERIFY', '验收国家', DATE '2026-01-01')`,
        [probeId],
      );
      await publisher.query(
        "SELECT logiplan.mark_data_release_validated($1, jsonb_build_object('verify', true))",
        [probeId],
      );
      await expectDatabaseErrorCode(
        publisher,
        `INSERT INTO logiplan.dim_carrier (
           data_release_id, carrier_id, carrier_name, demo_role_note, is_demo_entity
         ) VALUES ('${probeId}', 'VERIFY', '验收承运商', '验收', true)`,
        "P0001",
        "发布角色向已校验版本追加业务数据",
      );
    } finally {
      await publisher.query("ROLLBACK");
    }

    const failedProbeId = `verify-failed-${randomUUID()}`;
    await publisher.query("BEGIN");
    try {
      await publisher.query(
        `SELECT logiplan.create_data_release_candidate(
           $1, $1, repeat('0', 64), '0004', 'verify', 'verify', '失败关闭验收', clock_timestamp()
         )`,
        [failedProbeId],
      );
      await publisher.query(
        "SELECT logiplan.mark_data_release_failed($1, jsonb_build_object('verify', true))",
        [failedProbeId],
      );
      await expectDatabaseErrorCode(
        publisher,
        `INSERT INTO logiplan.dim_carrier (
           data_release_id, carrier_id, carrier_name, demo_role_note, is_demo_entity
         ) VALUES ('${failedProbeId}', 'VERIFY', '验收承运商', '验收', true)`,
        "P0001",
        "发布角色向失败候选追加业务数据",
      );
    } finally {
      await publisher.query("ROLLBACK");
    }

    const readerPrivileges = await reader.query<{
      base_select: boolean;
      budget_order_select: boolean;
      actual_order_select: boolean;
      view_select: boolean;
      order_view_select: boolean;
    }>(`
      SELECT
        has_table_privilege(current_user, 'logiplan.data_release', 'SELECT') AS base_select,
        has_table_privilege(
          current_user, 'logiplan.budget_country_month', 'SELECT'
        ) AS budget_order_select,
        has_table_privilege(
          current_user, 'logiplan.actual_country_warehouse_fulfillment', 'SELECT'
        ) AS actual_order_select,
        has_table_privilege(current_user, 'logiplan.active_release', 'SELECT') AS view_select,
        has_table_privilege(
          current_user, 'logiplan.active_country_order_fact', 'SELECT'
        ) AS order_view_select
    `);
    assert(readerPrivileges.rows[0]?.base_select === false, "运行角色不应读取候选发布基础表");
    assert(
      readerPrivileges.rows[0]?.budget_order_select === false &&
        readerPrivileges.rows[0]?.actual_order_select === false,
      "运行角色不应直接读取目的国订单源表",
    );
    assert(readerPrivileges.rows[0]?.view_select === true, "运行角色缺少活动版本视图权限");
    assert(
      readerPrivileges.rows[0]?.order_view_select === true,
      "运行角色缺少活动目的国订单事实视图权限",
    );

    for (const view of activeViews) {
      await reader.query(`SELECT 1 FROM logiplan.${view} LIMIT 0`);
    }
    await expectPermissionDenied(
      reader,
      "SELECT 1 FROM logiplan.data_release LIMIT 0",
      "运行角色读取候选发布基础表",
    );
    await expectPermissionDenied(
      reader,
      "SELECT 1 FROM logiplan.budget_country_month LIMIT 0",
      "运行角色读取 Budget 目的国订单源表",
    );
    await expectPermissionDenied(
      reader,
      "SELECT 1 FROM logiplan.actual_country_warehouse_fulfillment LIMIT 0",
      "运行角色读取 Actual 目的国仓级订单源表",
    );
    await expectPermissionDenied(
      reader,
      `INSERT INTO logiplan.data_release (
         data_release_id, release_version, status, input_checksum_sha256,
         database_schema_version, calculation_version, generator_version,
         source_description, generated_at
       ) VALUES (
         'permission-probe', 'permission-probe', 'CANDIDATE', repeat('0', 64),
         '0001', 'probe', 'probe', 'probe', clock_timestamp()
       )`,
      "运行角色写入候选发布基础表",
    );
  } finally {
    await Promise.all([migrator.end(), publisher.end(), reader.end()]);
  }
}

await verify()
  .then(() => {
    process.stdout.write("数据库结构、精度和三角色权限验证通过\n");
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "未知数据库验证错误";
    process.stderr.write(`数据库验证失败：${message}\n`);
    process.exitCode = 1;
  });
