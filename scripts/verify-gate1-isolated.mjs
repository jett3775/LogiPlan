import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import { childHasStopped, terminateProcessTree, waitForServer } from "./wait-for-server.mjs";

const projectName = `logiplan-gate1-${process.pid}-${randomBytes(4).toString("hex")}`;
const projectNamePattern = /^logiplan-gate1-[a-z0-9-]+$/u;
const temporaryMigrationPrefix = "logiplan-gate1-migrations-";
const gate1MigrationFiles = [
  "0001_gate1_schema.sql",
  "0002_release_reactivation.sql",
  "0003_schema_version_reader.sql",
];
const upgradedV2ReleaseId = "LOGIPLAN_2026_DEMO_V2";

if (!projectNamePattern.test(projectName) || projectName === "logiplan") {
  throw new Error("隔离 Compose 项目名无效");
}

// 定向重复模式：未设置 LOGIPLAN_GATE1_TARGET 与 LOGIPLAN_GATE1_REPEAT 时，
// 步骤集合、子进程调用与耗时特征与既有全量 Gate 1 完全一致。
// LOGIPLAN_GATE1_TARGET=firefox|snapshot 只运行该目标所需的步骤；
// LOGIPLAN_GATE1_REPEAT=N 对目标套件串行调用 N 次（逐次退出码、耗时与失败阶段）。
const targetModes = ["full", "firefox", "snapshot"];
const firefoxTargetCommand = ["test:e2e:firefox-smoke"];
const snapshotTargetFile = "packages/db/src/evidence-snapshot.test.ts";
const snapshotTargetTestName =
  "preserves historical release evidence across both Chromium viewports";

let gate1Target = "full";
let gate1Repeat = 1;
let timelineFile;
let timelineStartMs = Date.now();
let timelineIteration = 0;

function configureTargetMode(environment) {
  const rawTarget = (environment.LOGIPLAN_GATE1_TARGET ?? "").trim();
  gate1Target = rawTarget === "" ? "full" : rawTarget;
  if (!targetModes.includes(gate1Target)) {
    throw new Error(
      `LOGIPLAN_GATE1_TARGET 无效：「${gate1Target}」；只允许 ${targetModes.join("、")}`,
    );
  }
  const rawRepeat = (environment.LOGIPLAN_GATE1_REPEAT ?? "").trim();
  if (rawRepeat === "") {
    gate1Repeat = 1;
  } else {
    gate1Repeat = Number(rawRepeat);
    if (!Number.isSafeInteger(gate1Repeat) || gate1Repeat < 1) {
      throw new Error(`LOGIPLAN_GATE1_REPEAT 无效：「${rawRepeat}」；只允许正整数`);
    }
  }
  if (gate1Target === "full" && gate1Repeat > 1) {
    throw new Error(
      "LOGIPLAN_GATE1_REPEAT 只对定向目标有效；重复运行请设置 LOGIPLAN_GATE1_TARGET=firefox 或 snapshot",
    );
  }
  timelineStartMs = Date.now();
  timelineFile = resolveTimelineFile(environment);
}

// 时间线是常驻诊断能力：默认不写文件；仅在设置了 LOGIPLAN_GATE1_TIMELINE_FILE
// 或处于定向重复模式时写入。每行一个 JSON 对象，字段为 iteration/event/at_ms/detail。
function resolveTimelineFile(environment) {
  const configured = (environment.LOGIPLAN_GATE1_TIMELINE_FILE ?? "").trim();
  const diagnosticsRequested = configured !== "" || gate1Target !== "full" || gate1Repeat > 1;
  if (!diagnosticsRequested) return undefined;
  const file =
    configured === "" ? join(tmpdir(), `logiplan-gate1-timeline-${process.pid}.jsonl`) : configured;
  try {
    writeFileSync(file, "");
    return file;
  } catch (error) {
    process.stderr.write(
      `[Gate 1] 时间线文件不可写，已关闭埋点：${error instanceof Error ? error.message : "未知错误"}\n`,
    );
    return undefined;
  }
}

function recordTimeline(event, detail) {
  if (timelineFile === undefined) return;
  try {
    appendFileSync(
      timelineFile,
      `${JSON.stringify({
        iteration: timelineIteration,
        event,
        at_ms: Date.now() - timelineStartMs,
        detail: detail ?? null,
      })}\n`,
    );
  } catch {
    // 诊断埋点不得改变 Gate 1 结果。
  }
}

function timelineEnvironmentFor(iteration) {
  if (timelineFile === undefined) return {};
  return {
    LOGIPLAN_GATE1_TIMELINE_FILE: timelineFile,
    LOGIPLAN_GATE1_ITERATION: String(iteration),
  };
}

function readIterationFailure(iteration) {
  if (timelineFile === undefined) return undefined;
  let content;
  try {
    content = readFileSync(timelineFile, "utf8");
  } catch {
    return undefined;
  }
  let latest;
  for (const line of content.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.iteration !== iteration || entry.event !== "failure") continue;
    latest = entry.detail;
  }
  return latest === undefined || latest === null ? undefined : latest;
}

// 全量模式（full）始终执行全部步骤；定向模式只执行目标列出的步骤。
// 传空列表表示「仅 full 执行」，用于脚本测试腿、其它浏览器套件与性能验证。
function runsForTarget(modes) {
  return gate1Target === "full" || modes.includes(gate1Target);
}

function skipTargetStep(label) {
  process.stdout.write(`[Gate 1] 定向模式跳过（目标=${gate1Target}）：${label}\n`);
}

function formatDurationSeconds(durationMs) {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function reportTargetIteration(target, iteration, outcome, failure) {
  const failed = outcome.error !== undefined;
  const stage = failure?.stage;
  const stageText =
    stage === undefined
      ? failed
        ? "未知（子进程失败但时间线未记录 failure 事件）"
        : "无"
      : String(stage);
  process.stdout.write(
    `[Gate 1] 定向重复结果 目标=${target} 迭代=${iteration}/${gate1Repeat} ` +
      `退出码=${String(outcome.exitCode)} 耗时=${formatDurationSeconds(outcome.durationMs)} ` +
      `失败阶段=${stageText}${failed ? ` 原因=${outcome.error.message}` : ""}\n`,
  );
}

function summariseTargetIterations(target, outcomes) {
  // outcomes 的元素是 { iteration, outcome, failure } 包装对象；
  // 逐次耗时与失败标记都在 entry.outcome 上（见 reportTargetIteration 的入参）。
  const failedCount = outcomes.filter((entry) => entry.outcome.error !== undefined).length;
  const totalMs = outcomes.reduce((sum, entry) => sum + entry.outcome.durationMs, 0);
  process.stdout.write(
    `\n[Gate 1] 定向重复汇总 目标=${target} 迭代=${outcomes.length} ` +
      `通过=${outcomes.length - failedCount} 失败=${failedCount} ` +
      `总耗时=${formatDurationSeconds(totalMs)}\n`,
  );
  if (failedCount > 0) {
    throw new Error(
      `${target} 定向重复 ${outcomes.length} 次中 ${failedCount} 次失败，` +
        "逐次退出码、耗时与失败阶段见上方「定向重复结果」行",
    );
  }
}

const localPasswords = {
  superuser: randomBytes(24).toString("hex"),
  migrator: randomBytes(24).toString("hex"),
  publisher: randomBytes(24).toString("hex"),
  reader: randomBytes(24).toString("hex"),
};

let activeChild;
let activeServerChild;
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
  "LOGIPLAN_PUBLISH_MODE",
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

async function reserveLocalAppPort(excludedPorts) {
  const excluded = new Set(excludedPorts);
  for (let port = 4174; port <= 4194; port += 1) {
    if (excluded.has(port)) continue;
    try {
      await new Promise((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        });
      });
      return port;
    } catch {
      // Try the next dedicated local application port.
    }
  }
  throw new Error("无法分配隔离快照 API 本地端口");
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
  // capture 模式用于定向重复：单次失败不抛出，交给逐次汇总决定整体退出码。
  const capture = options.capture === true;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      shell: options.shell ?? false,
      detached: process.platform !== "win32",
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
      if (error === undefined) {
        resolve(
          capture
            ? {
                exitCode: child.exitCode,
                signal: child.signalCode,
                durationMs: Date.now() - startedAt,
                timedOut: false,
                error: undefined,
              }
            : undefined,
        );
        return;
      }
      if (capture) {
        resolve({
          exitCode: child.exitCode,
          signal: child.signalCode,
          durationMs: Date.now() - startedAt,
          timedOut,
          error,
        });
        return;
      }
      reject(error);
    };

    if (options.timeoutMs !== undefined) {
      const killGraceMs = options.killGraceMs ?? 2_000;
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child, "SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (settled) return;
          terminateProcessTree(child, "SIGKILL");
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

function waitForChildExit(child, timeoutMs) {
  if (childHasStopped(child)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error("本地 API 服务未在限定时间内退出"));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopServer(child) {
  if (childHasStopped(child)) return;
  terminateProcessTree(child, "SIGTERM");
  try {
    await waitForChildExit(child, 5_000);
  } catch {
    if (childHasStopped(child)) return;
    terminateProcessTree(child, "SIGKILL");
    await waitForChildExit(child, 5_000);
  }
}

function startSnapshotServer(appUrl, appEnv) {
  process.stdout.write("\n[Gate 1] 启动快照集成本地 API\n");
  const server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      new URL(appUrl).port,
    ],
    {
      cwd: resolve("apps/web"),
      env: appEnv,
      shell: false,
      detached: process.platform !== "win32",
      stdio: "inherit",
      windowsHide: true,
    },
  );
  activeServerChild = server;
  return server;
}

async function stopSnapshotServer(server) {
  try {
    await stopServer(server);
  } finally {
    if (childHasStopped(server) && activeServerChild === server) activeServerChild = undefined;
  }
}

async function runSnapshotIntegration(appUrl, appEnv, testEnv) {
  assertNotInterrupted();
  const server = startSnapshotServer(appUrl, appEnv);
  try {
    await waitForServer(`${appUrl}/api/health/live`, server);
    await runPnpm(
      "完整持久化证据 PostgreSQL/API/Chromium 集成测试",
      ["exec", "vitest", "run", "packages/db/src/evidence-snapshot.test.ts"],
      testEnv,
      { timeoutMs: 420_000 },
    );
  } finally {
    await stopSnapshotServer(server);
  }
}

// 定向快照目标：本地 API 只启动一次，随后对目标用例做 N 次独立 vitest 子进程调用。
// 逐次独立进程的理由：单次迭代的退出码、耗时与失败阶段必须可分别观测；
// 数据库状态跨迭代保留，但目标用例自身的计数按「本次迭代的 requestWindow + 活动发布」过滤，
// 因此重复执行不会与既有快照互相污染（详见交付说明）。
async function runSnapshotTargetIterations(appUrl, appEnv, testEnv) {
  assertNotInterrupted();
  const server = startSnapshotServer(appUrl, appEnv);
  const outcomes = [];
  try {
    await waitForServer(`${appUrl}/api/health/live`, server);
    recordTimeline("snapshot_server_ready", { url: appUrl, health_path: "/api/health/live" });
    for (let iteration = 1; iteration <= gate1Repeat; iteration += 1) {
      timelineIteration = iteration;
      recordTimeline("iteration_start", { target: "snapshot", repeat: gate1Repeat });
      const outcome = await runPnpm(
        `证据快照目标用例（目标=snapshot，迭代 ${iteration}/${gate1Repeat}）`,
        ["exec", "vitest", "run", snapshotTargetFile, "-t", snapshotTargetTestName],
        { ...testEnv, ...timelineEnvironmentFor(iteration) },
        { capture: true, timeoutMs: 420_000 },
      );
      const failure = readIterationFailure(iteration);
      outcomes.push({ iteration, outcome, failure });
      reportTargetIteration("snapshot", iteration, outcome, failure);
    }
  } finally {
    await stopSnapshotServer(server);
  }
  summariseTargetIterations("snapshot", outcomes);
}

// 定向 Firefox 目标：每次迭代是独立的 Playwright 调用，因此每次都是冷启动的 next 服务，
// 与「首次导航超时」的现场一致；--repeat-each 无法给出逐次退出码与冷启动现场。
async function runFirefoxTargetIterations(baseEnv) {
  const outcomes = [];
  for (let iteration = 1; iteration <= gate1Repeat; iteration += 1) {
    timelineIteration = iteration;
    recordTimeline("iteration_start", { target: "firefox", repeat: gate1Repeat });
    const outcome = await runPnpm(
      `Firefox 核心冒烟（目标=firefox，迭代 ${iteration}/${gate1Repeat}）`,
      firefoxTargetCommand,
      { ...baseEnv, ...timelineEnvironmentFor(iteration) },
      { capture: true, timeoutMs: 240_000 },
    );
    const failure = readIterationFailure(iteration);
    outcomes.push({ iteration, outcome, failure });
    reportTargetIteration("firefox", iteration, outcome, failure);
  }
  summariseTargetIterations("firefox", outcomes);
}

function runPnpm(label, args, env, options = {}) {
  const invocation = pnpmInvocation(args);
  return runProcess(label, invocation.command, invocation.args, env, {
    ...options,
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
    terminateProcessTree(activeChild, receivedSignalCount > 1 ? "SIGKILL" : signal);
  }
  if (!cleanupStarted && activeServerChild !== undefined) {
    terminateProcessTree(activeServerChild, receivedSignalCount > 1 ? "SIGKILL" : signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => handleSignal(signal));
}

async function verify() {
  configureTargetMode(process.env);
  recordTimeline("run_start", { target: gate1Target, repeat: gate1Repeat, pid: process.pid });
  const postgresPort = await reserveEphemeralPort();
  let performancePort = await reserveEphemeralPort();
  while (performancePort === postgresPort) {
    performancePort = await reserveEphemeralPort();
  }
  const snapshotAppPort = await reserveLocalAppPort([postgresPort, performancePort]);
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
  const publisherValidateOnlyEnv = {
    ...publisherEnv,
    LOGIPLAN_PUBLISH_MODE: "validate-only",
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
  };
  const snapshotAppUrl = `http://127.0.0.1:${snapshotAppPort}`;
  const snapshotSuperuserUrl = roleUrl("postgres", localPasswords.superuser);
  const snapshotTestEnv = {
    ...readerRuntimeEnv,
    SNAPSHOT_TEST_SUPERUSER_URL: snapshotSuperuserUrl,
    SNAPSHOT_TEST_DATABASE_URL: readerUrl,
    SNAPSHOT_TEST_MIGRATION_URL: migrationUrl,
    SNAPSHOT_TEST_PUBLISHER_URL: publisherUrl,
    SNAPSHOT_TEST_API_URL: snapshotAppUrl,
  };
  const historicalEvidenceTestEnv = {
    ...readerRuntimeEnv,
    SNAPSHOT_TEST_SUPERUSER_URL: snapshotSuperuserUrl,
  };

  let temporaryMigrationDirectory;
  let primaryError;
  try {
    if (runsForTarget([])) {
      await runPnpm(
        "数据库集成测试（真实角色事务与 ACL，PostgreSQL 18.4 与 18.6）",
        ["test:db-integration"],
        guardedEnvironment,
        { timeoutMs: 900_000 },
      );
    } else {
      skipTargetStep("数据库集成测试（真实角色事务与 ACL，PostgreSQL 18.4 与 18.6）");
    }
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

    await runCompose("启动隔离 PostgreSQL 18.4", ["up", "-d", "--wait"], composeEnv, {
      timeoutMs: 420_000,
    });
    await runPnpm("从零执行 0001—0003 迁移", ["db:migrate"], v1MigrationEnv);
    await runProcess(
      "使用测试专用 harness 发布 0003 基线 V1 数据",
      process.execPath,
      ["--import", "tsx", "scripts/publish-gate1-v1-baseline.ts"],
      v1PublisherEnv,
    );
    await runPnpm("从 0003 升级执行完整迁移", ["db:migrate"], migrationEnv);
    await runPnpm("导入并校验 V2 候选但不激活", ["db:publish"], publisherValidateOnlyEnv);
    await runPnpm("重复校验 VALIDATED V2 候选", ["db:publish"], publisherValidateOnlyEnv);
    await runPnpm(
      "显式激活 V2 并原子物化固定证据",
      ["db:activate-release", upgradedV2ReleaseId],
      publisherEnv,
    );
    await runPnpm("重复发布幂等验证", ["db:publish"], publisherEnv);
    await runPnpm("结构、精度与三角色权限验证", ["db:verify"], verificationEnv);
    await runPnpm("不可变发布升级与核心查询验证", ["db:verify-release"], releaseVerificationEnv);
    await runPnpm("核心查询计划验证", ["db:verify-plans"], readerRuntimeEnv);
    await runPnpm("生产构建", ["build"], readerRuntimeEnv, { timeoutMs: 420_000 });
    if (runsForTarget(["snapshot"])) {
      if (gate1Target === "snapshot") {
        await runSnapshotTargetIterations(snapshotAppUrl, readerRuntimeEnv, snapshotTestEnv);
      } else {
        await runSnapshotIntegration(snapshotAppUrl, readerRuntimeEnv, {
          ...snapshotTestEnv,
          ...timelineEnvironmentFor(1),
        });
      }
    } else {
      skipTargetStep("完整持久化证据 PostgreSQL/API/Chromium 集成测试");
    }
    if (runsForTarget([])) {
      await runPnpm("Chromium 双视口基础冒烟", ["test:e2e:gate1"], readerRuntimeEnv, {
        timeoutMs: 300_000,
      });
      await runPnpm(
        "Chromium 双视口历史证据验收",
        [
          "exec",
          "playwright",
          "test",
          "--project=chromium-1440",
          "--project=chromium-1280",
          "--workers=1",
          "apps/web/tests/historical-evidence.spec.ts",
        ],
        historicalEvidenceTestEnv,
        { timeoutMs: 300_000 },
      );
    } else {
      skipTargetStep("Chromium 双视口基础冒烟");
      skipTargetStep("Chromium 双视口历史证据验收");
    }
    if (runsForTarget(["firefox"])) {
      if (gate1Target === "firefox") {
        await runFirefoxTargetIterations({ ...readerRuntimeEnv });
      } else {
        await runPnpm(
          "Firefox 核心冒烟",
          firefoxTargetCommand,
          { ...readerRuntimeEnv, ...timelineEnvironmentFor(1) },
          { timeoutMs: 240_000 },
        );
      }
    } else {
      skipTargetStep("Firefox 核心冒烟");
    }
    if (runsForTarget([])) {
      await runProcess(
        "并发 5、100 次热查询性能验证",
        process.execPath,
        ["scripts/verify-query-performance.mjs"],
        readerRuntimeEnv,
        { timeoutMs: 240_000 },
      );
    } else {
      skipTargetStep("并发 5、100 次热查询性能验证");
    }
  } catch (error) {
    primaryError = error;
  } finally {
    cleanupStarted = true;
    let cleanupError;
    try {
      if (activeServerChild !== undefined) {
        const server = activeServerChild;
        try {
          await stopServer(server);
        } finally {
          if (childHasStopped(server) && activeServerChild === server)
            activeServerChild = undefined;
        }
      }
    } catch (error) {
      cleanupError = error;
    }
    try {
      await runCompose(
        "清理本次隔离 PostgreSQL 项目与命名卷",
        ["down", "-v", "--remove-orphans"],
        composeEnv,
        { cleanup: true, timeoutMs: 30_000, killGraceMs: 2_000 },
      );
    } catch (error) {
      if (cleanupError === undefined) cleanupError = error;
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
  recordTimeline("run_end", { target: gate1Target, repeat: gate1Repeat, outcome: "passed" });
  if (timelineFile !== undefined) {
    process.stdout.write(`\n[Gate 1] 诊断时间线文件：${timelineFile}\n`);
  }
  process.stdout.write("\n[Gate 1] 查询/数据切片的隔离空库、基础浏览器冒烟与性能验证通过\n");
}

await verify().catch((error) => {
  const message = error instanceof Error ? error.message : "未知 Gate 1 隔离验证错误";
  recordTimeline("run_end", { target: gate1Target, repeat: gate1Repeat, outcome: "failed" });
  if (timelineFile !== undefined) {
    process.stderr.write(`[Gate 1] 诊断时间线文件：${timelineFile}\n`);
  }
  process.stderr.write(`[Gate 1] 验证失败：${message}\n`);
  process.exitCode = receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGTERM" ? 143 : 1;
});
