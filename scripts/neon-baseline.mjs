import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { terminateProcessTree } from "./wait-for-server.mjs";

const requireFromDatabasePackage = createRequire(
  new URL("../packages/db/package.json", import.meta.url),
);
const { Client } = requireFromDatabasePackage("pg");

export const target = Object.freeze({
  projectName: "logiplan-public-test",
  projectId: "mute-mouse-49732061",
  region: "aws-ap-southeast-1",
  postgresVersion: "18.6",
  branchName: "main",
  branchId: "br-patient-smoke-b3f5jtui",
  vercelTeam: "logi-plan",
  vercelProject: "logi-plan-web",
  vercelRoot: "apps/web",
  vercelRegion: "sin1",
  candidateSha: "0229755a097dff94c8de67954b36ab4f9412c0f5",
  candidateBranch: "codex/gate1-delivery-baseline",
  releaseId: "LOGIPLAN_2026_DEMO_V2",
});

const roleConnections = Object.freeze([
  {
    env: "MIGRATION_DATABASE_URL",
    passwordEnv: "NEON_SCHEMA_MIGRATOR_PASSWORD",
    role: "schema_migrator",
    pooled: false,
  },
  {
    env: "PUBLISHER_DATABASE_URL",
    passwordEnv: "NEON_DATA_PUBLISHER_PASSWORD",
    role: "data_publisher",
    pooled: false,
  },
  {
    env: "DATABASE_URL",
    passwordEnv: "NEON_APP_READER_PASSWORD",
    role: "app_reader",
    pooled: true,
  },
]);
const targetEnvironment = Object.freeze({
  LOGIPLAN_NEON_PROJECT_NAME: target.projectName,
  LOGIPLAN_NEON_PROJECT_ID: target.projectId,
  LOGIPLAN_NEON_REGION: target.region,
  LOGIPLAN_NEON_BRANCH_NAME: target.branchName,
  LOGIPLAN_NEON_BRANCH_ID: target.branchId,
  LOGIPLAN_NEON_POSTGRES_VERSION: target.postgresVersion,
});
const protectedCandidatePaths = Object.freeze([
  "database/migrations",
  "database/releases",
  "data/generated",
  "scripts/generate_demo_data.py",
  "scripts/upgrade_demo_release_v2.py",
]);
export const executionClosurePaths = Object.freeze([
  "package.json",
  "tsconfig.base.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/neon-baseline.mjs",
  "scripts/neon-baseline.ps1",
  "scripts/neon-baseline.test.mjs",
  "scripts/neon-permission-audit.mjs",
  "scripts/neon-permission-audit.test.mjs",
  "scripts/run-db-integration-tests.mjs",
  "scripts/verify-gate1-isolated.mjs",
  "scripts/wait-for-server.mjs",
  "packages/db/package.json",
  "packages/db/tsconfig.json",
  "packages/db/src",
  "packages/domain/package.json",
  "packages/domain/tsconfig.json",
  "packages/domain/src",
  "packages/contracts/package.json",
  "packages/contracts/tsconfig.json",
  "packages/contracts/src",
  "apps/web/package.json",
  "apps/web/vercel.json",
  "database/migrations",
  "database/releases",
  "data/generated",
]);
export const writeOutcomeUnknownExitCode = 75;
// 数据库写入口在“写入已提交、提交后观察或清理失败”时输出的前缀：此时写入结果是已知的、已提交的，
// 不能归入 writeOutcomeUnknown，也不能回落为普通 known_failed。
export const writeCommittedObservationFailedMarker = "[WRITE_COMMITTED_OBSERVATION_FAILED]";
// 第 3 类结果在报告中的 write_outcome 取值；既有取值含义不变，只是新增一个可机器识别的取值。
export const committedObservationFailedWriteOutcome = "committed_observation_failed";
const managedRoleNames = Object.freeze(["schema_migrator", "data_publisher", "app_reader"]);
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
const expectedRoleProperties = Object.freeze({
  schema_migrator: Object.freeze({ canLogin: true, inherit: true, connectionLimit: -1 }),
  data_publisher: Object.freeze({ canLogin: true, inherit: true, connectionLimit: -1 }),
  app_reader: Object.freeze({ canLogin: true, inherit: true, connectionLimit: -1 }),
});
const appReaderSelectRelations = new Set([
  "active_release",
  "active_destination_country",
  "active_fulfillment_center",
  "active_carrier",
  "active_transport_mode",
  "active_fulfillment_route",
  "active_business_event_note",
  "active_scenario_version",
  "active_fulfillment_scenario_fact",
  "active_scenario_cost_component_fact",
  "active_scenario_gmv_fact",
  "active_fixed_cost_scenario_fact",
  "active_variance_comparison",
  "active_variance_attribution_fact",
  "active_attribution_sensitivity_result",
  "active_country_order_fact",
  "evidence_snapshot",
]);
const publisherSelectRelations = new Set([
  "active_destination_country",
  "active_fulfillment_center",
  "active_carrier",
  "active_transport_mode",
  "active_fulfillment_route",
  "active_scenario_version",
  "active_fulfillment_scenario_fact",
  "active_scenario_cost_component_fact",
  "active_scenario_gmv_fact",
  "active_fixed_cost_scenario_fact",
  "active_variance_comparison",
  "active_variance_attribution_fact",
  "active_attribution_sensitivity_result",
  "active_country_order_fact",
]);
const publisherNoPrivilegeRelations = new Set([
  "active_release",
  "active_business_event_note",
  "evidence_snapshot",
]);
// 发布记账表由 SECURITY DEFINER 函数写入（0001 显式 REVOKE INSERT），
// data_publisher 只持有 SELECT；视图在 PostgreSQL 中同样不可写入。
const publisherReadOnlyRelations = new Set(["data_release", "active_data_release"]);
// 只有普通表与分区表接受 INSERT；视图、物化视图与序列不进入 INSERT 预期。
const insertableRelationKinds = new Set(["r", "p"]);
const publisherFunctionNames = new Set([
  "create_data_release_candidate",
  "mark_data_release_validated",
  "mark_data_release_failed",
  "activate_data_release",
  "current_schema_version",
  "persist_evidence_snapshot",
]);
const appReaderFunctionNames = new Set([
  "current_schema_version",
  "persist_query_evidence_snapshot",
]);
const shaPattern = /^[0-9a-f]{40}$/u;
const databasePattern = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/u;
const endpointPattern = /^ep-[a-z0-9-]+$/u;
const maxCapturedOutput = 1_000_000;
const baselineLockKey = "logiplan-neon-baseline-v1";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertSupportedNodeVersion(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  assert(match !== null, `无法解析 Node.js 版本：${version}`);
  const [, major, minor] = match;
  assert(Number(major) === 24 && Number(minor) >= 15, "必须使用 Node.js >=24.15.0 且 <25");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requiredOption(value, name) {
  assert(value !== undefined && value.length > 0, `缺少参数：${name}`);
  return value;
}

export function parseArguments(argv) {
  const options = { write: false, timeoutMs: 300_000 };
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
    if (argument === "--write") {
      options.write = true;
      continue;
    }
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (argument === "--candidate-sha") options.candidateSha = requiredOption(value, argument);
    else if (argument === "--approved-sha") options.approvedSha = requiredOption(value, argument);
    else if (argument === "--tooling-sha") options.toolingSha = requiredOption(value, argument);
    else if (argument === "--expected-database")
      options.expectedDatabase = requiredOption(value, argument);
    else if (argument === "--report") options.reportPath = requiredOption(value, argument);
    else if (argument === "--timeout-seconds") {
      const seconds = Number.parseInt(requiredOption(value, argument), 10);
      assert(
        Number.isInteger(seconds) && seconds >= 10 && seconds <= 1_800,
        "超时必须为 10—1800 秒",
      );
      options.timeoutMs = seconds * 1_000;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
    index += 1;
  }
  if (options.help) return options;
  requiredOption(options.candidateSha, "--candidate-sha");
  requiredOption(options.approvedSha, "--approved-sha");
  requiredOption(options.expectedDatabase, "--expected-database");
  assert(shaPattern.test(options.candidateSha), "候选 SHA 必须是 40 位小写十六进制");
  assert(shaPattern.test(options.approvedSha), "批准 SHA 必须是 40 位小写十六进制");
  if (options.write) {
    requiredOption(options.toolingSha, "--tooling-sha");
    assert(shaPattern.test(options.toolingSha), "工具 SHA 必须是 40 位小写十六进制");
  } else if (options.toolingSha !== undefined) {
    assert(shaPattern.test(options.toolingSha), "工具 SHA 必须是 40 位小写十六进制");
  }
  assert(databasePattern.test(options.expectedDatabase), "预期数据库名称无效");
  return options;
}

export function validateTargetEnvironment(environment) {
  for (const [name, expected] of Object.entries(targetEnvironment)) {
    const actual = environment[name];
    assert(actual !== undefined && actual.length > 0, `缺少目标身份环境变量：${name}`);
    assert(safeEqual(actual, expected), `目标身份不匹配：${name}`);
  }
  const endpointId = environment.LOGIPLAN_NEON_ENDPOINT_ID;
  assert(
    endpointId !== undefined && endpointPattern.test(endpointId),
    "LOGIPLAN_NEON_ENDPOINT_ID 无效",
  );
  return endpointId;
}

export function validateCandidateShas(options) {
  assert(safeEqual(options.candidateSha, options.approvedSha), "候选 SHA 与显式批准 SHA 不一致");
  assert(safeEqual(options.candidateSha, target.candidateSha), "候选 SHA 不是冻结基线");
}

export function validateGitIdentity(options, branch, head) {
  assert(branch === target.candidateBranch, `当前分支必须是 ${target.candidateBranch}`);
  const expectedHead = options.write
    ? options.toolingSha
    : (options.toolingSha ?? options.candidateSha);
  assert(head === expectedHead, `当前 HEAD 与${options.write ? "工具" : "预期"} SHA 不一致`);
}

export function validateToolingApproval(options, environment) {
  if (!options.write) return;
  const approvedToolingSha = environment.LOGIPLAN_APPROVED_TOOLING_SHA;
  assert(approvedToolingSha, "--write 需要 LOGIPLAN_APPROVED_TOOLING_SHA");
  assert(shaPattern.test(approvedToolingSha), "批准工具 SHA 必须是 40 位小写十六进制");
  assert(safeEqual(options.toolingSha, approvedToolingSha), "工具 SHA 与独立批准工具 SHA 不一致");
}

function parsePostgresUrl(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} 不是有效 PostgreSQL URL`);
  }
  assert(["postgres:", "postgresql:"].includes(parsed.protocol), `${name} 协议必须是 PostgreSQL`);
  assert(parsed.password.length > 0, `${name} 缺少密码`);
  const neonHostnameRegion = target.region.replace(/^aws-/u, "");
  assert(
    parsed.hostname.endsWith(`.${neonHostnameRegion}.aws.neon.tech`),
    `${name} 不是目标 Neon 区域`,
  );
  assert(
    ["require", "verify-full"].includes(parsed.searchParams.get("sslmode")),
    `${name} 必须启用 SSL`,
  );
  return parsed;
}

function endpointFromHost(hostname) {
  return hostname.split(".")[0]?.replace(/-pooler$/u, "");
}

function assertSafeConnectionQuery(parsed, name) {
  const keys = [...parsed.searchParams.keys()];
  assert(
    keys.length === 1 && keys[0] === "sslmode",
    `${name} 只能包含 sslmode，禁止通过查询参数覆盖连接身份`,
  );
}

function roleHostFromAdmin(adminHostname, endpointId, pooled) {
  const directHostname = adminHostname.replace(/-pooler(?=\.)/u, "");
  assert(endpointFromHost(directHostname) === endpointId, "管理连接主机与目标 endpoint 不匹配");
  const suffix = directHostname.slice(`${endpointId}.`.length);
  assert(suffix.length > 0, "管理连接主机缺少 Neon 区域后缀");
  return pooled ? `${endpointId}-pooler.${suffix}` : directHostname;
}

function buildRoleUrl(admin, definition, password, expectedDatabase, endpointId) {
  assert(password.length > 0, `${definition.passwordEnv} 不能为空`);
  const roleUrl = new URL(admin.toString());
  const sslmode = admin.searchParams.get("sslmode");
  roleUrl.hostname = roleHostFromAdmin(admin.hostname, endpointId, definition.pooled);
  roleUrl.username = "";
  roleUrl.password = "";
  roleUrl.pathname = `/${expectedDatabase}`;
  roleUrl.search = "";
  roleUrl.searchParams.set("sslmode", sslmode);
  const serialized = roleUrl.toString();
  const schemeEnd = serialized.indexOf("//") + 2;
  const encodedRole = encodeURIComponent(definition.role);
  const encodedPassword = encodeURIComponent(password);
  return `${serialized.slice(0, schemeEnd)}${encodedRole}:${encodedPassword}@${serialized.slice(
    schemeEnd,
  )}`;
}

export function classifyRoleBootstrap(existingRoleNames) {
  const existing = new Set(existingRoleNames);
  const allPresent = managedRoleNames.every((role) => existing.has(role));
  assert(existing.size === 0 || allPresent, "三角色只存在一部分，拒绝非原子角色状态");
  return {
    allPresent,
    rolesToCreate: allPresent ? [] : [...managedRoleNames],
  };
}

function isConnectionException(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  return (
    code.startsWith("08") ||
    ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND"].includes(code) ||
    /connection (?:closed|lost|terminated)|socket hang up|connection reset/iu.test(
      String(error?.message ?? ""),
    )
  );
}

export function classifyBootstrapTransactionFailure(error, { commitSent, rollbackConfirmed }) {
  if (commitSent || isConnectionException(error) || !rollbackConfirmed) {
    return { writeOutcomeUnknown: true };
  }
  return { rollbackConfirmed: true };
}

export function validateAdminConnectionEnvironment(environment, expectedDatabase, endpointId) {
  const adminValue = environment.NEON_ADMIN_DATABASE_URL;
  assert(adminValue, "--write 需要环境变量 NEON_ADMIN_DATABASE_URL");
  const admin = parsePostgresUrl(adminValue, "NEON_ADMIN_DATABASE_URL");
  assertSafeConnectionQuery(admin, "NEON_ADMIN_DATABASE_URL");
  assert(!admin.hostname.includes("-pooler."), "管理连接必须使用直连端点");
  assert(
    endpointFromHost(admin.hostname) === endpointId,
    "管理连接端点与 LOGIPLAN_NEON_ENDPOINT_ID 不匹配",
  );
  assert(decodeURIComponent(admin.username).length > 0, "管理连接缺少角色名称");
  assert(decodeURIComponent(admin.username) === "neondb_owner", "管理连接必须使用 neondb_owner");
  assert(decodeURIComponent(admin.pathname.slice(1)) === expectedDatabase, "管理连接数据库不匹配");
  return { parsed: admin, raw: adminValue, secret: decodeURIComponent(admin.password) };
}

export function validateConnectionEnvironment(environment, expectedDatabase, endpointId) {
  const adminConnection = validateAdminConnectionEnvironment(
    environment,
    expectedDatabase,
    endpointId,
  );
  const { parsed: admin, raw: adminValue, secret: adminSecret } = adminConnection;

  const parsedRoles = roleConnections.map((definition) => {
    const password = environment[definition.passwordEnv];
    assert(password, `--write 需要环境变量 ${definition.passwordEnv}`);
    const raw = buildRoleUrl(admin, definition, password, expectedDatabase, endpointId);
    const parsed = parsePostgresUrl(raw, definition.env);
    assert(
      decodeURIComponent(parsed.username) === definition.role,
      `${definition.env} 必须使用角色 ${definition.role}`,
    );
    assert(
      parsed.hostname.includes("-pooler.") === definition.pooled,
      `${definition.env} 必须使用${definition.pooled ? "池化" : "直连"}端点`,
    );
    assert(endpointFromHost(parsed.hostname) === endpointId, `${definition.env} 端点身份不匹配`);
    assert(
      decodeURIComponent(parsed.pathname.slice(1)) === expectedDatabase,
      `${definition.env} 数据库不匹配`,
    );
    return { ...definition, parsed, raw, secret: password };
  });
  return {
    admin: { parsed: admin, raw: adminValue, secret: adminSecret },
    roles: parsedRoles,
  };
}

function redact(text, secrets) {
  let result = String(text)
    .replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/giu, "[REDACTED_DATABASE_URL]")
    .replace(/[a-z0-9-]+(?:-pooler)?\.[a-z0-9-]+\.aws\.neon\.tech/giu, "[REDACTED_DATABASE_HOST]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/gu, "[REDACTED_IP]");
  for (const secret of secrets.filter((value) => typeof value === "string" && value.length > 0)) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

// 进程树终止由 scripts/wait-for-server.mjs 提供；该模块同时被 Gate 1 编排加载，
// 已列入 executionClosurePaths，不再在本文件保留第二份实现。
export function createReport(options, context = {}) {
  const connections = context.connections;
  return {
    format_version: "1",
    status: context.status ?? "preflight_passed",
    mode: options.write ? "prepare" : "preflight",
    candidate_sha: options.candidateSha,
    approved_sha: options.approvedSha,
    tooling_sha: options.toolingSha,
    approved_tooling_sha: context.approvedToolingSha,
    tooling_head_sha: context.git?.head,
    tooling_branch: context.git?.branch,
    protected_candidate_assets_verified: context.git?.assetsClean,
    execution_closure_verified: context.git?.closureClean,
    target: {
      project_name: target.projectName,
      project_id: target.projectId,
      region: target.region,
      postgres_version: target.postgresVersion,
      branch_name: target.branchName,
      branch_id: target.branchId,
      endpoint_fingerprint: connections && fingerprint(connections.admin.parsed.hostname),
      database: options.expectedDatabase,
      roles: roleConnections.map(({ role }) => role),
    },
    target_identity_verification: {
      postgres_protocol_proves_project_and_branch: false,
      independent_neon_metadata_check_required: true,
      independently_verified_by_this_entry: false,
    },
    vercel: {
      team: target.vercelTeam,
      project: target.vercelProject,
      root: target.vercelRoot,
      framework: "Next.js",
      node: "24.x (>=24.15.0 <25)",
      region: target.vercelRegion,
      production_secret: "DATABASE_URL only (app_reader pooled)",
      preview_database: "production database forbidden",
      configured_or_deployed: false,
    },
    writes: options.write
      ? [
          "三角色全缺失时原子创建；已存在时只核验属性、成员关系、所有权与 ACL，不修改密码",
          "执行增量迁移并记录 public._schema_migrations",
          `导入或复核候选 ${target.releaseId}；本次不切换活动发布`,
          "权限探针全部位于回滚事务，不保留测试发布",
        ]
      : [],
    active_release_switch: false,
    release_status: context.databaseState?.releaseStatus,
    observed_active_release: context.databaseState?.observedActiveRelease,
    observed_database_state: context.databaseState,
    last_completed_stage: context.lastCompletedStage,
    failure_after_stage: context.failureAfterStage,
    write_outcome: context.writeOutcome,
    write_committed_observation_failed: context.writeCommittedObservationFailed === true,
    error: context.error,
  };
}

export function isUnknownWriteProcessExit({ writeOperation, spawned, timedOut, code, signal }) {
  if (!writeOperation || !spawned) return false;
  if (timedOut) return true;
  if (signal !== null && signal !== undefined) return true;
  if (code === null || code === undefined) return true;
  if (code === writeOutcomeUnknownExitCode) return true;
  return code !== 0 && code !== 1;
}

export async function runProcess(
  command,
  args,
  { environment = process.env, timeoutMs, secrets = [], writeOperation = false } = {},
) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: environment,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let spawned = false;
    child.once("spawn", () => {
      spawned = true;
    });
    let output = "";
    const append = (chunk) => {
      if (output.length < maxCapturedOutput)
        output += String(chunk).slice(0, maxCapturedOutput - output.length);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timedOut = false;
    let forceKillTimer;
    let hardStopTimer;
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (hardStopTimer) clearTimeout(hardStopTimer);
      callback(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        terminateProcessTree(child, "SIGKILL");
        hardStopTimer = setTimeout(() => {
          child.unref();
          const error = new Error(
            writeOperation
              ? `${command} 超时且进程终止状态不明；数据库写入结果未知，必须只读复核后再试`
              : `${command} 超时且进程终止状态不明`,
          );
          if (
            isUnknownWriteProcessExit({
              writeOperation,
              spawned,
              timedOut: true,
              code: null,
              signal: "SIGKILL",
            })
          ) {
            error.writeOutcomeUnknown = true;
          }
          settle(reject, error);
        }, 2_000);
      }, 2_000);
    }, timeoutMs);
    child.once("error", (error) => {
      if (
        isUnknownWriteProcessExit({ writeOperation, spawned, timedOut, code: null, signal: null })
      ) {
        error.writeOutcomeUnknown = true;
      }
      settle(reject, error);
    });
    child.once("exit", (code, signal) => {
      const safeOutput = redact(output, secrets);
      if (timedOut) {
        const error = new Error(
          writeOperation
            ? `${command} 超时，已终止直接数据库进程；数据库写入结果未知，必须只读复核后再试`
            : `${command} 超时，已终止子进程`,
        );
        if (isUnknownWriteProcessExit({ writeOperation, spawned, timedOut, code, signal })) {
          error.writeOutcomeUnknown = true;
        }
        settle(reject, error);
      } else if (code === 0) settle(resolvePromise, safeOutput.trim());
      else {
        const error = new Error(
          `${command} 失败（code=${String(code)}, signal=${String(signal)}）：${safeOutput.slice(-2_000)}`,
        );
        error.childExitCode = code;
        error.childSignal = signal ?? null;
        if (isUnknownWriteProcessExit({ writeOperation, spawned, timedOut, code, signal })) {
          error.writeOutcomeUnknown = true;
        } else if (safeOutput.includes(writeCommittedObservationFailedMarker)) {
          // 写入口自报“写入已提交、随后观察或清理失败”：写入结果已知且已提交，只是后续阶段失败。
          error.writeCommittedObservationFailed = true;
        }
        settle(reject, error);
      }
    });
  });
}

function validateWriteEnvironment(environment) {
  for (const name of [
    "MIGRATION_DIRECTORY",
    "RELEASE_MANIFEST",
    "LOGIPLAN_PUBLISH_MODE",
    "NODE_OPTIONS",
    "NODE_PATH",
  ]) {
    assert(!environment[name], `--write 禁止继承环境变量 ${name}`);
  }
}

function isolatedChildEnvironment(environment, databaseEnvironment) {
  const passthroughNames = [
    "PATH",
    "Path",
    "PATHEXT",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "windir",
    "COMSPEC",
    "ComSpec",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "LANG",
    "LC_ALL",
    "TZ",
  ];
  return {
    ...Object.fromEntries(
      passthroughNames.flatMap((name) =>
        environment[name] === undefined ? [] : [[name, environment[name]]],
      ),
    ),
    ...databaseEnvironment,
  };
}

async function defaultLocalConfigPreflight() {
  const [vercelConfig, rootPackage, webPackage] = await Promise.all([
    readFile(resolve("apps/web/vercel.json"), "utf8").then(JSON.parse),
    readFile(resolve("package.json"), "utf8").then(JSON.parse),
    readFile(resolve("apps/web/package.json"), "utf8").then(JSON.parse),
  ]);
  assert(
    Array.isArray(vercelConfig.regions) &&
      vercelConfig.regions.length === 1 &&
      vercelConfig.regions[0] === target.vercelRegion,
    `Vercel Function 区域必须唯一固定为 ${target.vercelRegion}`,
  );
  assert(rootPackage.engines?.node === ">=24.15.0 <25", "根 package.json 未冻结 Node.js 24.15+");
  assert(webPackage.dependencies?.next, "apps/web 不是可识别的 Next.js 项目");
}

export function isolatedGitEnvironment(environment) {
  const safeEnvironment = isolatedChildEnvironment(environment, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  });
  delete safeEnvironment.HOME;
  delete safeEnvironment.USERPROFILE;
  return safeEnvironment;
}

async function defaultGitPreflight(options, environment = process.env) {
  const gitEnvironment = isolatedGitEnvironment(environment);
  const git = async (args) =>
    (await runProcess("git", args, { environment: gitEnvironment, timeoutMs: 30_000 })).trim();
  const type = await git(["cat-file", "-t", options.candidateSha]);
  assert(type === "commit", "候选 SHA 不存在或不是 commit");
  if (options.toolingSha) {
    const toolingType = await git(["cat-file", "-t", options.toolingSha]);
    assert(toolingType === "commit", "工具 SHA 不存在或不是 commit");
  }
  const branch = await git(["branch", "--show-current"]);
  const head = await git(["rev-parse", "HEAD"]);
  validateGitIdentity(options, branch, head);
  const candidateStatus = await git([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ...protectedCandidatePaths,
  ]);
  const diffExitCode = async (revision, paths) =>
    new Promise((resolvePromise, reject) => {
      const child = spawn("git", ["diff", "--quiet", revision, "--", ...paths], {
        cwd: process.cwd(),
        env: gitEnvironment,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("exit", (code) => resolvePromise(code));
    });
  const candidateDiffExit = await diffExitCode(options.candidateSha, protectedCandidatePaths);
  assert(candidateDiffExit === 0 || candidateDiffExit === 1, "无法比较冻结候选资产");
  assert(
    candidateStatus.length === 0 && candidateDiffExit === 0,
    "候选迁移或数据包偏离冻结候选 SHA",
  );
  let closureClean;
  if (options.write) {
    const closureStatus = await git([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ...executionClosurePaths,
    ]);
    const closureDiffExit = await diffExitCode(options.toolingSha, executionClosurePaths);
    assert(closureDiffExit === 0 || closureDiffExit === 1, "无法比较执行闭包");
    assert(
      closureStatus.length === 0 && closureDiffExit === 0,
      "执行闭包存在未提交或偏离工具 SHA 的改动，拒绝数据库写入",
    );
    closureClean = true;
  }
  return { branch, head, assetsClean: true, closureClean };
}

async function connectWithRetry(connectionString, applicationName, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const client = new Client({
      connectionString,
      application_name: applicationName,
      connectionTimeoutMillis: 15_000,
      query_timeout: 30_000,
    });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      if (attempt < retries)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 500));
    }
  }
  throw lastError;
}

async function assertDatabaseIdentity(client, expectedRole, expectedDatabase) {
  const result = await client.query(`SELECT current_user, current_database(),
    current_setting('server_version') AS server_version,
    current_setting('server_version_num') AS server_version_num`);
  const row = result.rows[0];
  assert(row?.current_user === expectedRole, `数据库实际角色不是 ${expectedRole}`);
  assert(row?.current_database === expectedDatabase, "数据库实际名称不匹配");
  assert(
    String(row?.server_version_num) === "180006",
    `PostgreSQL 补丁版本不是 ${target.postgresVersion}（实际为 ${String(row?.server_version ?? "UNKNOWN")}）`,
  );
}

export function validateRoleMemberships(rows, { adminRole } = {}) {
  assert(Array.isArray(rows), "角色成员关系查询结果无效");
  assert(
    typeof adminRole === "string" && adminRole.length > 0 && !managedRoleNames.includes(adminRole),
    "角色成员关系缺少有效管理身份",
  );
  const managedRoles = new Set(managedRoleNames);
  const seen = new Set();
  for (const row of rows) {
    assert(row !== null && typeof row === "object", "角色成员关系记录无效");
    for (const field of ["parent_role", "member_role", "grantor_role"]) {
      assert(typeof row[field] === "string" && row[field].length > 0, `角色成员关系缺少 ${field}`);
    }
    for (const field of ["parent_oid", "member_oid", "grantor_oid"]) {
      assert(
        typeof row[field] === "number" && Number.isInteger(row[field]) && row[field] >= 0,
        `角色成员关系 ${field} 类型无效`,
      );
    }
    for (const field of ["grantor_is_superuser", "admin_option", "inherit_option", "set_option"]) {
      assert(typeof row[field] === "boolean", `角色成员关系 ${field} 类型无效`);
    }
    const relationKey = [row.parent_oid, row.member_oid, row.grantor_oid].join(":");
    assert(!seen.has(relationKey), "角色成员关系存在重复关系或额外授予者");
    seen.add(relationKey);
    assert(managedRoles.has(row.parent_role), "角色成员关系的 parent 不是基线角色");
    assert(!managedRoles.has(row.member_role), "角色成员关系不得把基线角色作为 member");
    assert(row.member_role === adminRole, "角色成员关系的 member 不是已验证管理身份");
    assert(
      row.admin_option === true && row.inherit_option === false && row.set_option === false,
      "角色成员关系选项偏离严格管理基线",
    );
    assert(
      row.grantor_oid === 10 && row.grantor_is_superuser === true,
      "角色成员关系授予者不是 OID 10 的超级用户",
    );
  }
}

export async function assertRoleDefinitions(admin, adminRole) {
  assert(!managedRoleNames.includes(adminRole), "管理连接不得使用基线运行角色");
  const roles = await admin.query(
    `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls,
            rolcanlogin, rolinherit, rolconnlimit,
            rolvaliduntil IS NULL AS no_expiry,
            COALESCE(cardinality(rolconfig), 0) AS config_count
     FROM pg_roles
     WHERE rolname = ANY($1::text[])`,
    [managedRoleNames],
  );
  assert(roles.rowCount === managedRoleNames.length, "三角色必须全部存在");
  for (const state of roles.rows) {
    validateRoleDefinition(state);
  }
  const memberships = await admin.query(roleMembershipSql, [managedRoleNames]);
  validateRoleMemberships(memberships.rows, { adminRole });
}

export function validateRoleDefinition(state) {
  const expected = expectedRoleProperties[state.rolname];
  assert(
    expected !== undefined &&
      state.rolsuper === false &&
      state.rolcreaterole === false &&
      state.rolcreatedb === false &&
      state.rolreplication === false &&
      state.rolbypassrls === false &&
      state.rolcanlogin === expected.canLogin &&
      state.rolinherit === expected.inherit &&
      state.rolconnlimit === expected.connectionLimit &&
      state.no_expiry === true &&
      Number(state.config_count) === 0,
    `角色 ${state.rolname} 的属性偏离冻结基线`,
  );
}

function privilegeKeys(rows) {
  return rows.map((row) => `${row.grantee}:${row.privilege_type}`).sort();
}

export function assertExactPrivileges(rows, expected, label) {
  const actual = privilegeKeys(rows);
  const required = [...expected].sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(required),
    `${label} ACL 偏离基线：实际 ${JSON.stringify(actual)}，预期 ${JSON.stringify(required)}`,
  );
}

export async function queryPrivilegeAclRows(admin) {
  const schemaAcl = await admin.query(
    `SELECT COALESCE(grantee.rolname, 'PUBLIC') AS grantee, acl.privilege_type
     FROM pg_namespace AS namespace
     CROSS JOIN LATERAL aclexplode(
       COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
     ) AS acl
     LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
     WHERE namespace.nspname = 'logiplan'
       AND (acl.grantee = 0 OR acl.grantee <> namespace.nspowner)`,
  );
  const relationAcl = await admin.query(
    `SELECT object.relname, object.relkind,
            COALESCE(grantee.rolname, 'PUBLIC') AS grantee, acl.privilege_type
     FROM pg_class AS object
     JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
     CROSS JOIN LATERAL aclexplode(
       COALESCE(object.relacl, acldefault((CASE WHEN object.relkind = 'S' THEN 's' ELSE 'r' END)::"char", object.relowner))
     ) AS acl
     LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
     WHERE namespace.nspname = 'logiplan'
       AND (acl.grantee = 0 OR acl.grantee <> object.relowner)`,
  );
  const functionAcl = await admin.query(
    `SELECT object.proname,
            COALESCE(grantee.rolname, 'PUBLIC') AS grantee, acl.privilege_type
     FROM pg_proc AS object
     JOIN pg_namespace AS namespace ON namespace.oid = object.pronamespace
     CROSS JOIN LATERAL aclexplode(
       COALESCE(object.proacl, acldefault('f', object.proowner))
     ) AS acl
     LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
     WHERE namespace.nspname = 'logiplan'
       AND (acl.grantee = 0 OR acl.grantee <> object.proowner)`,
  );
  const defaultAcl = await admin.query(
    `SELECT defaults.defaclobjtype,
            COALESCE(grantee.rolname, 'PUBLIC') AS grantee, acl.privilege_type
     FROM pg_default_acl AS defaults
     JOIN pg_roles AS owner ON owner.oid = defaults.defaclrole
     JOIN pg_namespace AS namespace ON namespace.oid = defaults.defaclnamespace
     CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS acl
     LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
     WHERE owner.rolname = 'schema_migrator'
       AND namespace.nspname = 'logiplan'`,
  );
  return {
    schemaAcl: schemaAcl.rows,
    relationAcl: relationAcl.rows,
    functionAcl: functionAcl.rows,
    defaultAcl: defaultAcl.rows,
  };
}

export async function assertRolePrivilegeBaseline(admin, adminRole) {
  await assertRoleDefinitions(admin, adminRole);
  const structural = await admin.query(`SELECT
    has_database_privilege('schema_migrator', current_database(), 'CREATE') AS migrator_db_create,
    has_database_privilege('data_publisher', current_database(), 'CREATE') AS publisher_db_create,
    has_database_privilege('app_reader', current_database(), 'CREATE') AS reader_db_create,
    has_database_privilege('data_publisher', current_database(), 'TEMPORARY') AS publisher_temp,
    has_database_privilege('app_reader', current_database(), 'TEMPORARY') AS reader_temp,
    has_schema_privilege('schema_migrator', 'public', 'CREATE') AS migrator_public_create,
    has_schema_privilege('data_publisher', 'public', 'CREATE') AS publisher_public_create,
    has_schema_privilege('app_reader', 'public', 'CREATE') AS reader_public_create`);
  const state = structural.rows[0];
  assert(
    state?.migrator_db_create === true &&
      state.migrator_public_create === true &&
      state.publisher_db_create === false &&
      state.reader_db_create === false &&
      state.publisher_temp === false &&
      state.reader_temp === false &&
      state.publisher_public_create === false &&
      state.reader_public_create === false,
    "目标三角色的数据库或 public schema 权限偏离基线",
  );
  const applicationSchema = await admin.query(`SELECT
    to_regnamespace('logiplan') IS NOT NULL AS schema_exists,
    has_schema_privilege('schema_migrator', 'logiplan', 'USAGE') AS migrator_usage,
    has_schema_privilege('schema_migrator', 'logiplan', 'CREATE') AS migrator_create,
    has_schema_privilege('data_publisher', 'logiplan', 'USAGE') AS publisher_usage,
    has_schema_privilege('data_publisher', 'logiplan', 'CREATE') AS publisher_create,
    has_schema_privilege('app_reader', 'logiplan', 'USAGE') AS reader_usage,
    has_schema_privilege('app_reader', 'logiplan', 'CREATE') AS reader_create`);
  const schemaState = applicationSchema.rows[0];
  assert(schemaState?.schema_exists === true, "logiplan schema 不存在");
  assert(
    schemaState.migrator_usage === true &&
      schemaState.migrator_create === true &&
      schemaState.publisher_usage === true &&
      schemaState.publisher_create === false &&
      schemaState.reader_usage === true &&
      schemaState.reader_create === false,
    "目标三角色的 logiplan schema 权限偏离基线",
  );
  const databaseOwner = await admin.query(
    `SELECT owner.rolname AS owner_name
     FROM pg_database AS database
     JOIN pg_roles AS owner ON owner.oid = database.datdba
     WHERE database.datname = current_database()`,
  );
  assert(databaseOwner.rows[0]?.owner_name === adminRole, "目标数据库所有者不是管理连接角色");
  const ownership = await admin.query(
    `SELECT 'schema' AS object_type, namespace.nspname AS object_name, owner.rolname AS owner_name
     FROM pg_namespace AS namespace
     JOIN pg_roles AS owner ON owner.oid = namespace.nspowner
     WHERE namespace.nspname = 'logiplan'
       AND owner.rolname <> 'schema_migrator'
     UNION ALL
     SELECT 'relation', namespace.nspname || '.' || object.relname, owner.rolname
     FROM pg_class AS object
     JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
     JOIN pg_roles AS owner ON owner.oid = object.relowner
     WHERE namespace.nspname = 'logiplan'
       AND owner.rolname <> 'schema_migrator'
     UNION ALL
     SELECT 'function', namespace.nspname || '.' || object.proname, owner.rolname
     FROM pg_proc AS object
     JOIN pg_namespace AS namespace ON namespace.oid = object.pronamespace
     JOIN pg_roles AS owner ON owner.oid = object.proowner
     WHERE namespace.nspname = 'logiplan'
       AND owner.rolname <> 'schema_migrator'`,
  );
  assert(ownership.rowCount === 0, "logiplan schema 或对象所有者偏离迁移基线");

  const acl = await queryPrivilegeAclRows(admin);
  assertExactPrivileges(
    acl.schemaAcl,
    ["data_publisher:USAGE", "app_reader:USAGE"],
    "logiplan schema",
  );

  const relations = new Map();
  for (const row of acl.relationAcl) {
    const entries = relations.get(row.relname) ?? [];
    entries.push(row);
    relations.set(row.relname, entries);
  }
  const expectedRelations = new Set([
    ...appReaderSelectRelations,
    ...publisherSelectRelations,
    "data_release",
    "active_data_release",
  ]);
  for (const relationName of expectedRelations) {
    assert(relations.has(relationName), `迁移基线对象不存在：logiplan.${relationName}`);
  }
  for (const [relationName, rows] of relations) {
    const relkind = rows[0]?.relkind;
    // 一个 relname 只允许一种关系类型；显式断言，避免后续默认类型判定依赖隐式前提。
    assert(
      rows.every((row) => row.relkind === relkind),
      `logiplan.${relationName} 的 ACL 行关系类型不一致`,
    );
    const expected = [];
    if (appReaderSelectRelations.has(relationName)) expected.push("app_reader:SELECT");
    if (
      publisherSelectRelations.has(relationName) ||
      publisherReadOnlyRelations.has(relationName)
    ) {
      expected.push("data_publisher:SELECT");
    }
    if (
      insertableRelationKinds.has(relkind) &&
      !publisherNoPrivilegeRelations.has(relationName) &&
      !publisherReadOnlyRelations.has(relationName)
    ) {
      expected.push("data_publisher:SELECT", "data_publisher:INSERT");
    }
    assertExactPrivileges(rows, expected, `logiplan.${relationName}`);
  }

  const functions = new Map();
  for (const row of acl.functionAcl) {
    const entries = functions.get(row.proname) ?? [];
    entries.push(row);
    functions.set(row.proname, entries);
  }
  for (const [functionName, rows] of functions) {
    const expected = [];
    if (publisherFunctionNames.has(functionName)) expected.push("data_publisher:EXECUTE");
    if (appReaderFunctionNames.has(functionName)) expected.push("app_reader:EXECUTE");
    assertExactPrivileges(rows, expected, `logiplan.${functionName}`);
  }
  for (const functionName of [...publisherFunctionNames, ...appReaderFunctionNames]) {
    assert(functions.has(functionName), `迁移基线函数不存在：logiplan.${functionName}`);
  }

  assertExactPrivileges(
    acl.defaultAcl.map((row) => ({
      grantee: `${row.defaclobjtype}:${row.grantee}`,
      privilege_type: row.privilege_type,
    })),
    ["r:data_publisher:SELECT"],
    "schema_migrator 默认权限",
  );
}

export async function executeRoleBootstrapTransaction(
  admin,
  connections,
  databaseName,
  rolePlan,
  adminRole,
) {
  if (rolePlan.allPresent) return;

  await admin.query("BEGIN");
  let commitSent = false;
  try {
    for (const connection of connections.roles.filter(({ role }) =>
      rolePlan.rolesToCreate.includes(role),
    )) {
      const password = connection.secret;
      const statement = await admin.query(
        `SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS sql`,
        [connection.role, password],
      );
      await admin.query(statement.rows[0].sql);
    }
    const verifiedAdminRole =
      adminRole ?? (await admin.query("SELECT current_user AS role")).rows[0]?.role;
    const memberships = await admin.query(roleMembershipSql, [managedRoleNames]);
    validateRoleMemberships(memberships.rows, { adminRole: verifiedAdminRole });
    await admin.query(`REVOKE TEMPORARY ON DATABASE ${databaseName} FROM PUBLIC`);
    await admin.query(
      `GRANT CONNECT ON DATABASE ${databaseName} TO schema_migrator, data_publisher, app_reader`,
    );
    await admin.query(`GRANT CREATE ON DATABASE ${databaseName} TO schema_migrator`);
    await admin.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await admin.query("GRANT USAGE, CREATE ON SCHEMA public TO schema_migrator");
    commitSent = true;
    await admin.query("COMMIT");
  } catch (error) {
    if (commitSent || isConnectionException(error)) {
      Object.assign(
        error,
        classifyBootstrapTransactionFailure(error, { commitSent, rollbackConfirmed: false }),
      );
      throw error;
    }
    let rollbackConfirmed = false;
    try {
      await admin.query("ROLLBACK");
      rollbackConfirmed = true;
    } catch {
      rollbackConfirmed = false;
    }
    Object.assign(
      error,
      classifyBootstrapTransactionFailure(error, { commitSent, rollbackConfirmed }),
    );
    throw error;
  }
}

async function bootstrapRoles(options, connections, adminRole) {
  const admin = await connectWithRetry(connections.admin.raw, "logiplan-neon-role-bootstrap");
  try {
    await assertDatabaseIdentity(admin, adminRole, options.expectedDatabase);
    const available = await admin.query(
      "SELECT 1 FROM pg_available_extensions WHERE name = 'btree_gist'",
    );
    assert(available.rowCount === 1, "Neon 不提供迁移所需的 btree_gist 扩展");
    const roleNames = roleConnections.map(({ role }) => role);
    const existingRoles = await admin.query(
      `SELECT rolname
       FROM pg_roles WHERE rolname = ANY($1::text[])`,
      [roleNames],
    );
    const rolePlan = classifyRoleBootstrap(existingRoles.rows.map(({ rolname }) => rolname));
    if (rolePlan.allPresent) {
      await assertRoleDefinitions(admin, adminRole);
      const schema = await admin.query("SELECT to_regnamespace('logiplan') IS NOT NULL AS exists");
      if (schema.rows[0]?.exists === true) await assertRolePrivilegeBaseline(admin, adminRole);
      await executeRoleBootstrapTransaction(admin, connections, undefined, rolePlan, adminRole);
      return;
    }

    const databaseIdentifier = await admin.query("SELECT format('%I', current_database()) AS name");
    const databaseName = databaseIdentifier.rows[0].name;
    await executeRoleBootstrapTransaction(admin, connections, databaseName, rolePlan, adminRole);
  } finally {
    await admin.end();
  }
}

async function defaultPrepareDatabase(options, environment, connections, onStage) {
  const adminRole = decodeURIComponent(connections.admin.parsed.username);
  const lockClient = await connectWithRetry(connections.admin.raw, "logiplan-neon-baseline-lock");
  try {
    await assertDatabaseIdentity(lockClient, adminRole, options.expectedDatabase);
    const lock = await lockClient.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [baselineLockKey],
    );
    assert(lock.rows[0]?.acquired === true, "另一个 Neon 基线任务正在执行，拒绝并发写入");
    onStage("baseline_lock_acquired");

    try {
      await bootstrapRoles(options, connections, adminRole);
    } catch (error) {
      if (error?.writeOutcomeUnknown) {
        error.observedState = await inspectDatabaseState(lockClient).catch(() => ({
          state_check: "failed",
        }));
      }
      throw error;
    }
    onStage("roles_bootstrapped");

    for (const connection of connections.roles) {
      const client = await connectWithRetry(
        connection.raw,
        `logiplan-neon-${connection.role}-probe`,
      );
      try {
        await assertDatabaseIdentity(client, connection.role, options.expectedDatabase);
      } finally {
        await client.end();
      }
    }
    onStage("identities_verified");

    const roleUrl = (role) => {
      const connection = connections.roles.find((candidate) => candidate.role === role);
      assert(connection, `缺少角色连接：${role}`);
      return connection.raw;
    };
    const secrets = [
      connections.admin.raw,
      connections.admin.secret,
      ...connections.roles.flatMap(({ raw, secret }) => [raw, secret]),
    ];
    const runDatabaseEntry = async (label, entry, databaseEnvironment) => {
      const output = await runProcess(process.execPath, ["--import", "tsx", entry], {
        environment: isolatedChildEnvironment(environment, databaseEnvironment),
        timeoutMs: options.timeoutMs,
        secrets,
        writeOperation: true,
      });
      if (output) process.stdout.write(`[Neon baseline] ${label}\n${output}\n`);
    };
    try {
      await runDatabaseEntry("执行增量迁移", "packages/db/src/migrate.ts", {
        MIGRATION_DATABASE_URL: roleUrl("schema_migrator"),
        MIGRATION_DIRECTORY: resolve("database/migrations"),
      });
      onStage("migrations_applied");
      await runDatabaseEntry("导入并校验候选（不激活）", "packages/db/src/publish-release.ts", {
        PUBLISHER_DATABASE_URL: roleUrl("data_publisher"),
        RELEASE_MANIFEST: resolve("database/releases/LOGIPLAN_2026_DEMO_V2.json"),
        LOGIPLAN_PUBLISH_MODE: "validate-only",
      });
      onStage("candidate_validated");
      await runDatabaseEntry("验证结构、精度与三角色权限", "packages/db/src/verify-schema.ts", {
        MIGRATION_DATABASE_URL: roleUrl("schema_migrator"),
        PUBLISHER_DATABASE_URL: roleUrl("data_publisher"),
        DATABASE_URL: roleUrl("app_reader"),
      });
      await assertRolePrivilegeBaseline(lockClient, adminRole);
      onStage("permissions_verified");
    } catch (error) {
      if (error?.writeOutcomeUnknown) {
        error.observedState = await inspectDatabaseState(lockClient).catch(() => ({
          state_check: "failed",
        }));
      }
      throw error;
    }

    const publisher = await connectWithRetry(
      roleUrl("data_publisher"),
      "logiplan-neon-final-state-verifier",
    );
    try {
      const state = await publisher.query(
        `SELECT r.status,
           (SELECT data_release_id FROM logiplan.active_data_release WHERE singleton) AS active_release
         FROM logiplan.data_release AS r
         WHERE r.data_release_id = $1`,
        [target.releaseId],
      );
      assert(
        ["VALIDATED", "ACTIVE", "RETIRED"].includes(state.rows[0]?.status),
        "候选发布未完成校验",
      );
      return {
        releaseStatus: state.rows[0].status,
        observedActiveRelease: state.rows[0].active_release ?? null,
      };
    } finally {
      await publisher.end();
    }
  } finally {
    await lockClient
      .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [baselineLockKey])
      .catch(() => undefined);
    await lockClient.end();
  }
}

async function inspectDatabaseState(client) {
  const existence = await client.query(`SELECT
    to_regclass('public._schema_migrations') IS NOT NULL AS migrations,
    to_regclass('logiplan.data_release') IS NOT NULL AS releases,
    to_regclass('logiplan.active_data_release') IS NOT NULL AS active_release`);
  const state = { state_check: "completed_read_only" };
  if (existence.rows[0]?.migrations) {
    state.latest_migration = (
      await client.query("SELECT max(version) AS version FROM public._schema_migrations")
    ).rows[0]?.version;
  }
  if (existence.rows[0]?.releases) {
    state.release_status = (
      await client.query("SELECT status FROM logiplan.data_release WHERE data_release_id = $1", [
        target.releaseId,
      ])
    ).rows[0]?.status;
  }
  if (existence.rows[0]?.active_release) {
    state.active_release = (
      await client.query("SELECT data_release_id FROM logiplan.active_data_release WHERE singleton")
    ).rows[0]?.data_release_id;
  }
  return state;
}

// 报告路径必须在任何本地预检副作用、远程连接或写入之前独占预留。路径被占用时立即以
// 已知失败结束，不执行任何数据库操作；随后的写入只针对已预留的文件，因此不再使用 wx。
async function reserveReportPath(path) {
  if (!path) return;
  const handle = await open(resolve(path), "wx", 0o600);
  await handle.close();
}

async function persistReport(path, report) {
  if (!path) return;
  await writeFile(resolve(path), `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function runBaseline(options, environment = process.env, dependencies = {}) {
  const localConfigPreflight = dependencies.localConfigPreflight ?? defaultLocalConfigPreflight;
  const gitPreflight = dependencies.gitPreflight ?? defaultGitPreflight;
  const prepareDatabase = dependencies.prepareDatabase ?? defaultPrepareDatabase;
  const saveReport = dependencies.persistReport ?? persistReport;
  const reserveReport = dependencies.reserveReport ?? reserveReportPath;
  // 只有自己成功预留了报告路径才允许写入，避免覆盖他人已存在的报告文件。
  let reportPathOwned = options.reportPath === undefined;
  let stage = "arguments_validated";
  let git;
  let connections;
  let databaseState;
  try {
    assertSupportedNodeVersion();
    validateCandidateShas(options);
    stage = "candidate_approval_validated";
    await reserveReport(options.reportPath);
    reportPathOwned = true;
    validateToolingApproval(options, environment);
    if (options.write) validateWriteEnvironment(environment);
    stage = "tooling_approval_validated";
    validateTargetEnvironment(environment);
    stage = "target_validated";
    await localConfigPreflight();
    stage = "local_config_validated";
    git = await gitPreflight(options, environment);
    stage = "git_validated";
    if (options.write) {
      connections = validateConnectionEnvironment(
        environment,
        options.expectedDatabase,
        environment.LOGIPLAN_NEON_ENDPOINT_ID,
      );
      stage = "connections_validated";
      databaseState = await prepareDatabase(options, environment, connections, (completed) => {
        stage = completed;
      });
    }
    const report = createReport(options, {
      status: options.write ? "prepared" : "preflight_passed",
      git,
      connections,
      databaseState,
      approvedToolingSha: environment.LOGIPLAN_APPROVED_TOOLING_SHA,
      lastCompletedStage: stage,
      writeOutcome: options.write ? "known" : "not_applicable",
    });
    await saveReport(options.reportPath, report);
    return report;
  } catch (error) {
    const secrets = options.write
      ? [
          environment.NEON_ADMIN_DATABASE_URL,
          ...roleConnections.map(({ passwordEnv }) => environment[passwordEnv]),
          connections?.admin?.secret,
          ...(connections?.roles ?? []).flatMap(({ raw, secret }) => [raw, secret]),
        ]
      : [];
    const safeMessage = redact(error instanceof Error ? error.message : "未知错误", secrets);
    const outcomeUnknown = Boolean(error?.writeOutcomeUnknown);
    const committedObservationFailed =
      !outcomeUnknown && Boolean(error?.writeCommittedObservationFailed);
    databaseState = error?.observedState ?? databaseState;
    const report = createReport(options, {
      status: outcomeUnknown ? "unknown" : "failed",
      git,
      connections,
      databaseState,
      approvedToolingSha: environment.LOGIPLAN_APPROVED_TOOLING_SHA,
      lastCompletedStage: stage,
      failureAfterStage: stage,
      writeOutcome: outcomeUnknown
        ? "unknown_requires_read_only_review"
        : committedObservationFailed
          ? committedObservationFailedWriteOutcome
          : error?.rollbackConfirmed
            ? "confirmed_rollback"
            : "known_failed",
      writeCommittedObservationFailed: committedObservationFailed,
      error: safeMessage,
    });
    const safeError = new Error(safeMessage);
    if (outcomeUnknown) safeError.writeOutcomeUnknown = true;
    if (committedObservationFailed) safeError.writeCommittedObservationFailed = true;
    if (reportPathOwned) {
      try {
        await saveReport(options.reportPath, report);
      } catch (reportError) {
        const reportMessage =
          reportError instanceof Error ? reportError.message : "未知报告写入错误";
        safeError.message = `${safeError.message}（报告写入失败：${reportMessage}）`;
        Object.assign(safeError, { reportWriteFailure: reportMessage });
      }
    }
    throw safeError;
  }
}

function usage() {
  return `用法：pnpm neon:baseline -- --candidate-sha <40位SHA> --approved-sha <40位SHA> --expected-database <数据库> [--tooling-sha <40位SHA> --write] [--report <新文件>] [--timeout-seconds 300]\n\n默认仅预检，不读取凭据、不连接或写入 Neon。--write 还要求 LOGIPLAN_APPROVED_TOOLING_SHA 精确批准已提交且无漂移的执行闭包；创建或核验三角色、执行迁移并把 V2 候选停在 VALIDATED，不激活发布，不配置或部署 Vercel。admin 连接串和角色密码只能通过环境变量传入。\n`;
}

export function exitCodeForBaselineError(error) {
  return error?.writeOutcomeUnknown === true ? writeOutcomeUnknownExitCode : 1;
}

export async function runCli(
  argv = process.argv.slice(2),
  {
    runBaseline: baselineRunner = runBaseline,
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      stdout.write(usage());
      return 0;
    }
    const report = await baselineRunner(options);
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`Neon 基线执行失败：${error instanceof Error ? error.message : "未知错误"}\n`);
    return exitCodeForBaselineError(error);
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  process.exitCode = await runCli();
}
