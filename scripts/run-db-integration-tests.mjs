import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import process from "node:process";

import { terminateProcessTree } from "./wait-for-server.mjs";

// 数据库集成验收入口：普通 `pnpm test`（Vitest）不拉起 Docker，也不执行真实 ACL SQL；
// 真实 PostgreSQL 的角色事务与 ACL 用例只能由本入口执行。
//
// skip 口径：每条腿必须零 fail，且 skipped 必须**精确等于**该文件显式声明的平台门控
// 跳过数（见 platformGatedSkipsByFile）。未声明的 skip 一律判失败，因此既不允许把跳过
// 当作通过，也不允许声明过期后继续放行。
const defaultImages = Object.freeze(["postgres:18.4", "postgres:18.6"]);
const supportedImagePattern = /^postgres:18\.(?:4|6)$/u;
const roleBootstrapContainerNamePattern = /^logiplan-role-bootstrap-test-\d+-[0-9a-f]{16}$/u;
const aclBaselineContainerNamePattern = /^logiplan-acl-baseline-test-\d+-[0-9a-f]{16}$/u;
const legTimeoutMs = 900_000;
const dockerProbeTimeoutMs = 60_000;
const containerCleanupTimeoutMs = 60_000;
const dockerUnavailableMessage =
  "前置条件不满足：Docker 不可用，数据库集成验收不能以 skip 计为通过";

// 平台门控用例的显式声明表：只登记「在特定平台上必然被跳过」的用例数量。
// 每个被本入口执行的测试文件都必须在此登记，否则 expectedPlatformSkipsFor 直接抛错。
// 声明值是精确匹配：声明 1 而实际 0 同样判失败，避免声明过期后继续放行。
const platformGatedSkipsByFile = Object.freeze({
  // scripts/neon-baseline.test.mjs:1272
  //   const runPowerShellPassthroughTest = process.platform === "win32";
  // 用例「PowerShell 入口原样透传 Node 退出码」验证 Windows 专有的
  // scripts/neon-baseline.ps1 入口，且 powershellHosts() 只探测 Windows 路径
  // （%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe 与
  // %ProgramFiles%\PowerShell\7\pwsh.exe），因此在 POSIX 上必然跳过 1 条。
  "scripts/neon-baseline.test.mjs": process.platform === "win32" ? 0 : 1,
  "scripts/neon-permission-audit.test.mjs": 0,
  "scripts/verify-gate1-isolated.test.mjs": 0,
});

function expectedPlatformSkipsFor(file) {
  const declared = platformGatedSkipsByFile[file];
  if (declared === undefined) {
    throw new Error(
      `测试文件「${file}」未在 platformGatedSkipsByFile 中登记平台门控跳过数，拒绝执行`,
    );
  }
  return declared;
}

let activeChild;
let receivedSignal;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    receivedSignal = signal;
    if (activeChild !== undefined) terminateProcessTree(activeChild, signal);
  });
}

function imagesFromEnvironment(environment) {
  const configured = environment.LOGIPLAN_DB_INTEGRATION_IMAGES;
  const images =
    configured === undefined || configured.trim() === ""
      ? [...defaultImages]
      : configured
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value !== "");
  if (images.length === 0) {
    throw new Error("LOGIPLAN_DB_INTEGRATION_IMAGES 未包含任何镜像");
  }
  for (const image of images) {
    if (!supportedImagePattern.test(image)) {
      throw new Error(`不支持 PostgreSQL 镜像「${image}」：只允许 postgres:18.4 与 postgres:18.6`);
    }
  }
  return images;
}

function dockerCli(environment) {
  return environment.DOCKER_CLI || (process.platform === "win32" ? "docker.exe" : "docker");
}

// 异步 spawn：本仓库环境不允许同步启动加管道（EBUSY），因此所有子进程都必须异步启动。
function runCommand(command, args, environment, options) {
  const { echo, timeoutMs } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: environment,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    activeChild = child;
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let forceKillTimer;
    const timeoutTimer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminateProcessTree(child, "SIGTERM");
            forceKillTimer = setTimeout(() => {
              if (!settled) terminateProcessTree(child, "SIGKILL");
            }, 5_000);
          }, timeoutMs);

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (activeChild === child) activeChild = undefined;
      if (error === undefined) {
        resolve({
          exitCode: child.exitCode,
          signal: child.signalCode,
          stdout,
          stderr,
          timedOut,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      reject(error);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (echo) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (echo) process.stderr.write(chunk);
    });
    child.once("error", (error) => {
      finish(new Error(`无法启动 ${command}：${error.message}`, { cause: error }));
    });
    child.once("exit", () => finish());
  });
}

async function dockerServerVersion(environment) {
  let result;
  try {
    result = await runCommand(
      dockerCli(environment),
      ["version", "--format", "{{.Server.Version}}"],
      environment,
      { echo: false, timeoutMs: dockerProbeTimeoutMs },
    );
  } catch (error) {
    process.stderr.write(
      `[DB 集成] Docker 探测失败：${error instanceof Error ? error.message : "未知错误"}\n`,
    );
    return undefined;
  }
  if (result.exitCode !== 0 || result.stdout.trim() === "") {
    const detail = result.stderr.trim().split(/\r?\n/u).at(-1) ?? "";
    process.stderr.write(
      `[DB 集成] Docker 探测失败（退出码=${String(result.exitCode)}）：${detail}\n`,
    );
    return undefined;
  }
  return result.stdout.trim();
}

function buildLegs(environment, images) {
  const legs = [];
  const neonBaselineFile = "scripts/neon-baseline.test.mjs";
  for (const image of images) {
    const roleBootstrapContainerName = `logiplan-role-bootstrap-test-${process.pid}-${randomBytes(8).toString("hex")}`;
    const aclBaselineContainerName = `logiplan-acl-baseline-test-${process.pid}-${randomBytes(8).toString("hex")}`;
    if (
      !roleBootstrapContainerNamePattern.test(roleBootstrapContainerName) ||
      !aclBaselineContainerNamePattern.test(aclBaselineContainerName)
    ) {
      throw new Error("生成的数据库集成测试容器名无效");
    }
    legs.push({
      label: `Neon 基线入口与真实角色/ACL 回归测试（${image}）`,
      image,
      expectedPlatformSkips: expectedPlatformSkipsFor(neonBaselineFile),
      args: ["--test", neonBaselineFile],
      // 容器名逐腿唯一，避免 18.4 与 18.6 两条腿复用同名容器而互相冲突。
      env: {
        ...environment,
        NEON_BASELINE_TEST_DOCKER: "1",
        NEON_BASELINE_TEST_POSTGRES_IMAGE: image,
        NEON_BASELINE_TEST_CONTAINER_NAME: roleBootstrapContainerName,
        NEON_BASELINE_ACL_TEST_CONTAINER_NAME: aclBaselineContainerName,
      },
    });
  }
  // 以下两个套件不接触 PostgreSQL 版本差异（只读诊断用替身客户端，本地 API 用例只测等待逻辑），
  // 因此与镜像无关，只运行一次；重复执行只会增加墙钟时间，不增加任何版本覆盖。
  for (const [label, file] of [
    ["Neon 权限只读诊断回归测试（与镜像无关）", "scripts/neon-permission-audit.test.mjs"],
    ["本地 API 服务等待逻辑回归测试（与镜像无关）", "scripts/verify-gate1-isolated.test.mjs"],
  ]) {
    legs.push({
      label,
      image: undefined,
      expectedPlatformSkips: expectedPlatformSkipsFor(file),
      args: ["--test", file],
      env: environment,
    });
  }
  return legs.map((leg, index) => ({ ...leg, order: index + 1 }));
}

const countPatterns = Object.freeze({
  tests: [/^# tests (\d+)$/u, /^ℹ tests (\d+)$/u],
  pass: [/^# pass (\d+)$/u, /^ℹ pass (\d+)$/u],
  fail: [/^# fail (\d+)$/u, /^ℹ fail (\d+)$/u],
  skipped: [/^# skipped (\d+)$/u, /^ℹ skipped (\d+)$/u],
});

function parseTestCounts(output) {
  const lines = output.split(/\r?\n/u);
  const counts = {};
  for (const [name, patterns] of Object.entries(countPatterns)) {
    let value;
    for (const line of lines) {
      for (const pattern of patterns) {
        const match = pattern.exec(line);
        if (match !== null) value = Number(match[1]);
      }
    }
    if (value !== undefined) counts[name] = value;
  }
  return counts;
}

function evaluateLeg(leg, result) {
  const counts = parseTestCounts(result.stdout);
  const reasons = [];
  if (result.timedOut) reasons.push(`超时（>${legTimeoutMs}ms）`);
  if (result.exitCode !== 0) {
    reasons.push(
      `退出码=${String(result.exitCode)}${result.signal === null ? "" : ` signal=${String(result.signal)}`}`,
    );
  }
  if (counts.tests === undefined || counts.fail === undefined || counts.skipped === undefined) {
    reasons.push("无法解析 tests/fail/skipped 计数，不得以未经证明的 skip 口径计为通过");
  } else {
    if (counts.fail > 0) reasons.push(`fail=${counts.fail}`);
    const expectedSkips = leg.expectedPlatformSkips;
    if (counts.skipped !== expectedSkips) {
      reasons.push(
        expectedSkips === 0
          ? `skipped=${counts.skipped}（该文件显式声明零平台门控跳过）`
          : `skipped=${counts.skipped}，与显式声明的平台门控跳过数 ${expectedSkips} 不一致`,
      );
    }
  }
  return { leg, counts, result, reasons, failed: reasons.length > 0 };
}

function formatCounts(counts) {
  return `tests=${counts.tests ?? "?"} pass=${counts.pass ?? "?"} fail=${counts.fail ?? "?"} skipped=${counts.skipped ?? "?"}`;
}

// 兜底清理：只清理本入口自己生成并已通过规则校验的容器名；
// 幂等（容器不存在视为已清理），任何失败只记录，不改变验收退出码。
async function removeContainerByName(environment, name) {
  try {
    const result = await runCommand(
      dockerCli(environment),
      ["rm", "--force", "--volumes", name],
      environment,
      { echo: false, timeoutMs: containerCleanupTimeoutMs },
    );
    const detail = (result.stderr.trim().split(/\r?\n/u).at(-1) ?? "").trim();
    if (result.exitCode === 0) {
      process.stdout.write(`[DB 集成] 兜底清理容器 ${name}（--force --volumes）完成\n`);
      return;
    }
    if (/No such container/iu.test(detail)) {
      process.stdout.write(`[DB 集成] 兜底清理容器 ${name}：容器不存在，视为已清理\n`);
      return;
    }
    process.stderr.write(
      `[DB 集成] 兜底清理容器 ${name} 未成功（退出码=${String(result.exitCode)}）：${detail}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[DB 集成] 兜底清理容器 ${name} 失败：${error instanceof Error ? error.message : "未知错误"}\n`,
    );
  }
}

async function removeIntegrationContainers(environment, legs) {
  const names = new Set();
  for (const leg of legs) {
    for (const [key, pattern] of [
      ["NEON_BASELINE_TEST_CONTAINER_NAME", roleBootstrapContainerNamePattern],
      ["NEON_BASELINE_ACL_TEST_CONTAINER_NAME", aclBaselineContainerNamePattern],
    ]) {
      const name = leg.env[key];
      if (name === undefined) continue;
      if (!pattern.test(name)) {
        process.stderr.write(`[DB 集成] 拒绝兜底清理未受控的容器名：${String(name)}\n`);
        continue;
      }
      names.add(name);
    }
  }
  for (const name of names) await removeContainerByName(environment, name);
}

function formatDuration(durationMs) {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function reportLeg(outcome) {
  const { leg, counts, result } = outcome;
  process.stdout.write(
    `[DB 集成] 腿 ${leg.order} 结果：镜像=${leg.image ?? "不适用"} ${formatCounts(counts)} ` +
      `耗时=${formatDuration(result.durationMs)} 退出码=${String(result.exitCode)}` +
      `${outcome.failed ? ` 判定=失败（${outcome.reasons.join("；")}）` : " 判定=通过"}\n`,
  );
}

async function main() {
  const environment = process.env;
  const images = imagesFromEnvironment(environment);
  const serverVersion = await dockerServerVersion(environment);
  if (serverVersion === undefined) {
    process.stderr.write(`[DB 集成] ${dockerUnavailableMessage}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `[DB 集成] Docker ${serverVersion} 可用；镜像腿：${images.join("、")}；每条腿超时 ${legTimeoutMs}ms\n`,
  );

  const legs = buildLegs(environment, images);
  const outcomes = [];
  try {
    for (const leg of legs) {
      if (receivedSignal !== undefined) break;
      process.stdout.write(`\n[DB 集成] 腿 ${leg.order}/${legs.length}：${leg.label}\n`);
      const result = await runCommand(process.execPath, leg.args, leg.env, {
        echo: true,
        timeoutMs: legTimeoutMs,
      });
      const outcome = evaluateLeg(leg, result);
      reportLeg(outcome);
      outcomes.push(outcome);
    }
  } finally {
    await removeIntegrationContainers(environment, legs);
  }

  const failed = outcomes.filter((outcome) => outcome.failed);
  const skippedTotal = outcomes.reduce((sum, outcome) => sum + (outcome.counts.skipped ?? 0), 0);
  const expectedSkipTotal = outcomes.reduce(
    (sum, outcome) => sum + outcome.leg.expectedPlatformSkips,
    0,
  );
  const durationTotal = outcomes.reduce((sum, outcome) => sum + outcome.result.durationMs, 0);
  process.stdout.write("\n[DB 集成] 汇总\n");
  for (const outcome of outcomes) {
    process.stdout.write(
      `[DB 集成]   腿 ${outcome.leg.order} 镜像=${outcome.leg.image ?? "不适用"} ${formatCounts(outcome.counts)} ` +
        `耗时=${formatDuration(outcome.result.durationMs)} 退出码=${String(outcome.result.exitCode)} ` +
        `判定=${outcome.failed ? "失败" : "通过"}\n`,
    );
  }

  if (receivedSignal !== undefined) {
    process.stderr.write(
      `[DB 集成] 收到 ${receivedSignal}，未执行完整套件，数据库集成验收不成立\n`,
    );
    process.exitCode = receivedSignal === "SIGINT" ? 130 : 143;
    return;
  }
  if (failed.length > 0 || outcomes.length !== legs.length) {
    process.stderr.write(
      `[DB 集成] 数据库集成验收失败：${String(failed.length)}/${String(legs.length)} 腿未通过，` +
        `合计 skipped=${String(skippedTotal)}（已显式声明的平台门控跳过 ${String(expectedSkipTotal)}）；` +
        "正式数据库验收要求零 fail，且 skipped 必须精确等于显式声明的平台门控跳过数，" +
        "不得把未声明的 skip 或未执行的腿计为通过\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `[DB 集成] ${String(outcomes.length)} 条腿全部零 fail，skipped 与显式声明的平台门控跳过数一致` +
      `（合计 skipped=${String(skippedTotal)}，已声明 ${String(expectedSkipTotal)}），` +
      `总耗时 ${formatDuration(durationTotal)}：` +
      `真实 PostgreSQL 角色事务与 ACL 查询已在 ${images.join("、")} 上执行，` +
      "只读诊断与本地 API 等待逻辑回归通过\n",
  );
}

await main().catch((error) => {
  const message = error instanceof Error ? error.message : "未知数据库集成验收错误";
  process.stderr.write(`[DB 集成] 无法执行数据库集成验收：${message}\n`);
  process.exitCode = 1;
});
