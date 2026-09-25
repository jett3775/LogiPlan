import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createReport,
  committedObservationFailedWriteOutcome,
  executionClosurePaths,
  executeRoleBootstrapTransaction,
  exitCodeForBaselineError,
  assertExactPrivileges,
  assertRoleDefinitions,
  assertRolePrivilegeBaseline,
  assertSupportedNodeVersion,
  classifyBootstrapTransactionFailure,
  classifyRoleBootstrap,
  isolatedGitEnvironment,
  isUnknownWriteProcessExit,
  parseArguments,
  queryPrivilegeAclRows,
  runCli,
  runProcess,
  runBaseline,
  target,
  writeCommittedObservationFailedMarker,
  writeOutcomeUnknownExitCode,
  validateConnectionEnvironment,
  validateGitIdentity,
  validateCandidateShas,
  validateRoleMemberships,
  validateRoleDefinition,
  validateTargetEnvironment,
  validateToolingApproval,
} from "./neon-baseline.mjs";

const requireFromDatabasePackage = createRequire(
  new URL("../packages/db/package.json", import.meta.url),
);
const { Client } = requireFromDatabasePackage("pg");

const options = Object.freeze({
  write: true,
  timeoutMs: 30_000,
  candidateSha: target.candidateSha,
  approvedSha: target.candidateSha,
  toolingSha: target.candidateSha,
  expectedDatabase: "neondb",
});

function validEnvironment() {
  const directHost = "ep-baseline.ap-southeast-1.aws.neon.tech";
  return {
    LOGIPLAN_NEON_PROJECT_NAME: target.projectName,
    LOGIPLAN_NEON_PROJECT_ID: target.projectId,
    LOGIPLAN_NEON_REGION: target.region,
    LOGIPLAN_NEON_BRANCH_NAME: target.branchName,
    LOGIPLAN_NEON_BRANCH_ID: target.branchId,
    LOGIPLAN_NEON_POSTGRES_VERSION: target.postgresVersion,
    LOGIPLAN_NEON_ENDPOINT_ID: "ep-baseline",
    LOGIPLAN_APPROVED_TOOLING_SHA: target.candidateSha,
    NEON_ADMIN_DATABASE_URL: `postgresql://neondb_owner:admin-secret@${directHost}/neondb?sslmode=require`,
    NEON_SCHEMA_MIGRATOR_PASSWORD: "migration-secret",
    NEON_DATA_PUBLISHER_PASSWORD: "publisher-secret",
    NEON_APP_READER_PASSWORD: "reader-secret",
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
    reserveReport: async () => undefined,
  };
}

const runRoleBootstrapIntegration = process.env.NEON_BASELINE_TEST_DOCKER === "1";
const roleBootstrapContainerNamePattern = /^logiplan-role-bootstrap-test-\d+-[0-9a-f]{16}$/u;
const aclBaselineContainerNamePattern = /^logiplan-acl-baseline-test-\d+-[0-9a-f]{16}$/u;

function roleBootstrapConnections(overrides = {}) {
  return {
    roles: [
      { role: "schema_migrator", secret: "migration-secret" },
      { role: "data_publisher", secret: "publisher-secret" },
      { role: "app_reader", secret: "reader-secret" },
    ].map((connection, index) => ({ ...connection, ...(overrides[index] ?? {}) })),
  };
}

async function dropManagedRoles(admin) {
  await admin.query("DROP OWNED BY schema_migrator, data_publisher, app_reader");
  await admin.query("DROP ROLE IF EXISTS schema_migrator, data_publisher, app_reader");
}

async function existingManagedRoles(admin) {
  const result = await admin.query(
    `SELECT rolname FROM pg_roles
     WHERE rolname = ANY($1::text[])
     ORDER BY rolname`,
    [["schema_migrator", "data_publisher", "app_reader"]],
  );
  return result.rows.map(({ rolname }) => rolname);
}

function findDockerCli() {
  const candidates = [process.env.DOCKER_CLI, "docker"];
  if (process.platform === "win32") candidates.push("docker.exe");
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    const result = spawnSync(candidate, ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    if (result.status === 0 && result.stdout.trim().length > 0) return candidate;
  }
  throw new Error("无法连接 Docker 引擎以执行真实角色事务回归");
}

function postgresTestImage() {
  const image = process.env.NEON_BASELINE_TEST_POSTGRES_IMAGE ?? "postgres:18.4";
  assert.match(image, /^postgres:18\.(?:4|6)$/u);
  return image;
}

function runDocker(docker, args, environment = process.env) {
  const result = spawnSync(docker, args, {
    encoding: "utf8",
    env: environment,
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`隔离 PostgreSQL 命令失败：${result.stderr || result.error?.message}`);
  }
  return result.stdout.trim();
}

async function startRoleBootstrapPostgres({
  prefix = "logiplan-role-bootstrap-test",
  containerNamePattern = roleBootstrapContainerNamePattern,
  containerNameEnvironment = "NEON_BASELINE_TEST_CONTAINER_NAME",
} = {}) {
  const docker = findDockerCli();
  const generatedContainerName = `${prefix}-${process.pid}-${randomBytes(8).toString("hex")}`;
  const containerName = process.env[containerNameEnvironment] ?? generatedContainerName;
  assert.match(containerName, containerNamePattern);
  const password = randomBytes(24).toString("hex");
  const dockerEnvironment = { ...process.env, POSTGRES_PASSWORD: password };
  let cleanupRequired = false;
  try {
    const existing = spawnSync(docker, ["container", "inspect", containerName], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    assert.notEqual(existing.status, 0, "角色事务测试容器名称已被占用");
    cleanupRequired = true;
    const containerId = runDocker(
      docker,
      [
        "run",
        "--detach",
        "--rm",
        "--name",
        containerName,
        "--publish",
        "127.0.0.1::5432",
        "--tmpfs",
        "/var/lib/postgresql",
        "--env",
        "POSTGRES_DB=logiplan",
        "--env",
        "POSTGRES_USER=postgres",
        "--env",
        "POSTGRES_PASSWORD",
        postgresTestImage(),
      ],
      dockerEnvironment,
    );
    assert.match(containerId, /^[0-9a-f]{64}$/u);
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const probe = spawnSync(
        docker,
        ["exec", containerId, "pg_isready", "-U", "postgres", "-d", "logiplan"],
        { encoding: "utf8", timeout: 10_000, windowsHide: true },
      );
      if (probe.status === 0) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(ready, "隔离 PostgreSQL 未就绪");
    const port = runDocker(docker, ["port", containerId, "5432/tcp"]).split(":").at(-1);
    assert.match(port, /^\d+$/u);
    const connectionString = `postgresql://postgres:${password}@127.0.0.1:${port}/logiplan`;
    // 宿主侧端口可达性探测：容器内 pg_isready 成功只证明容器内 PostgreSQL 已就绪，
    // 不证明宿主机到发布端口的 TCP 通道已经建立。既有证据显示这两条 Docker 用例的
    // 偶发失败固定为 read ECONNRESET（errno -4077）或 Connection terminated
    // unexpectedly，耗时约 1.9—2.1s，正好落在容器就绪后宿主机建立连接的那一刻；
    // 同一命令重复执行结果不同（曾 2 fail，重跑 4 条腿全绿），隔离进程复刻六轮全绿。
    // 因此这里等待的是「宿主侧可观察到的可达状态」，不是放宽既有超时。
    const hostReachabilityAttempts = 12;
    const hostReachabilityIntervalMs = 250;
    let hostReachable = false;
    let lastHostProbeError;
    for (let attempt = 0; attempt < hostReachabilityAttempts; attempt += 1) {
      const probe = new Client({ connectionString });
      // 连接建立之后 socket 才被重置时，pg 会额外 emit 'error'；该错误已由下面
      // 查询的 promise 拒绝如实上报并触发重试，此处只避免它冒泡为未捕获异常。
      probe.on("error", () => undefined);
      try {
        await probe.connect();
        await probe.query("SELECT 1");
        hostReachable = true;
      } catch (error) {
        lastHostProbeError = error;
      } finally {
        await probe.end().catch(() => undefined);
      }
      if (hostReachable) break;
      await new Promise((resolve) => setTimeout(resolve, hostReachabilityIntervalMs));
    }
    assert(
      hostReachable,
      `宿主侧端口可达性探测失败：镜像 ${postgresTestImage()}、容器 ${containerName}、` +
        `发布端口 ${port}，已尝试 ${hostReachabilityAttempts} 次` +
        `（间隔 ${hostReachabilityIntervalMs}ms）仍无法建立连接，` +
        `最后一次失败 code=${lastHostProbeError?.code ?? "无"} ` +
        `message=${lastHostProbeError?.message ?? "无"}`,
    );
    return {
      connectionString,
      stop() {
        runDocker(docker, ["container", "rm", "--force", "--volumes", containerName]);
        cleanupRequired = false;
      },
    };
  } catch (error) {
    if (cleanupRequired) {
      try {
        runDocker(docker, ["container", "rm", "--force", "--volumes", containerName]);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "角色事务测试数据库启动失败且容器清理失败");
      }
    }
    throw error;
  }
}

test(
  "真实 PostgreSQL 角色创建事务保持原子性和既有密码",
  { skip: !runRoleBootstrapIntegration },
  async () => {
    const postgres = await startRoleBootstrapPostgres();
    const admin = new Client({ connectionString: postgres.connectionString });
    try {
      await admin.connect();
      const databaseIdentifier = await admin.query(
        "SELECT format('%I', current_database()) AS name",
      );
      const databaseName = databaseIdentifier.rows[0].name;
      const missingPlan = classifyRoleBootstrap([]);

      await executeRoleBootstrapTransaction(
        admin,
        roleBootstrapConnections(),
        databaseName,
        missingPlan,
      );
      assert.deepEqual(await existingManagedRoles(admin), [
        "app_reader",
        "data_publisher",
        "schema_migrator",
      ]);

      const passwordsBefore = await admin.query(
        `SELECT rolname, rolpassword FROM pg_authid
         WHERE rolname = ANY($1::text[])
         ORDER BY rolname`,
        [["schema_migrator", "data_publisher", "app_reader"]],
      );
      await executeRoleBootstrapTransaction(
        admin,
        roleBootstrapConnections({
          0: { secret: "changed-migration-secret" },
          1: { secret: "changed-publisher-secret" },
          2: { secret: "changed-reader-secret" },
        }),
        databaseName,
        classifyRoleBootstrap(await existingManagedRoles(admin)),
      );
      const passwordsAfter = await admin.query(
        `SELECT rolname, rolpassword FROM pg_authid
         WHERE rolname = ANY($1::text[])
         ORDER BY rolname`,
        [["schema_migrator", "data_publisher", "app_reader"]],
      );
      assert.deepEqual(passwordsAfter.rows, passwordsBefore.rows);

      await dropManagedRoles(admin);
      await admin.query(
        "CREATE ROLE bootstrap_admin LOGIN CREATEROLE NOSUPERUSER NOCREATEDB " +
          "NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD 'bootstrap-admin-secret'",
      );
      await admin.query(`ALTER DATABASE ${databaseName} OWNER TO bootstrap_admin`);
      const databasePort = new URL(postgres.connectionString).port;
      const bootstrapAdmin = new Client({
        connectionString: `postgresql://bootstrap_admin:bootstrap-admin-secret@127.0.0.1:${databasePort}/logiplan`,
      });
      try {
        await bootstrapAdmin.connect();
        await executeRoleBootstrapTransaction(
          bootstrapAdmin,
          roleBootstrapConnections(),
          databaseName,
          missingPlan,
          "bootstrap_admin",
        );
        await assertRoleDefinitions(bootstrapAdmin, "bootstrap_admin");
        const memberships = await bootstrapAdmin.query(
          `SELECT parent.rolname AS parent_role,
                  member.rolname AS member_role,
                  membership.grantor AS grantor_oid,
                  grantor.rolsuper AS grantor_is_superuser,
                  membership.admin_option,
                  membership.inherit_option,
                  membership.set_option
           FROM pg_auth_members AS membership
           JOIN pg_roles AS parent ON parent.oid = membership.roleid
           JOIN pg_roles AS member ON member.oid = membership.member
           LEFT JOIN pg_roles AS grantor ON grantor.oid = membership.grantor
           WHERE parent.rolname = ANY($1::text[])
           ORDER BY parent.rolname`,
          [["schema_migrator", "data_publisher", "app_reader"]],
        );
        assert.deepEqual(
          memberships.rows,
          ["app_reader", "data_publisher", "schema_migrator"].map((parent_role) => ({
            parent_role,
            member_role: "bootstrap_admin",
            grantor_oid: 10,
            grantor_is_superuser: true,
            admin_option: true,
            inherit_option: false,
            set_option: false,
          })),
        );

        await bootstrapAdmin.query("CREATE ROLE unexpected_member NOLOGIN");
        await bootstrapAdmin.query("GRANT app_reader TO unexpected_member");
        await assert.rejects(
          assertRoleDefinitions(bootstrapAdmin, "bootstrap_admin"),
          /角色成员关系的 member 不是已验证管理身份/u,
        );
        await bootstrapAdmin.query("REVOKE app_reader FROM unexpected_member");
        await bootstrapAdmin.query("DROP ROLE unexpected_member");
      } finally {
        await bootstrapAdmin.end().catch(() => undefined);
      }

      await dropManagedRoles(admin);
      await admin.query(
        "CREATE ROLE bootstrap_admin_options LOGIN CREATEROLE NOSUPERUSER NOCREATEDB " +
          "NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD 'bootstrap-admin-options-secret'",
      );
      await admin.query(`ALTER DATABASE ${databaseName} OWNER TO bootstrap_admin_options`);
      const optionAdmin = new Client({
        connectionString: `postgresql://bootstrap_admin_options:bootstrap-admin-options-secret@127.0.0.1:${databasePort}/logiplan`,
      });
      try {
        await optionAdmin.connect();
        await optionAdmin.query("SET createrole_self_grant = 'inherit, set'");
        await assert.rejects(
          executeRoleBootstrapTransaction(
            optionAdmin,
            roleBootstrapConnections(),
            databaseName,
            missingPlan,
            "bootstrap_admin_options",
          ),
          /选项偏离/u,
        );
        assert.deepEqual(await existingManagedRoles(admin), []);
      } finally {
        await optionAdmin.end().catch(() => undefined);
      }
      await admin.query(`ALTER DATABASE ${databaseName} OWNER TO postgres`);
      await admin.query("DROP ROLE bootstrap_admin, bootstrap_admin_options");

      await assert.rejects(
        executeRoleBootstrapTransaction(
          admin,
          roleBootstrapConnections({ 2: { role: "schema_migrator" } }),
          databaseName,
          missingPlan,
        ),
        (error) => {
          assert.equal(error.code, "42710");
          assert.equal(error.rollbackConfirmed, true);
          assert.equal(error.writeOutcomeUnknown, undefined);
          return true;
        },
      );
      assert.deepEqual(await existingManagedRoles(admin), []);

      await assert.rejects(
        executeRoleBootstrapTransaction(
          admin,
          roleBootstrapConnections(),
          '"missing_role_bootstrap_database"',
          missingPlan,
        ),
        (error) => {
          assert.equal(error.code, "3D000");
          assert.equal(error.rollbackConfirmed, true);
          assert.equal(error.writeOutcomeUnknown, undefined);
          return true;
        },
      );
      assert.deepEqual(await existingManagedRoles(admin), []);
    } finally {
      await admin.end().catch(() => undefined);
      postgres.stop();
    }
  },
);

test(
  "真实 PostgreSQL 权限基线检查路径执行生产 ACL 查询",
  { skip: !runRoleBootstrapIntegration },
  async () => {
    const postgres = await startRoleBootstrapPostgres({
      prefix: "logiplan-acl-baseline-test",
      containerNamePattern: aclBaselineContainerNamePattern,
      containerNameEnvironment: "NEON_BASELINE_ACL_TEST_CONTAINER_NAME",
    });
    const admin = new Client({ connectionString: postgres.connectionString });
    try {
      await admin.connect();
      const databaseIdentifier = await admin.query(
        "SELECT format('%I', current_database()) AS name",
      );
      const databaseName = databaseIdentifier.rows[0].name;
      await executeRoleBootstrapTransaction(
        admin,
        roleBootstrapConnections(),
        databaseName,
        classifyRoleBootstrap([]),
      );

      const { hostname, port } = new URL(postgres.connectionString);
      const migration = spawnSync(
        process.execPath,
        ["--import", "tsx", "packages/db/src/migrate.ts"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            MIGRATION_DATABASE_URL: `postgresql://schema_migrator:migration-secret@${hostname}:${port}/logiplan`,
            MIGRATION_DIRECTORY: resolve("database/migrations"),
          },
          timeout: 300_000,
          windowsHide: true,
        },
      );
      assert.equal(
        migration.status,
        0,
        `隔离迁移执行失败：${(migration.stderr || migration.stdout || "").slice(-2000)}`,
      );

      await assertRolePrivilegeBaseline(admin, "postgres");

      await admin.query("CREATE SEQUENCE logiplan.acl_probe_sequence");
      await admin.query("ALTER SEQUENCE logiplan.acl_probe_sequence OWNER TO schema_migrator");
      const withoutGrant = await queryPrivilegeAclRows(admin);
      assert.deepEqual(
        withoutGrant.relationAcl.filter((row) => row.relname === "acl_probe_sequence"),
        [],
        "无显式授权的序列不得产生 ACL 行",
      );
      await admin.query("GRANT USAGE ON SEQUENCE logiplan.acl_probe_sequence TO app_reader");
      const withGrant = await queryPrivilegeAclRows(admin);
      assert.deepEqual(
        withGrant.relationAcl
          .filter((row) => row.relname === "acl_probe_sequence")
          .map((row) => `${row.relkind}:${row.grantee}:${row.privilege_type}`),
        ["S:app_reader:USAGE"],
        "序列 ACL 行必须按 relkind S 与授权对象如实返回",
      );
    } finally {
      await admin.end().catch(() => undefined);
      postgres.stop();
    }
  },
);

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
    /连接串和密码只能通过环境变量/u,
  );
  assert.throws(
    () =>
      parseArguments([
        "--candidate-sha",
        target.candidateSha,
        "--approved-sha",
        target.candidateSha,
        "--expected-database",
        "neondb",
        "NEON_APP_READER_PASSWORD=secret",
      ]),
    /连接串和密码只能通过环境变量/u,
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

test("执行闭包覆盖实际加载的 Gate1 编排、查询和契约包源码", () => {
  for (const path of [
    "tsconfig.base.json",
    "scripts/verify-gate1-isolated.mjs",
    "packages/db/src",
    "packages/domain/package.json",
    "packages/domain/tsconfig.json",
    "packages/domain/src",
    "packages/contracts/package.json",
    "packages/contracts/tsconfig.json",
    "packages/contracts/src",
  ]) {
    assert(executionClosurePaths.includes(path), path);
  }
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

function roleMembershipRow(overrides = {}) {
  return {
    parent_oid: 16384,
    parent_role: "schema_migrator",
    member_oid: 16385,
    member_role: "bootstrap_admin",
    grantor_oid: 10,
    grantor_role: "postgres",
    grantor_is_superuser: true,
    admin_option: true,
    inherit_option: false,
    set_option: false,
    ...overrides,
  };
}

test("严格接受 PostgreSQL 18 CREATEROLE 自动管理关系", () => {
  assert.doesNotThrow(() => validateRoleMemberships([], { adminRole: "bootstrap_admin" }));
  assert.doesNotThrow(() =>
    validateRoleMemberships(
      [
        roleMembershipRow(),
        roleMembershipRow({ parent_role: "data_publisher", parent_oid: 16386 }),
        roleMembershipRow({ parent_role: "app_reader", parent_oid: 16387 }),
      ],
      { adminRole: "bootstrap_admin" },
    ),
  );
});

test("三角色成员关系的方向、选项、授予者和证据完整性全部受限", () => {
  const rejected = [
    [
      "managed role is a member",
      roleMembershipRow({ parent_role: "bootstrap_admin", member_role: "app_reader" }),
    ],
    ["unexpected member", roleMembershipRow({ member_role: "other_admin" })],
    ["admin option false", roleMembershipRow({ admin_option: false })],
    ["inherit option true", roleMembershipRow({ inherit_option: true })],
    ["set option true", roleMembershipRow({ set_option: true })],
    ["wrong grantor oid", roleMembershipRow({ grantor_oid: 11 })],
    ["grantor is not superuser", roleMembershipRow({ grantor_is_superuser: false })],
    ["missing grantor", roleMembershipRow({ grantor_role: null })],
    ["wrong field type", roleMembershipRow({ admin_option: "true" })],
    ["duplicate relation", [roleMembershipRow(), roleMembershipRow()]],
  ];
  for (const [label, value] of rejected) {
    assert.throws(
      () =>
        validateRoleMemberships(Array.isArray(value) ? value : [value], {
          adminRole: "bootstrap_admin",
        }),
      /角色成员关系/u,
      label,
    );
  }
  assert.throws(
    () =>
      validateRoleMemberships([roleMembershipRow(), roleMembershipRow()], {
        adminRole: "bootstrap_admin",
      }),
    /重复/u,
  );
});

test("管理和发布必须直连，运行角色必须池化", () => {
  const environment = validEnvironment();
  environment.NEON_ADMIN_DATABASE_URL = environment.NEON_ADMIN_DATABASE_URL.replace(
    "neondb_owner:",
    "app_reader:",
  );
  assert.throws(
    () => validateConnectionEnvironment(environment, "neondb", "ep-baseline"),
    /管理连接必须使用 neondb_owner/u,
  );
});

test("从 admin 主机和隐藏密码构造编码后的直连与池化角色连接", () => {
  const environment = validEnvironment();
  environment.NEON_APP_READER_PASSWORD = "reader%40secret/@?#";
  const connections = validateConnectionEnvironment(environment, "neondb", "ep-baseline");
  assert.equal(connections.admin.parsed.hostname, "ep-baseline.ap-southeast-1.aws.neon.tech");
  assert.equal(connections.roles[0].parsed.hostname, "ep-baseline.ap-southeast-1.aws.neon.tech");
  assert.equal(connections.roles[1].parsed.hostname, "ep-baseline.ap-southeast-1.aws.neon.tech");
  assert.equal(
    connections.roles[2].parsed.hostname,
    "ep-baseline-pooler.ap-southeast-1.aws.neon.tech",
  );
  assert.equal(decodeURIComponent(connections.roles[2].parsed.password), "reader%40secret/@?#");
  assert.equal(decodeURIComponent(connections.roles[2].parsed.pathname.slice(1)), "neondb");
  assert.equal(connections.roles[2].parsed.search, "?sslmode=require");
  assert.match(connections.roles[2].raw, /%25|%40|%2F|%3F|%23/u);
});

test("拒绝 admin URL 中覆盖 host、角色或密码的查询参数", () => {
  const environment = validEnvironment();
  environment.NEON_ADMIN_DATABASE_URL += "&host=attacker.example&user=attacker";
  assert.throws(
    () => validateConnectionEnvironment(environment, "neondb", "ep-baseline"),
    /只能包含 sslmode/u,
  );
});

test("不读取旧的角色连接串环境变量覆盖内部构造结果", () => {
  const environment = validEnvironment();
  environment.MIGRATION_DATABASE_URL =
    "postgresql://attacker:wrong@ep-wrong.ap-southeast-1.aws.neon.tech/wrong?sslmode=require";
  environment.PUBLISHER_DATABASE_URL = environment.MIGRATION_DATABASE_URL;
  environment.DATABASE_URL = environment.MIGRATION_DATABASE_URL;
  const connections = validateConnectionEnvironment(environment, "neondb", "ep-baseline");
  assert.equal(connections.roles[0].parsed.username, "schema_migrator");
  assert.equal(connections.roles[0].parsed.hostname, "ep-baseline.ap-southeast-1.aws.neon.tech");
  assert.equal(connections.roles[2].parsed.username, "app_reader");
  assert.equal(
    connections.roles[2].parsed.hostname,
    "ep-baseline-pooler.ap-southeast-1.aws.neon.tech",
  );
});

test("缺少任一角色密码时拒绝写入凭据构造", () => {
  const environment = validEnvironment();
  delete environment.NEON_DATA_PUBLISHER_PASSWORD;
  assert.throws(
    () => validateConnectionEnvironment(environment, "neondb", "ep-baseline"),
    /NEON_DATA_PUBLISHER_PASSWORD/u,
  );
});

test("角色初始化计划区分全部缺失、全部存在并拒绝部分漂移", () => {
  assert.deepEqual(classifyRoleBootstrap([]), {
    allPresent: false,
    rolesToCreate: ["schema_migrator", "data_publisher", "app_reader"],
  });
  assert.deepEqual(classifyRoleBootstrap(["schema_migrator", "data_publisher", "app_reader"]), {
    allPresent: true,
    rolesToCreate: [],
  });
  assert.throws(() => classifyRoleBootstrap(["schema_migrator"]), /三角色只存在一部分/u);
});

test("角色事务的连接异常和 COMMIT 确认丢失均为 unknown", () => {
  const connectionError = Object.assign(new Error("connection terminated"), { code: "08006" });
  assert.deepEqual(
    classifyBootstrapTransactionFailure(connectionError, {
      commitSent: false,
      rollbackConfirmed: false,
    }),
    { writeOutcomeUnknown: true },
  );
  assert.deepEqual(
    classifyBootstrapTransactionFailure(new Error("COMMIT acknowledgement lost"), {
      commitSent: true,
      rollbackConfirmed: false,
    }),
    { writeOutcomeUnknown: true },
  );
  assert.deepEqual(
    classifyBootstrapTransactionFailure(new Error("constraint violation"), {
      commitSent: false,
      rollbackConfirmed: true,
    }),
    { rollbackConfirmed: true },
  );
});

test("默认预检不读取连接串且不执行数据库写入", async () => {
  const environment = validEnvironment();
  for (const name of [
    "NEON_ADMIN_DATABASE_URL",
    "NEON_SCHEMA_MIGRATOR_PASSWORD",
    "NEON_DATA_PUBLISHER_PASSWORD",
    "NEON_APP_READER_PASSWORD",
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

test("预检失败路径也不读取凭据", async () => {
  const accesses = [];
  const environment = new Proxy(validEnvironment(), {
    get(target, property, receiver) {
      accesses.push(String(property));
      return Reflect.get(target, property, receiver);
    },
  });
  const localFailure = new Error("local preflight failed");
  await assert.rejects(
    runBaseline({ ...options, write: false }, environment, {
      ...dependencies(async () => undefined),
      localConfigPreflight: async () => {
        throw localFailure;
      },
    }),
    /local preflight failed/u,
  );
  assert.deepEqual(
    accesses.filter((name) =>
      [
        "NEON_ADMIN_DATABASE_URL",
        "NEON_SCHEMA_MIGRATOR_PASSWORD",
        "NEON_DATA_PUBLISHER_PASSWORD",
        "NEON_APP_READER_PASSWORD",
      ].includes(name),
    ),
    [],
  );
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

test("报告路径在任何预检副作用之前原子预留，被占用时立即失败", async () => {
  const directory = await mkdtemp(join(tmpdir(), "logiplan-report-reservation-"));
  const reportPath = join(directory, "report.json");
  await writeFile(reportPath, "{}\n", "utf8");
  const calls = [];
  try {
    await assert.rejects(
      runBaseline({ ...options, reportPath }, validEnvironment(), {
        localConfigPreflight: async () => {
          calls.push("local_config");
        },
        gitPreflight: async () => {
          calls.push("git");
          return {
            branch: target.candidateBranch,
            head: options.toolingSha,
            assetsClean: true,
            closureClean: true,
          };
        },
        prepareDatabase: async () => {
          calls.push("prepare_database");
          return {};
        },
        persistReport: async () => {
          calls.push("persist_report");
        },
      }),
      /EEXIST/u,
    );
    assert.deepEqual(calls, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("失败路径不再吞掉报告写入错误", async () => {
  const writeFailure = "报告目录不可写";
  const error = await runBaseline({ ...options, reportPath: "unused" }, validEnvironment(), {
    ...dependencies(async () => {
      throw Object.assign(new Error("prepare 失败"), { writeOutcomeUnknown: true });
    }),
    reserveReport: async () => undefined,
    persistReport: async () => {
      throw new Error(writeFailure);
    },
  }).catch((caught) => caught);
  assert.equal(error.writeOutcomeUnknown, true);
  assert.equal(error.reportWriteFailure, writeFailure);
  assert.match(error.message, /报告写入失败/u);
});

test("失败消息和报告不泄露连接串或密码", async () => {
  const environment = validEnvironment();
  const secretUrl = environment.NEON_ADMIN_DATABASE_URL;
  await assert.rejects(
    runBaseline(
      options,
      environment,
      dependencies(async (_options, _environment, connections) => {
        const roleUrl = connections.roles[2].raw;
        throw new Error(
          [
            "connection failed:",
            secretUrl,
            roleUrl,
            environment.NEON_APP_READER_PASSWORD,
            "ep-baseline.ap-southeast-1.aws.neon.tech",
            "203.0.113.7:5432",
          ].join(" "),
        );
      }),
    ),
    (error) => {
      assert(!error.message.includes("admin-secret"));
      assert(!error.message.includes("reader-secret"));
      assert(!error.message.includes(secretUrl));
      assert(!error.message.includes("ep-baseline.ap-southeast-1.aws.neon.tech"));
      assert(!error.message.includes("203.0.113.7"));
      assert.match(error.message, /REDACTED/u);
      assert.equal(error.cause, undefined);
      assert(!JSON.stringify(error).includes("admin-secret"));
      return true;
    },
  );
  const connections = validateConnectionEnvironment(environment, "neondb", "ep-baseline");
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

test("已提交写入的提交后观察失败进入独立结果，不冒充未知写入或 known_failed", async () => {
  let report;
  const committed = new Error(
    "发布写入已提交，失败发生在后续观察或清理阶段：释放 advisory 锁：connection closed；不得把它当作写入失败重做",
  );
  committed.writeCommittedObservationFailed = true;
  await assert.rejects(
    runBaseline({ ...options, reportPath: "unused" }, validEnvironment(), {
      ...dependencies(async () => {
        throw committed;
      }),
      persistReport: async (_path, value) => {
        report = value;
      },
    }),
    /写入已提交/u,
  );
  assert.equal(report.status, "failed");
  assert.equal(report.write_outcome, committedObservationFailedWriteOutcome);
  assert.notEqual(report.write_outcome, "unknown_requires_read_only_review");
  assert.notEqual(report.write_outcome, "known_failed");
  assert.equal(report.write_committed_observation_failed, true);
});

test("未发生提交后观察失败的报告中该标志为 false", async () => {
  const report = await runBaseline(
    options,
    validEnvironment(),
    dependencies(async (_options, _environment, _connections, complete) => {
      complete("permissions_verified");
      return { releaseStatus: "VALIDATED", observedActiveRelease: "LOGIPLAN_2026_DEMO_V1" };
    }),
  );
  assert.equal(report.write_committed_observation_failed, false);
  assert.equal(report.write_outcome, "known");
  assert.equal(createReport(options, {}).write_committed_observation_failed, false);
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
      [
        "-e",
        `process.stderr.write('commit acknowledgement lost'); process.exit(${writeOutcomeUnknownExitCode})`,
      ],
      { timeoutMs: 5_000, writeOperation: true },
    ),
    (error) => {
      assert.equal(error.writeOutcomeUnknown, true);
      assert.match(error.message, /code=75/u);
      return true;
    },
  );
});

test("数据库写入子进程异常退出码不再被当作已知失败", async () => {
  for (const code of [137, 2]) {
    await assert.rejects(
      runProcess(process.execPath, ["-e", `process.exit(${code})`], {
        timeoutMs: 5_000,
        writeOperation: true,
      }),
      (error) => {
        assert.equal(error.writeOutcomeUnknown, true, `退出码 ${code}`);
        return true;
      },
    );
  }
});

test("写入口自报提交后观察失败时保留独立结果，不再归为未知写入", async () => {
  await assert.rejects(
    runProcess(
      process.execPath,
      [
        "-e",
        `process.stderr.write('${writeCommittedObservationFailedMarker} 数据发布失败：写入已提交，失败发生在后续观察或清理阶段'); process.exit(1)`,
      ],
      { timeoutMs: 5_000, writeOperation: true },
    ),
    (error) => {
      assert.equal(error.writeCommittedObservationFailed, true);
      assert.equal(error.writeOutcomeUnknown, undefined);
      assert.equal(error.childExitCode, 1);
      return true;
    },
  );
});

test("写入子进程以退出码 1 失败但没有该前缀时仍不是提交后观察失败", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "process.stderr.write('plain failure'); process.exit(1)"], {
      timeoutMs: 5_000,
      writeOperation: true,
    }),
    (error) => {
      assert.equal(error.writeCommittedObservationFailed, undefined);
      assert.equal(error.writeOutcomeUnknown, undefined);
      assert.equal(error.childExitCode, 1);
      return true;
    },
  );
});

test("只读子进程失败和启动失败仍是已知失败", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "process.exit(1)"], { timeoutMs: 5_000 }),
    (error) => {
      assert.equal(error.writeOutcomeUnknown, undefined);
      assert.match(error.message, /code=1/u);
      return true;
    },
  );
  const missingCommand =
    process.platform === "win32" ? "logiplan-missing-command.exe" : "logiplan-missing-command";
  await assert.rejects(
    runProcess(missingCommand, [], { timeoutMs: 5_000, writeOperation: true }),
    (error) => {
      assert.equal(error.writeOutcomeUnknown, undefined);
      return true;
    },
  );
});

const runPowerShellPassthroughTest = process.platform === "win32";

function powershellHosts() {
  const hosts = [];
  if (process.env.SystemRoot) {
    const windowsPowerShell = join(
      process.env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (existsSync(windowsPowerShell)) {
      hosts.push({ label: "Windows PowerShell", executable: windowsPowerShell });
    }
  }
  if (process.env.ProgramFiles) {
    const pwsh = join(process.env.ProgramFiles, "PowerShell", "7", "pwsh.exe");
    if (existsSync(pwsh)) hosts.push({ label: "PowerShell 7", executable: pwsh });
  }
  return hosts;
}

test("PowerShell 入口原样透传 Node 退出码", { skip: !runPowerShellPassthroughTest }, async () => {
  const hosts = powershellHosts();
  assert(hosts.length > 0, "未找到可用的 PowerShell 宿主");
  const script = fileURLToPath(new URL("./neon-baseline.ps1", import.meta.url));
  const shimDirectory = await mkdtemp(join(tmpdir(), "logiplan-node-shim-"));
  const environment = {
    ...process.env,
    PATH: `${shimDirectory};${process.env.PATH ?? process.env.Path ?? ""}`,
  };
  delete environment.Path;
  try {
    for (const host of hosts) {
      for (const code of [0, 1, writeOutcomeUnknownExitCode]) {
        await writeFile(
          join(shimDirectory, "node.cmd"),
          `@echo off\r\necho simulated-node-stderr 1>&2\r\nexit /b ${code}\r\n`,
          "utf8",
        );
        const result = spawnSync(
          host.executable,
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script,
            "-CandidateSha",
            target.candidateSha,
            "-ApprovedSha",
            target.candidateSha,
            "-ExpectedDatabase",
            "neondb",
          ],
          { encoding: "utf8", env: environment, timeout: 60_000, windowsHide: true },
        );
        const diagnostic = `${result.stderr}${result.error?.message ?? ""}`;
        assert.equal(result.status, code, `${host.label} 退出码 ${code}：${diagnostic}`);
      }
    }
  } finally {
    await rm(shimDirectory, { recursive: true, force: true });
  }
});

test("写入子进程异常终止的分类规则是单一纯函数", () => {
  const classify = (overrides) =>
    isUnknownWriteProcessExit({
      writeOperation: true,
      spawned: true,
      timedOut: false,
      code: 0,
      signal: null,
      ...overrides,
    });
  assert.equal(classify({ code: 0 }), false, "退出码 0 是成功");
  assert.equal(classify({ code: 1 }), false, "退出码 1 是受控已知失败");
  assert.equal(classify({ code: writeOutcomeUnknownExitCode }), true, "退出码 75 是未知");
  assert.equal(classify({ code: 137 }), true, "异常退出码是未知");
  assert.equal(classify({ code: 2 }), true, "非 0/1/75 的退出码是未知");
  assert.equal(classify({ code: null, signal: "SIGTERM" }), true, "信号终止是未知");
  assert.equal(classify({ code: null, signal: null }), true, "缺少退出码是未知");
  assert.equal(classify({ timedOut: true, code: 1 }), true, "超时优先于退出码");
  assert.equal(classify({ spawned: false, code: 137 }), false, "启动前失败不是未知");
  assert.equal(classify({ writeOperation: false, code: 137 }), false, "只读子进程不受影响");
});

test("Node 入口把未知写入结果映射为退出码 75", async () => {
  const argv = [
    "--candidate-sha",
    target.candidateSha,
    "--approved-sha",
    target.candidateSha,
    "--expected-database",
    "neondb",
  ];
  const stdout = { write: () => undefined };
  const stderr = { write: () => undefined };
  const unknown = new Error("write timeout");
  unknown.writeOutcomeUnknown = true;
  assert.equal(exitCodeForBaselineError(new Error("known")), 1);
  assert.equal(exitCodeForBaselineError(unknown), writeOutcomeUnknownExitCode);
  assert.equal(
    await runCli(argv, {
      runBaseline: async () => {
        throw unknown;
      },
      stdout,
      stderr,
    }),
    writeOutcomeUnknownExitCode,
    "未知写入结果必须以 75 结束进程",
  );
  assert.equal(
    await runCli(argv, {
      runBaseline: async () => {
        throw new Error("known");
      },
      stdout,
      stderr,
    }),
    1,
    "已知失败仍以 1 结束进程",
  );
  assert.equal(
    await runCli(argv, {
      runBaseline: async () => ({ status: "preflight_passed" }),
      stdout,
      stderr,
    }),
    0,
    "成功以 0 结束进程",
  );
});

test("非法参数以已知失败结束并输出脱敏错误信息", async () => {
  const output = [];
  const stderr = {
    write: (chunk) => {
      output.push(String(chunk));
      return true;
    },
  };
  assert.equal(
    await runCli(["--bogus"], { stdout: { write: () => undefined }, stderr }),
    1,
    "参数错误属于已知失败",
  );
  const message = output.join("");
  assert.match(message, /Neon 基线执行失败/u);
  assert.match(message, /未知参数/u);
  assert(!message.includes("\n    at "), "不得向用户输出原始堆栈");
});
