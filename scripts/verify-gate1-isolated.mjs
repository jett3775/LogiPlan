import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

const projectName = `logiplan-gate1-${process.pid}-${randomBytes(4).toString("hex")}`;
const projectNamePattern = /^logiplan-gate1-[a-z0-9-]+$/u;
const temporaryMigrationPrefix = "logiplan-gate1-migrations-";
const gate1MigrationFiles = [
  "0001_gate1_schema.sql",
  "0002_release_reactivation.sql",
  "0003_schema_version_reader.sql",
];

if (!projectNamePattern.test(projectName) || projectName === "logiplan") {
  throw new Error("隔离 Compose 项目名无效");
}

const localPasswords = {
  superuser: randomBytes(24).toString("hex"),
  migrator: randomBytes(24).toString("hex"),
  publisher: randomBytes(24).toString("hex"),
  reader: randomBytes(24).toString("hex"),
};

let activeChild;
let receivedSignal;
let receivedSignalCount = 0;
let cleanupStarted = false;

const isolatedEnvironmentKeys = [
  "POSTGRES_PORT",
  "POSTGRES_SUPERUSER_PASSWORD",
  "LOGIPLAN_SCHEMA_MIGRATOR_PASSWORD",
  "LOGIPLAN_DATA_PUBLISHER_PASSWORD",
  "LOGIPLAN_APP_READER_PASSWORD",
  "MIGRATION_DATABASE_URL",
  "PUBLISHER_DATABASE_URL",
  "DATABASE_URL",
  "MIGRATION_DIRECTORY",
  "RELEASE_MANIFEST",
];
const passthroughEnvironmentKeys = [
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
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "ProgramData",
  "PROGRAMFILES",
  "ProgramFiles",
  "PROGRAMFILES(X86)",
  "ProgramFiles(x86)",
  "CI",
  "GITHUB_ACTIONS",
  "RUNNER_OS",
  "RUNNER_ARCH",
  "RUNNER_TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PNPM_HOME",
  "COREPACK_HOME",
  "npm_execpath",
  "npm_node_execpath",
  "npm_config_user_agent",
  "npm_config_cache",
  "npm_config_store_dir",
  "DOCKER_CLI",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "PLAYWRIGHT_BROWSERS_PATH",
  "NEXT_TELEMETRY_DISABLED",
];

function passthroughEnvironment() {
  return Object.fromEntries(
    passthroughEnvironmentKeys.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function reserveEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("无法分配隔离 PostgreSQL 本地端口"));
        return;
      }
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function createGate1MigrationDirectory() {
  const directory = await mkdtemp(join(tmpdir(), temporaryMigrationPrefix));
  const sourceDirectory = resolve("database/migrations");
  try {
    await Promise.all(
      gate1MigrationFiles.map((fileName) =>
        copyFile(join(sourceDirectory, fileName), join(directory, fileName)),
      ),
    );
    return directory;
  } catch (error) {
    await removeGate1MigrationDirectory(directory).catch(() => undefined);
    throw error;
  }
}

async function removeGate1MigrationDirectory(directory) {
  const resolvedDirectory = resolve(directory);
  const resolvedTemporaryRoot = resolve(tmpdir());
  if (
    dirname(resolvedDirectory) !== resolvedTemporaryRoot ||
    !basename(resolvedDirectory).startsWith(temporaryMigrationPrefix)
  ) {
    throw new Error("拒绝清理未受控的临时迁移目录");
  }
  await rm(resolvedDirectory, { recursive: true, force: true });
}

function pnpmInvocation(args) {
  if (process.env.npm_execpath !== undefined) {
    return {
      command: process.execPath,
      args: [process.env.npm_execpath, ...args],
      shell: false,
    };
  }
  if (process.platform === "win32") {
    return { command: "pnpm.cmd", args, shell: true };
  }
  return { command: "pnpm", args, shell: false };
}

function assertNotInterrupted() {
  if (receivedSignal !== undefined) {
    throw new Error(`收到 ${receivedSignal}，停止启动后续验证步骤`);
  }
}

function runProcess(label, command, args, env, options = {}) {
  if (options.cleanup !== true) {
    try {
      assertNotInterrupted();
    } catch (error) {
      return Promise.reject(error);
    }
  }
  process.stdout.write(`\n[Gate 1] ${label}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      shell: options.shell ?? false,
      stdio: "inherit",
      windowsHide: true,
    });
    activeChild = child;
    let settled = false;
    let timedOut = false;
    let timeoutTimer;
    let forceKillTimer;
    let hardStopTimer;

    const clearTimers = () => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (hardStopTimer !== undefined) clearTimeout(hardStopTimer);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (activeChild === child) activeChild = undefined;
      if (error === undefined) resolve();
      else reject(error);
    };

    if (options.timeoutMs !== undefined) {
      const killGraceMs = options.killGraceMs ?? 2_000;
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (settled) return;
          child.kill("SIGKILL");
          hardStopTimer = setTimeout(() => {
            finish(new Error(`${label} 超时，已执行受限终止`));
          }, killGraceMs);
        }, killGraceMs);
      }, options.timeoutMs);
    }

    child.once("error", (error) => {
      finish(new Error(`${label} 无法启动：${error.message}`, { cause: error }));
    });
    child.once("exit", (code, signal) => {
      if (timedOut) {
        finish(new Error(`${label} 超时，子进程已退出`));
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      finish(new Error(`${label} 失败（code=${String(code)}, signal=${String(signal)}）`));
    });
  });
}

function runPnpm(label, args, env) {
  const invocation = pnpmInvocation(args);
  return runProcess(label, invocation.command, invocation.args, env, {
    shell: invocation.shell,
  });
}

function runCompose(label, args, env, options = {}) {
  return runProcess(
    label,
    process.execPath,
    ["scripts/run-docker-compose.mjs", "-p", projectName, "-f", "compose.yaml", ...args],
    env,
    options,
  );
}

function handleSignal(signal) {
  receivedSignalCount += 1;
  if (receivedSignal === undefined) receivedSignal = signal;
  if (!cleanupStarted && activeChild !== undefined) {
    activeChild.kill(receivedSignalCount > 1 ? "SIGKILL" : signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => handleSignal(signal));
}

async function verify() {
  const postgresPort = await reserveEphemeralPort();
  let performancePort = await reserveEphemeralPort();
  while (performancePort === postgresPort) {
    performancePort = await reserveEphemeralPort();
  }
  const databaseHost = `127.0.0.1:${postgresPort}`;
  const databaseName = "logiplan";
  const roleUrl = (role, password) =>
    `postgresql://${role}:${encodeURIComponent(password)}@${databaseHost}/${databaseName}`;
  const guardedEnvironment = {
    ...passthroughEnvironment(),
    TZ: "UTC",
    ...Object.fromEntries(isolatedEnvironmentKeys.map((name) => [name, ""])),
    LOGIPLAN_PERF_PORT: String(performancePort),
  };
  const migrationUrl = roleUrl("schema_migrator", localPasswords.migrator);
  const publisherUrl = roleUrl("data_publisher", localPasswords.publisher);
  const readerUrl = roleUrl("app_reader", localPasswords.reader);
  const fullMigrationDirectory = resolve("database/migrations");
  const v1Manifest = resolve("database/releases/LOGIPLAN_2026_DEMO_V1.json");
  const v2Manifest = resolve("database/releases/LOGIPLAN_2026_DEMO_V2.json");

  const composeEnv = {
    ...guardedEnvironment,
    POSTGRES_PORT: String(postgresPort),
    POSTGRES_SUPERUSER_PASSWORD: localPasswords.superuser,
    LOGIPLAN_SCHEMA_MIGRATOR_PASSWORD: localPasswords.migrator,
    LOGIPLAN_DATA_PUBLISHER_PASSWORD: localPasswords.publisher,
    LOGIPLAN_APP_READER_PASSWORD: localPasswords.reader,
  };
  const migrationEnv = {
    ...guardedEnvironment,
    MIGRATION_DATABASE_URL: migrationUrl,
    MIGRATION_DIRECTORY: fullMigrationDirectory,
  };
  const publisherEnv = {
    ...guardedEnvironment,
    PUBLISHER_DATABASE_URL: publisherUrl,
    RELEASE_MANIFEST: v2Manifest,
  };
  const verificationEnv = {
    ...guardedEnvironment,
    MIGRATION_DATABASE_URL: migrationUrl,
    PUBLISHER_DATABASE_URL: publisherUrl,
    DATABASE_URL: readerUrl,
  };
  const releaseVerificationEnv = {
    ...guardedEnvironment,
    PUBLISHER_DATABASE_URL: publisherUrl,
    DATABASE_URL: readerUrl,
  };
  const readerRuntimeEnv = {
    ...guardedEnvironment,
    DATABASE_URL: readerUrl,
    SNAPSHOT_TEST_SUPERUSER_URL: roleUrl("postgres", localPasswords.superuser),
  };

  let temporaryMigrationDirectory;
  let primaryError;
  try {
    assertNotInterrupted();
    temporaryMigrationDirectory = await createGate1MigrationDirectory();
    const v1MigrationEnv = {
      ...migrationEnv,
      MIGRATION_DIRECTORY: temporaryMigrationDirectory,
    };
    const v1PublisherEnv = {
      ...publisherEnv,
      RELEASE_MANIFEST: v1Manifest,
    };

    await runCompose("启动隔离 PostgreSQL 18.4", ["up", "-d", "--wait"], composeEnv);
    await runPnpm("从零执行 0001—0003 迁移", ["db:migrate"], v1MigrationEnv);
    await runProcess(
      "使用测试专用 harness 发布 0003 基线 V1 数据",
      process.execPath,
      ["--import", "tsx", "scripts/publish-gate1-v1-baseline.ts"],
      v1PublisherEnv,
    );
    await runPnpm("从 0003 升级执行完整迁移", ["db:migrate"], migrationEnv);
    await runPnpm("发布 V2 数据", ["db:publish"], publisherEnv);
    await runPnpm("重复发布幂等验证", ["db:publish"], publisherEnv);
    await runPnpm("结构、精度与三角色权限验证", ["db:verify"], verificationEnv);
    await runPnpm("不可变发布升级与核心查询验证", ["db:verify-release"], releaseVerificationEnv);
    await runPnpm("核心查询计划验证", ["db:verify-plans"], readerRuntimeEnv);
    await runPnpm("生产构建", ["build"], readerRuntimeEnv);
    await runPnpm("Chromium 双视口基础冒烟", ["test:e2e:gate1"], readerRuntimeEnv);
    await runPnpm("Firefox 核心冒烟", ["test:e2e:firefox-smoke"], readerRuntimeEnv);
    await runProcess(
      "并发 5、100 次热查询性能验证",
      process.execPath,
      ["scripts/verify-query-performance.mjs"],
      readerRuntimeEnv,
    );
  } catch (error) {
    primaryError = error;
  } finally {
    cleanupStarted = true;
    let cleanupError;
    try {
      await runCompose(
        "清理本次隔离 PostgreSQL 项目与命名卷",
        ["down", "-v", "--remove-orphans"],
        composeEnv,
        { cleanup: true, timeoutMs: 30_000, killGraceMs: 2_000 },
      );
    } catch (error) {
      cleanupError = error;
    }

    if (temporaryMigrationDirectory !== undefined) {
      try {
        await removeGate1MigrationDirectory(temporaryMigrationDirectory);
      } catch (error) {
        if (cleanupError === undefined) {
          cleanupError = error;
        } else {
          process.stderr.write(
            `[Gate 1] 临时迁移目录清理失败：${error instanceof Error ? error.message : "未知错误"}\n`,
          );
        }
      }
    }

    if (cleanupError !== undefined) {
      if (primaryError === undefined) {
        primaryError = cleanupError;
      } else {
        process.stderr.write(
          `[Gate 1] 隔离资源清理失败：${cleanupError instanceof Error ? cleanupError.message : "未知错误"}\n`,
        );
      }
    }
  }

  if (primaryError !== undefined) throw primaryError;
  if (receivedSignal !== undefined) throw new Error(`收到 ${receivedSignal}，已完成隔离资源清理`);
  process.stdout.write("\n[Gate 1] 查询/数据切片的隔离空库、基础浏览器冒烟与性能验证通过\n");
}

await verify().catch((error) => {
  const message = error instanceof Error ? error.message : "未知 Gate 1 隔离验证错误";
  process.stderr.write(`[Gate 1] 验证失败：${message}\n`);
  process.exitCode = receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGTERM" ? 143 : 1;
});
