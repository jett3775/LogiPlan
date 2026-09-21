import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  target,
  validateAdminConnectionEnvironment,
  validateRoleMemberships,
  validateTargetEnvironment,
} from "./neon-baseline.mjs";

const requireFromDatabasePackage = createRequire(
  new URL("../packages/db/package.json", import.meta.url),
);
const { Client } = requireFromDatabasePackage("pg");

const managedRoleNames = Object.freeze(["schema_migrator", "data_publisher", "app_reader"]);
const databaseNamePattern = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/u;
const roleMembershipSql = `SELECT membership.roleid AS parent_oid,
       parent.rolname AS parent_role,
       membership.member AS member_oid,
       member.rolname AS member_role,
       membership.grantor AS grantor_oid,
       grantor.rolname AS grantor_role,
       grantor.rolsuper AS grantor_is_superuser,
       membership.admin_option,
       membership.inherit_option,
       membership.set_option
FROM pg_auth_members AS membership
JOIN pg_roles AS parent ON parent.oid = membership.roleid
JOIN pg_roles AS member ON member.oid = membership.member
LEFT JOIN pg_roles AS grantor ON grantor.oid = membership.grantor
WHERE parent.rolname = ANY($1::text[])
   OR member.rolname = ANY($1::text[])
ORDER BY parent.rolname, member.rolname, membership.grantor`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseAuditArguments(argv) {
  const options = { timeoutMs: 10_000 };
  assert(
    argv.every(
      (argument) =>
        !/postgres(?:ql)?:\/\//iu.test(argument) &&
        !/(?:DATABASE_URL|NEON_[A-Z0-9_]*PASSWORD)=/u.test(argument),
    ),
    "连接串和密码只能通过环境变量传入，禁止作为命令行参数",
  );
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--report") {
      throw new Error("不再支持 --report；成功结果只输出到标准输出");
    }
    const value = argv[index + 1];
    assert(value !== undefined && value.length > 0, `缺少参数值：${argument}`);
    if (argument === "--expected-database") options.expectedDatabase = value;
    else if (argument === "--timeout-seconds") {
      const seconds = Number.parseInt(value, 10);
      assert(Number.isInteger(seconds) && seconds >= 5 && seconds <= 60, "超时必须为 5—60 秒");
      options.timeoutMs = seconds * 1_000;
    } else throw new Error(`未知参数：${argument}`);
    index += 1;
  }
  if (options.help) return options;
  assert(options.expectedDatabase !== undefined, "缺少参数：--expected-database");
  assert(databaseNamePattern.test(options.expectedDatabase), "预期数据库名称无效");
  return options;
}

export function validateAuditEnvironment(environment, expectedDatabase) {
  const endpointId = validateTargetEnvironment(environment);
  const admin = validateAdminConnectionEnvironment(environment, expectedDatabase, endpointId);
  return { endpointId, admin };
}

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function safeEncode(value) {
  try {
    return encodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function connectionSecrets(value) {
  if (typeof value !== "string" || value.length === 0) return [];
  const secrets = [value];
  try {
    const parsed = new URL(value);
    if (parsed.password.length > 0) {
      secrets.push(parsed.password);
      const decodedPassword = safeDecode(parsed.password);
      if (decodedPassword !== undefined) {
        secrets.push(decodedPassword);
        const encodedPassword = safeEncode(decodedPassword);
        if (encodedPassword !== undefined) secrets.push(encodedPassword);
      }
    }
  } catch {
    // Keep the raw independent secret even when the connection string is malformed.
  }
  return [...new Set(secrets.filter((secret) => secret.length > 0))];
}

export function redact(text, secrets) {
  let result = String(text)
    .replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/giu, "[REDACTED_DATABASE_URL]")
    .replace(/[a-z0-9-]+(?:-pooler)?\.[a-z0-9-]+\.aws\.neon\.tech/giu, "[REDACTED_DATABASE_HOST]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/gu, "[REDACTED_IP]");
  const expandedSecrets = secrets.flatMap(connectionSecrets);
  for (const secret of [...new Set(expandedSecrets)].sort(
    (left, right) => right.length - left.length,
  )) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

export function formatAuditError(error, environment = process.env) {
  const message = error instanceof Error ? error.message : "未知错误";
  return `Neon 权限只读诊断失败：${redact(
    message,
    connectionSecrets(environment.NEON_ADMIN_DATABASE_URL),
  )}`;
}

export function assertAuditDatabaseIdentity(identity, expectedRole, expectedDatabase) {
  assert(identity?.current_user === expectedRole, `数据库实际角色不是 ${expectedRole}`);
  assert(identity?.session_user === expectedRole, `数据库会话角色不是 ${expectedRole}`);
  assert(identity?.current_database === expectedDatabase, `数据库实际名称不是 ${expectedDatabase}`);
  assert(
    String(identity?.server_version_num) === "180006",
    `PostgreSQL 补丁版本不是 ${target.postgresVersion}（实际为 ${String(
      identity?.server_version ?? "UNKNOWN",
    )}）`,
  );
}

async function queryDatabaseState(client, releaseId) {
  const migrationsObject = await client.query(
    "SELECT to_regclass('public._schema_migrations') IS NOT NULL AS exists",
  );
  const releasesObject = await client.query(
    "SELECT to_regclass('logiplan.data_release') IS NOT NULL AS exists",
  );
  const activeReleaseObject = await client.query(
    "SELECT to_regclass('logiplan.active_data_release') IS NOT NULL AS exists",
  );
  const state = {
    migrations_object_exists: migrationsObject.rows[0]?.exists === true,
    release_object_exists: releasesObject.rows[0]?.exists === true,
    active_release_object_exists: activeReleaseObject.rows[0]?.exists === true,
    latest_migration: null,
    latest_migration_checksum_sha256: null,
    migration_checksums: null,
    release_status: null,
    v2_data_package_checksum_sha256: null,
    active_release: null,
  };
  if (state.migrations_object_exists) {
    const migrations = (
      await client.query(
        `SELECT version, checksum_sha256
         FROM public._schema_migrations
         ORDER BY version`,
      )
    ).rows;
    const migration = migrations.at(-1);
    state.latest_migration = migration?.version ?? null;
    state.latest_migration_checksum_sha256 = migration?.checksum_sha256 ?? null;
    state.migration_checksums =
      migrations.length === 0
        ? null
        : migrations.map(({ version, checksum_sha256 }) => ({ version, checksum_sha256 }));
  }
  if (state.release_object_exists) {
    const release = (
      await client.query(
        `SELECT status, input_checksum_sha256
         FROM logiplan.data_release
         WHERE data_release_id = $1`,
        [releaseId],
      )
    ).rows[0];
    state.release_status = release?.status ?? null;
    state.v2_data_package_checksum_sha256 = release?.input_checksum_sha256 ?? null;
  }
  if (state.active_release_object_exists) {
    state.active_release =
      (
        await client.query(
          "SELECT data_release_id FROM logiplan.active_data_release WHERE singleton",
        )
      ).rows[0]?.data_release_id ?? null;
  }
  return state;
}

export async function runReadOnlyAudit(client, adminRole, expectedDatabase, timeoutMs = 10_000) {
  assert(
    Number.isInteger(timeoutMs) && timeoutMs >= 5_000 && timeoutMs <= 60_000,
    "只读诊断超时无效",
  );
  let transactionStarted = false;
  let report;
  try {
    await client.query("BEGIN READ ONLY");
    transactionStarted = true;
    await client.query(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
    const identity = (
      await client.query(`SELECT current_user,
         session_user,
         current_database(),
         current_setting('server_version_num') AS server_version_num,
         current_setting('server_version') AS server_version,
         current_setting('createrole_self_grant', true) AS createrole_self_grant`)
    ).rows[0];
    assertAuditDatabaseIdentity(identity, adminRole, expectedDatabase);
    const roleNames = [adminRole, ...managedRoleNames];
    const roles = await client.query(
      `SELECT oid, rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication,
              rolbypassrls, rolcanlogin, rolinherit, rolconnlimit,
              rolvaliduntil IS NULL AS no_expiry,
              COALESCE(cardinality(rolconfig), 0) AS config_count
       FROM pg_roles
       WHERE rolname = ANY($1::text[])
       ORDER BY rolname`,
      [roleNames],
    );
    const memberships = await client.query(roleMembershipSql, [managedRoleNames]);
    const databasePrivileges = await client.query(
      `SELECT role_name,
              has_database_privilege(role_name, current_database(), 'CONNECT') AS can_connect,
              has_database_privilege(role_name, current_database(), 'CREATE') AS can_create,
              has_database_privilege(role_name, current_database(), 'TEMPORARY') AS can_temporary
       FROM unnest($1::text[]) AS names(role_name)
       ORDER BY role_name`,
      [managedRoleNames],
    );
    const publicSchemaPrivileges = await client.query(
      `SELECT role_name,
              has_schema_privilege(role_name, 'public', 'USAGE') AS can_use,
              has_schema_privilege(role_name, 'public', 'CREATE') AS can_create
       FROM unnest($1::text[]) AS names(role_name)
       ORDER BY role_name`,
      [managedRoleNames],
    );
    const applicationSchema = await client.query(
      "SELECT to_regnamespace('logiplan') IS NOT NULL AS exists",
    );
    let applicationSchemaPrivileges = [];
    if (applicationSchema.rows[0]?.exists === true) {
      applicationSchemaPrivileges = (
        await client.query(
          `SELECT role_name,
                  has_schema_privilege(role_name, 'logiplan', 'USAGE') AS can_use,
                  has_schema_privilege(role_name, 'logiplan', 'CREATE') AS can_create
           FROM unnest($1::text[]) AS names(role_name)
           ORDER BY role_name`,
          [managedRoleNames],
        )
      ).rows;
    }
    const databaseState = await queryDatabaseState(client, target.releaseId);
    let validation;
    try {
      validateRoleMemberships(memberships.rows, { adminRole });
      validation = { status: "accepted" };
    } catch (error) {
      validation = {
        status: "rejected",
        reason: error instanceof Error ? error.message : "角色成员关系校验失败",
      };
    }
    report = {
      format_version: "1",
      status: "read_only_audit_completed",
      target: {
        project_name: target.projectName,
        project_id: target.projectId,
        region: target.region,
        branch_name: target.branchName,
        branch_id: target.branchId,
        endpoint_fingerprint: fingerprint(client.connectionParameters?.host ?? "unknown"),
        database: identity?.current_database,
        expected_database: expectedDatabase,
      },
      identity: {
        current_user: identity?.current_user,
        session_user: identity?.session_user,
        server_version_num: identity?.server_version_num,
        server_version: identity?.server_version,
        createrole_self_grant: identity?.createrole_self_grant ?? null,
      },
      roles: roles.rows,
      memberships: memberships.rows,
      role_validation: validation,
      database_privileges: databasePrivileges.rows,
      public_schema_privileges: publicSchemaPrivileges.rows,
      application_schema: {
        exists: applicationSchema.rows[0]?.exists === true,
        privileges: applicationSchemaPrivileges,
      },
      database_state: databaseState,
      transaction: { mode: "READ ONLY", rollback: "pending" },
    };
    return report;
  } finally {
    if (transactionStarted) {
      await client.query("ROLLBACK");
      if (report !== undefined) report.transaction.rollback = "confirmed";
    }
  }
}

export async function runPermissionAudit(options, environment = process.env) {
  const { endpointId, admin } = validateAuditEnvironment(environment, options.expectedDatabase);
  const client = new Client({
    connectionString: admin.raw,
    application_name: "logiplan-neon-permission-audit",
    connectionTimeoutMillis: options.timeoutMs,
    query_timeout: options.timeoutMs,
  });
  try {
    await client.connect();
    const report = await runReadOnlyAudit(
      client,
      decodeURIComponent(admin.parsed.username),
      options.expectedDatabase,
      options.timeoutMs,
    );
    report.target.endpoint_id = endpointId;
    return report;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function usage() {
  return "用法：pnpm neon:permission-audit -- --expected-database <数据库> [--timeout-seconds 10]\n默认只读，不执行迁移、发布、权限写入或 SET ROLE；管理连接串只从 NEON_ADMIN_DATABASE_URL 读取；成功结果只输出脱敏 JSON。\n";
}

export function formatAuditOutput(report) {
  return `${JSON.stringify(report)}\n`;
}

export async function executeAuditCli(argv, environment = process.env, audit = runPermissionAudit) {
  const options = parseAuditArguments(argv);
  if (options.help) {
    return formatAuditOutput({ status: "help", usage: usage().trimEnd() });
  }
  return formatAuditOutput(await audit(options, environment));
}

async function main() {
  process.stdout.write(await executeAuditCli(process.argv.slice(2)));
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await main().catch((error) => {
    process.stderr.write(`${formatAuditError(error)}\n`);
    process.exitCode = 1;
  });
}
