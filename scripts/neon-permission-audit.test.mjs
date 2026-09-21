import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import process from "node:process";

import {
  executeAuditCli,
  parseAuditArguments,
  formatAuditError,
  runReadOnlyAudit,
  validateAuditEnvironment,
} from "./neon-permission-audit.mjs";

const auditScriptPath = fileURLToPath(new URL("./neon-permission-audit.mjs", import.meta.url));

async function assertNoDirectoryChanges(run) {
  const directory = await mkdtemp(join(tmpdir(), "logiplan-neon-audit-test-"));
  const originalDirectory = process.cwd();
  process.chdir(directory);
  const before = await readdir(directory);
  try {
    return await run(directory);
  } finally {
    const after = await readdir(directory);
    assert.deepEqual(after.sort(), before.sort());
    process.chdir(originalDirectory);
    await rm(directory, { recursive: true, force: true });
  }
}

function targetEnvironment() {
  return {
    LOGIPLAN_NEON_PROJECT_NAME: "logiplan-public-test",
    LOGIPLAN_NEON_PROJECT_ID: "mute-mouse-49732061",
    LOGIPLAN_NEON_REGION: "aws-ap-southeast-1",
    LOGIPLAN_NEON_BRANCH_NAME: "main",
    LOGIPLAN_NEON_BRANCH_ID: "br-patient-smoke-b3f5jtui",
    LOGIPLAN_NEON_POSTGRES_VERSION: "18.6",
    LOGIPLAN_NEON_ENDPOINT_ID: "ep-empty-shape-b35qu1jv",
    NEON_ADMIN_DATABASE_URL:
      "postgresql://neondb_owner:diagnostic-secret@ep-empty-shape-b35qu1jv.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
  };
}

class ReadOnlyClient {
  queries = [];

  constructor({ identity, state } = {}) {
    this.identity = identity ?? {
      current_user: "neondb_owner",
      session_user: "neondb_owner",
      current_database: "neondb",
      server_version_num: "180006",
      server_version: "18.6",
      createrole_self_grant: "",
    };
    this.state = state ?? {
      migrationsObjectExists: false,
      releaseObjectExists: false,
      activeReleaseObjectExists: false,
    };
  }

  async query(text, values) {
    this.queries.push({ text, values });
    if (text === "BEGIN READ ONLY" || text.startsWith("SET LOCAL statement_timeout")) {
      return { rows: [] };
    }
    if (text === "ROLLBACK") return { rows: [] };
    if (text.includes("current_user")) {
      return { rows: [this.identity] };
    }
    if (text.includes("FROM pg_roles")) return { rows: [] };
    if (text.includes("FROM pg_auth_members")) return { rows: [] };
    if (text.includes("has_database_privilege")) return { rows: [] };
    if (text.includes("has_schema_privilege")) return { rows: [] };
    if (text.includes("to_regnamespace")) return { rows: [{ exists: false }] };
    if (text.includes("to_regclass('public._schema_migrations')")) {
      return { rows: [{ exists: this.state.migrationsObjectExists }] };
    }
    if (text.includes("to_regclass('logiplan.data_release')")) {
      return { rows: [{ exists: this.state.releaseObjectExists }] };
    }
    if (text.includes("to_regclass('logiplan.active_data_release')")) {
      return { rows: [{ exists: this.state.activeReleaseObjectExists }] };
    }
    if (text.includes("FROM public._schema_migrations")) {
      return { rows: this.state.migrationRows ?? [] };
    }
    if (text.includes("FROM logiplan.data_release")) {
      return { rows: this.state.releaseRows ?? [] };
    }
    if (text.includes("FROM logiplan.active_data_release")) {
      return { rows: this.state.activeReleaseRows ?? [] };
    }
    throw new Error(`未预期诊断查询：${text}`);
  }
}

test("只读诊断帮助和参数不读取连接串", () => {
  assert.equal(parseAuditArguments(["--help"]).help, true);
  assert.throws(
    () => parseAuditArguments(["--expected-database", "postgresql://user:secret@host/db"]),
    /连接串和密码只能通过环境变量/u,
  );
  assert.throws(() => parseAuditArguments([]), /--expected-database/u);
  assert.throws(
    () => parseAuditArguments(["--report", "legacy-report.json"]),
    /不再支持 --report/u,
  );
});

test("成功 CLI 只输出一个 JSON 对象和换行，不包含报告路径", async () => {
  const report = {
    status: "read_only_audit_completed",
    target: { database: "neondb" },
    transaction: { mode: "READ ONLY", rollback: "confirmed" },
  };
  const output = await executeAuditCli(
    ["--expected-database", "neondb"],
    targetEnvironment(),
    async (options, environment) => {
      assert.equal(options.expectedDatabase, "neondb");
      assert.equal(
        environment.NEON_ADMIN_DATABASE_URL,
        targetEnvironment().NEON_ADMIN_DATABASE_URL,
      );
      return report;
    },
  );
  assert.equal(output, `${JSON.stringify(report)}\n`);
  assert.deepEqual(JSON.parse(output), report);
  assert(!Object.hasOwn(JSON.parse(output), "report_path"));
  assert.equal(output.endsWith("\n"), true);
  assert.equal(output.slice(0, -1).includes("\n"), false);
  const source = await readFile(auditScriptPath, "utf8");
  assert.doesNotMatch(source, /mkdtemp|writeFile|persistAuditReport|report_path/u);
});

test("帮助、--report 失败和成功注入入口均不产生文件副作用", async () => {
  await assertNoDirectoryChanges(async (directory) => {
    const help = spawnSync(process.execPath, [auditScriptPath, "--help"], {
      cwd: directory,
      encoding: "utf8",
      env: {},
    });
    assert.equal(help.status, 0);
    assert.equal(JSON.parse(help.stdout).status, "help");

    const rejectedReport = spawnSync(
      process.execPath,
      [auditScriptPath, "--expected-database", "neondb", "--report", "legacy-report.json"],
      { cwd: directory, encoding: "utf8", env: {} },
    );
    assert.equal(rejectedReport.status, 1);
    assert.match(rejectedReport.stderr, /不再支持 --report/u);

    const output = await executeAuditCli(
      ["--expected-database", "neondb"],
      targetEnvironment(),
      async () => ({ status: "read_only_audit_completed", transaction: { rollback: "confirmed" } }),
    );
    assert.deepEqual(JSON.parse(output), {
      status: "read_only_audit_completed",
      transaction: { rollback: "confirmed" },
    });
  });
});

test("帮助、旧参数、缺参和非法目标均在数据库连接前结束", () => {
  const help = spawnSync(process.execPath, [auditScriptPath, "--help"], {
    encoding: "utf8",
    env: {},
  });
  assert.equal(help.status, 0);
  assert.equal(help.stderr, "");
  const helpOutput = JSON.parse(help.stdout);
  assert.equal(helpOutput.status, "help");
  assert.match(helpOutput.usage, /只输出脱敏 JSON/u);
  assert.equal(help.stdout.endsWith("\n"), true);

  const cases = [
    [["--report", "legacy-report.json"], {}, /不再支持 --report/u],
    [["--expected-database"], {}, /缺少参数值/u],
    [
      ["--expected-database", "neondb"],
      { ...targetEnvironment(), LOGIPLAN_NEON_BRANCH_ID: "wrong-branch" },
      /目标身份不匹配/u,
    ],
  ];
  for (const [argv, environment, message] of cases) {
    const result = spawnSync(process.execPath, [auditScriptPath, ...argv], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(result.status, 1, argv.join(" "));
    assert.equal(result.stdout, "", argv.join(" "));
    assert.match(result.stderr, message, argv.join(" "));
    assert.doesNotMatch(result.stderr, /audit|diagnostic-secret|postgresql:\/\//iu, argv.join(" "));
  }
});

test("只读诊断在连接前严格核对目标和管理连接", () => {
  const environment = targetEnvironment();
  assert.equal(
    validateAuditEnvironment(environment, "neondb").endpointId,
    "ep-empty-shape-b35qu1jv",
  );
  const invalid = { ...environment, LOGIPLAN_NEON_BRANCH_ID: "wrong-branch" };
  assert.throws(() => validateAuditEnvironment(invalid, "neondb"), /目标身份不匹配/u);
});

test("诊断查询只使用 READ ONLY 事务并始终回滚", async () => {
  const client = new ReadOnlyClient();
  const report = await runReadOnlyAudit(client, "neondb_owner", "neondb", 5_000);
  assert.equal(report.status, "read_only_audit_completed");
  assert.equal(report.transaction.rollback, "confirmed");
  assert.equal(report.identity.server_version_num, "180006");
  assert.equal(report.target.expected_database, "neondb");
  const sql = client.queries.map(({ text }) => text).join("\n");
  assert.match(sql, /BEGIN READ ONLY/u);
  assert.match(sql, /ROLLBACK/u);
  assert.doesNotMatch(
    sql,
    /(?:^|\n)\s*(?:CREATE|GRANT|REVOKE|ALTER|SET ROLE|INSERT|UPDATE|DELETE|TRUNCATE)\b/u,
  );
  assert(!JSON.stringify(report).includes("diagnostic-secret"));
});

test("连接串、独立原始密码和 percent-encoded 密码均不会出现在错误输出", () => {
  const rawUrl =
    "postgresql://neondb_owner:audit+secret@ep-empty-shape-b35qu1jv.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";
  const message = `connect failed password=audit+secret encoded=audit%2Bsecret url=${rawUrl}`;
  const redacted = formatAuditError(new Error(message), { NEON_ADMIN_DATABASE_URL: rawUrl });
  assert(!redacted.includes(rawUrl));
  assert(!redacted.includes("audit+secret"));
  assert(!redacted.includes("audit%2Bsecret"));
  assert.match(redacted, /\[REDACTED\]/u);
});

test("实连身份、数据库和 PostgreSQL 18.6 版本漂移均失败并回滚", async () => {
  const cases = [
    ["current_user", "wrong_role", /实际角色/u],
    ["session_user", "wrong_session", /会话角色/u],
    ["current_database", "wrong_database", /实际名称/u],
    ["server_version_num", "180005", /补丁版本/u],
  ];
  for (const [field, value, message] of cases) {
    const identity = new ReadOnlyClient().identity;
    const client = new ReadOnlyClient({
      identity: { ...identity, [field]: value },
    });
    await assert.rejects(runReadOnlyAudit(client, "neondb_owner", "neondb", 5_000), message, field);
    assert.equal(client.queries.at(-1).text, "ROLLBACK", field);
  }
});

test("阶段二对象存在时读取迁移和 V2 数据包校验和", async () => {
  const client = new ReadOnlyClient({
    state: {
      migrationsObjectExists: true,
      releaseObjectExists: true,
      activeReleaseObjectExists: true,
      migrationRows: [
        { version: "0001", checksum_sha256: "a".repeat(64) },
        { version: "0003", checksum_sha256: "b".repeat(64) },
      ],
      releaseRows: [{ status: "VALIDATED", input_checksum_sha256: "c".repeat(64) }],
      activeReleaseRows: [{ data_release_id: "LOGIPLAN_2026_DEMO_V2" }],
    },
  });
  const report = await runReadOnlyAudit(client, "neondb_owner", "neondb", 5_000);
  assert.equal(report.database_state.latest_migration, "0003");
  assert.equal(report.database_state.latest_migration_checksum_sha256, "b".repeat(64));
  assert.deepEqual(report.database_state.migration_checksums, [
    { version: "0001", checksum_sha256: "a".repeat(64) },
    { version: "0003", checksum_sha256: "b".repeat(64) },
  ]);
  assert.equal(report.database_state.v2_data_package_checksum_sha256, "c".repeat(64));
  assert.match(
    client.queries.map(({ text }) => text).join("\n"),
    /checksum_sha256[\s\S]*FROM public\._schema_migrations/u,
  );
});

test("阶段二对象或目标记录缺失时标记未知且不查询不存在对象", async () => {
  const client = new ReadOnlyClient({
    state: {
      migrationsObjectExists: true,
      releaseObjectExists: true,
      activeReleaseObjectExists: false,
      migrationRows: [],
      releaseRows: [],
    },
  });
  const report = await runReadOnlyAudit(client, "neondb_owner", "neondb", 5_000);
  assert.equal(report.database_state.latest_migration_checksum_sha256, null);
  assert.equal(report.database_state.v2_data_package_checksum_sha256, null);

  const missingClient = new ReadOnlyClient();
  const missingReport = await runReadOnlyAudit(missingClient, "neondb_owner", "neondb", 5_000);
  assert.equal(missingReport.database_state.latest_migration, null);
  assert.equal(missingReport.database_state.migration_checksums, null);
  assert.equal(missingReport.database_state.v2_data_package_checksum_sha256, null);
  const sql = missingClient.queries.map(({ text }) => text).join("\n");
  assert.doesNotMatch(sql, /SELECT version, checksum_sha256/u);
  assert.doesNotMatch(sql, /SELECT status, input_checksum_sha256/u);
});
