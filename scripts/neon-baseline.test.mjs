import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createReport,
  executionClosurePaths,
  assertExactPrivileges,
  assertSupportedNodeVersion,
  isolatedGitEnvironment,
  parseArguments,
  runProcess,
  runBaseline,
  target,
  validateConnectionEnvironment,
  validateGitIdentity,
  validateCandidateShas,
  validateRoleDefinition,
  validateTargetEnvironment,
  validateToolingApproval,
} from "./neon-baseline.mjs";

const options = Object.freeze({
  write: true,
  timeoutMs: 30_000,
  candidateSha: target.candidateSha,
  approvedSha: target.candidateSha,
  toolingSha: target.candidateSha,
  expectedDatabase: "logiplan",
});

function validEnvironment() {
  const directHost = "ep-baseline.ap-southeast-1.aws.neon.tech";
  const pooledHost = "ep-baseline-pooler.ap-southeast-1.aws.neon.tech";
  return {
    LOGIPLAN_NEON_PROJECT_NAME: target.projectName,
    LOGIPLAN_NEON_PROJECT_ID: target.projectId,
    LOGIPLAN_NEON_REGION: target.region,
    LOGIPLAN_NEON_BRANCH_NAME: target.branchName,
    LOGIPLAN_NEON_BRANCH_ID: target.branchId,
    LOGIPLAN_NEON_POSTGRES_VERSION: target.postgresVersion,
    LOGIPLAN_NEON_ENDPOINT_ID: "ep-baseline",
    LOGIPLAN_APPROVED_TOOLING_SHA: target.candidateSha,
    NEON_ADMIN_DATABASE_URL: `postgresql://neondb_owner:admin-secret@${directHost}/logiplan?sslmode=require`,
    MIGRATION_DATABASE_URL: `postgresql://schema_migrator:migration-secret@${directHost}/logiplan?sslmode=require`,
    PUBLISHER_DATABASE_URL: `postgresql://data_publisher:publisher-secret@${directHost}/logiplan?sslmode=require`,
    DATABASE_URL: `postgresql://app_reader:reader-secret@${pooledHost}/logiplan?sslmode=require`,
  };
}

function dependencies(prepareDatabase) {
  return {
    localConfigPreflight: async () => undefined,
    gitPreflight: async () => ({
      branch: target.candidateBranch,
      head: options.toolingSha,
      assetsClean: true,
      closureClean: true,
    }),
    prepareDatabase,
    persistReport: async () => undefined,
  };
}

test("默认参数不允许把连接串放入命令行", () => {
  assert.throws(
    () =>
      parseArguments([
        "--candidate-sha",
        target.candidateSha,
        "--approved-sha",
        target.candidateSha,
        "--expected-database",
        "postgresql://role:secret@example.test/db",
      ]),
    /连接串只能通过环境变量/u,
  );
});

test("目标元数据任一字段错误时失败关闭", () => {
  const environment = validEnvironment();
  environment.LOGIPLAN_NEON_PROJECT_ID = "wrong-project";
  assert.throws(() => validateTargetEnvironment(environment), /目标身份不匹配/u);
});

test("候选 SHA 必须与显式批准和冻结基线同时一致", () => {
  assert.throws(
    () => validateCandidateShas({ ...options, approvedSha: "0".repeat(40) }),
    /候选 SHA 与显式批准 SHA 不一致/u,
  );
  assert.throws(
    () =>
      validateCandidateShas({
        ...options,
        candidateSha: "1".repeat(40),
        approvedSha: "1".repeat(40),
      }),
    /候选 SHA 不是冻结基线/u,
  );
});

test("写入模式必须同时固定并独立批准工具 SHA", () => {
  assert.throws(
    () =>
      parseArguments([
        "--candidate-sha",
        target.candidateSha,
        "--approved-sha",
        target.candidateSha,
        "--expected-database",
        "logiplan",
        "--write",
      ]),
    /--tooling-sha/u,
  );
  assert.throws(
    () => validateToolingApproval(options, { LOGIPLAN_APPROVED_TOOLING_SHA: "0".repeat(40) }),
    /工具 SHA 与独立批准工具 SHA 不一致/u,
  );
});

test("当前分支和 HEAD 必须精确绑定工具闭包", () => {
  assert.throws(() => validateGitIdentity(options, "main", target.candidateSha), /当前分支必须是/u);
  assert.throws(
    () => validateGitIdentity(options, target.candidateBranch, "0".repeat(40)),
    /当前 HEAD 与工具 SHA 不一致/u,
  );
});

test("执行闭包必须包含隔离 Gate1 编排脚本", () => {
  assert(executionClosurePaths.includes("scripts/verify-gate1-isolated.mjs"));
});

test("Git 子进程不继承仓库或配置覆盖变量", () => {
  const environment = validEnvironment();
  Object.assign(environment, {
    GIT_DIR: "/tmp/attacker-repository",
    GIT_WORK_TREE: "/tmp/attacker-worktree",
    GIT_INDEX_FILE: "/tmp/attacker-index",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/tmp/attacker-hooks",
    HOME: "/tmp/attacker-home",
  });
  const isolated = isolatedGitEnvironment(environment);
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "HOME",
    "USERPROFILE",
  ]) {
    assert.equal(isolated[name], undefined, name);
  }
  assert.equal(isolated.GIT_CONFIG_NOSYSTEM, "1");
});

test("Node 版本必须满足冻结的 24.15.0 下限", () => {
  assertSupportedNodeVersion("24.15.0");
  assertSupportedNodeVersion("24.16.1");
  assert.throws(() => assertSupportedNodeVersion("24.14.9"), /24\.15\.0/u);
  assert.throws(() => assertSupportedNodeVersion("25.0.0"), /24\.15\.0/u);
});

test("角色属性和 ACL 必须是迁移定义的精确基线", () => {
  const role = {
    rolname: "app_reader",
    rolsuper: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolreplication: false,
    rolbypassrls: false,
    rolcanlogin: true,
    rolinherit: true,
    rolconnlimit: -1,
    no_expiry: true,
    config_count: 0,
  };
  validateRoleDefinition(role);
  assert.throws(() => validateRoleDefinition({ ...role, rolcanlogin: false }), /属性偏离冻结基线/u);
  assertExactPrivileges(
    [{ grantee: "app_reader", privilege_type: "SELECT" }],
    ["app_reader:SELECT"],
    "test",
  );
  assert.throws(
    () =>
      assertExactPrivileges(
        [
          { grantee: "app_reader", privilege_type: "SELECT" },
          { grantee: "reporting_reader", privilege_type: "SELECT" },
        ],
        ["app_reader:SELECT"],
        "test",
      ),
    /ACL 偏离基线/u,
  );
});

test("管理和发布必须直连，运行角色必须池化", () => {
  const environment = validEnvironment();
  environment.DATABASE_URL = environment.DATABASE_URL.replace("-pooler", "");
  assert.throws(
    () => validateConnectionEnvironment(environment, "logiplan", "ep-baseline"),
    /DATABASE_URL 必须使用池化端点/u,
  );
});

test("默认预检不读取连接串且不执行数据库写入", async () => {
  const environment = validEnvironment();
  for (const name of [
    "NEON_ADMIN_DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "PUBLISHER_DATABASE_URL",
    "DATABASE_URL",
  ]) {
    delete environment[name];
  }
  let writes = 0;
  const report = await runBaseline(
    { ...options, write: false },
    environment,
    dependencies(async () => {
      writes += 1;
    }),
  );
  assert.equal(writes, 0);
  assert.equal(report.status, "preflight_passed");
  assert.equal(report.active_release_switch, false);
  assert.deepEqual(report.writes, []);
  assert.equal(report.target_identity_verification.independently_verified_by_this_entry, false);
});

test("写入模式拒绝继承可改写迁移、发布或 Node 加载行为的环境变量", async () => {
  const environment = validEnvironment();
  environment.MIGRATION_DIRECTORY = "/tmp/unauthorized";
  let prepared = false;
  await assert.rejects(
    runBaseline(
      options,
      environment,
      dependencies(async () => {
        prepared = true;
      }),
    ),
    /禁止继承环境变量 MIGRATION_DIRECTORY/u,
  );
  assert.equal(prepared, false);
});

test("首次初始化按角色、迁移、候选校验、权限验证顺序完成", async () => {
  const stages = [];
  const report = await runBaseline(
    options,
    validEnvironment(),
    dependencies(async (_options, _environment, _connections, complete) => {
      for (const stage of [
        "baseline_lock_acquired",
        "roles_bootstrapped",
        "identities_verified",
        "migrations_applied",
        "candidate_validated",
        "permissions_verified",
      ]) {
        stages.push(stage);
        complete(stage);
      }
      return { releaseStatus: "VALIDATED", observedActiveRelease: "LOGIPLAN_2026_DEMO_V1" };
    }),
  );
  assert.equal(report.status, "prepared");
  assert.equal(report.last_completed_stage, "permissions_verified");
  assert.equal(report.active_release_switch, false);
  assert.equal(report.release_status, "VALIDATED");
  assert.equal(report.observed_active_release, "LOGIPLAN_2026_DEMO_V1");
  assert.deepEqual(stages, [
    "baseline_lock_acquired",
    "roles_bootstrapped",
    "identities_verified",
    "migrations_applied",
    "candidate_validated",
    "permissions_verified",
  ]);
});

test("重复执行保持相同编排且不隐式切换活动发布", async () => {
  let runs = 0;
  const prepare = async (_options, _environment, _connections, complete) => {
    runs += 1;
    complete("permissions_verified");
  };
  const deps = dependencies(prepare);
  const first = await runBaseline(options, validEnvironment(), deps);
  const second = await runBaseline(options, validEnvironment(), deps);
  assert.equal(runs, 2);
  assert.equal(first.active_release_switch, false);
  assert.equal(second.active_release_switch, false);
});

test("迁移异常会停止发布和权限验证", async () => {
  await assert.rejects(
    runBaseline(
      options,
      validEnvironment(),
      dependencies(async (_options, _environment, _connections, complete) => {
        complete("identities_verified");
        throw new Error("migration checksum mismatch");
      }),
    ),
    /migration checksum mismatch/u,
  );
});

test("发布校验失败会保留最后完成的迁移阶段", async () => {
  let report;
  await assert.rejects(
    runBaseline({ ...options, reportPath: "unused" }, validEnvironment(), {
      ...dependencies(async (_options, _environment, _connections, complete) => {
        complete("migrations_applied");
        throw new Error("candidate validation failed");
      }),
      persistReport: async (_path, value) => {
        report = value;
      },
    }),
  );
  assert.equal(report.status, "failed");
  assert.equal(report.last_completed_stage, "migrations_applied");
  assert.equal(report.failure_after_stage, "migrations_applied");
  assert.equal(report.active_release_switch, false);
});

test("中途失败后可从入口完整重试", async () => {
  let attempt = 0;
  const deps = dependencies(async (_options, _environment, _connections, complete) => {
    attempt += 1;
    complete("migrations_applied");
    if (attempt === 1) throw new Error("transient publish failure");
    complete("candidate_validated");
    complete("permissions_verified");
  });
  await assert.rejects(
    runBaseline(options, validEnvironment(), deps),
    /transient publish failure/u,
  );
  const recovered = await runBaseline(options, validEnvironment(), deps);
  assert.equal(recovered.status, "prepared");
  assert.equal(recovered.last_completed_stage, "permissions_verified");
});

test("失败消息和报告不泄露连接串或密码", async () => {
  const environment = validEnvironment();
  const secretUrl = environment.NEON_ADMIN_DATABASE_URL;
  await assert.rejects(
    runBaseline(
      options,
      environment,
      dependencies(async () => {
        throw new Error(
          `connection failed: ${secretUrl} ep-baseline.ap-southeast-1.aws.neon.tech 203.0.113.7:5432`,
        );
      }),
    ),
    (error) => {
      assert(!error.message.includes("admin-secret"));
      assert(!error.message.includes(secretUrl));
      assert(!error.message.includes("ep-baseline.ap-southeast-1.aws.neon.tech"));
      assert(!error.message.includes("203.0.113.7"));
      assert.match(error.message, /REDACTED/u);
      assert.equal(error.cause, undefined);
      assert(!JSON.stringify(error).includes("admin-secret"));
      return true;
    },
  );
  const connections = validateConnectionEnvironment(environment, "logiplan", "ep-baseline");
  const serialized = JSON.stringify(createReport(options, { connections }));
  for (const secret of ["admin-secret", "migration-secret", "publisher-secret", "reader-secret"]) {
    assert(!serialized.includes(secret));
  }
});

test("未知写入结果会进入 unknown 报告并保留只读复核结果", async () => {
  let report;
  const unknown = new Error("write timeout");
  unknown.writeOutcomeUnknown = true;
  unknown.observedState = {
    state_check: "completed_read_only",
    latest_migration: "0010_realtime_evidence_snapshot.sql",
    release_status: "VALIDATED",
  };
  await assert.rejects(
    runBaseline({ ...options, reportPath: "unused" }, validEnvironment(), {
      ...dependencies(async () => {
        throw unknown;
      }),
      persistReport: async (_path, value) => {
        report = value;
      },
    }),
    /write timeout/u,
  );
  assert.equal(report.status, "unknown");
  assert.equal(report.write_outcome, "unknown_requires_read_only_review");
  assert.equal(report.observed_database_state.state_check, "completed_read_only");
});

test("数据库子进程超时会终止进程树并标记未知写入结果", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      timeoutMs: 100,
      writeOperation: true,
    }),
    (error) => {
      assert.equal(error.writeOutcomeUnknown, true);
      assert.match(error.message, /写入结果未知/u);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

test("数据库子进程报告 COMMIT 确认丢失时保留未知结果", async () => {
  await assert.rejects(
    runProcess(
      process.execPath,
      ["-e", "process.stderr.write('COMMIT 确认丢失，发布结果未知'); process.exit(1)"],
      { timeoutMs: 5_000, writeOperation: true },
    ),
    (error) => {
      assert.equal(error.writeOutcomeUnknown, true);
      assert.match(error.message, /结果未知/u);
      return true;
    },
  );
});
