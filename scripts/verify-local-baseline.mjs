#!/usr/bin/env node
// 本机环境基线检查：把 CI `cross-platform` job 的检查项在本地一次跑完并汇总，
// 供「本地环境基线」记录使用。平台中立——macOS / Windows / Linux 用同一条命令。
//
// 用法（两端一致）：
//   node scripts/verify-local-baseline.mjs
//
// 说明：
// - 只编排既有命令，不复制任何检查逻辑；每步都是 `pnpm format:check` 等仓库自带入口。
// - 不设置 CI 变量：这是**本地**基线，须保留本地语义（与 CI 的对照由结果差异发现）。
// - 本文件不在 neon-baseline 的执行闭包内，改动它不影响已冻结的工具 SHA。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scriptTestFiles = Object.freeze([
  "scripts/neon-baseline.test.mjs",
  "scripts/neon-permission-audit.test.mjs",
  "scripts/verify-gate1-isolated.test.mjs",
]);

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const steps = Object.freeze([
  { name: "prettier 格式检查", command: pnpmCommand, args: ["format:check"] },
  { name: "eslint", command: pnpmCommand, args: ["lint"] },
  { name: "类型检查", command: pnpmCommand, args: ["typecheck"] },
  { name: "单元测试（vitest）", command: pnpmCommand, args: ["test"] },
  {
    name: "脚本测试（node --test）",
    command: process.execPath,
    args: ["--test", ...scriptTestFiles],
  },
]);

function readExpectedNodeVersion() {
  try {
    return readFileSync(fileURLToPath(new URL("../.nvmrc", import.meta.url)), "utf8").trim();
  } catch {
    return undefined;
  }
}

function compareVersions(actual, expected) {
  const parse = (value) => value.split(".").map((part) => Number.parseInt(part, 10));
  const [actualMajor, actualMinor, actualPatch] = parse(actual);
  const [expectedMajor, expectedMinor, expectedPatch] = parse(expected);
  if ([actualMajor, actualMinor, actualPatch].some(Number.isNaN)) return "unknown";
  if (actualMajor !== expectedMajor) return actualMajor < expectedMajor ? "lower" : "higher";
  if (actualMinor !== expectedMinor) return actualMinor < expectedMinor ? "lower" : "higher";
  if (actualPatch !== expectedPatch) return actualPatch < expectedPatch ? "lower" : "higher";
  return "equal";
}

// 从测试框架输出里取计数行；取不到时返回 undefined，由调用方原样保留输出尾行供人工判读。
// 计数前先剥离 ANSI 颜色码：vitest 与 node --test 在有 TTY 时都会插入转义序列。
function countFrom(output, pattern) {
  const plain = output.replace(/\u001b\[[0-9;]*m/gu, "");
  const match = pattern.exec(plain);
  return match === null ? undefined : match.slice(1).join(" / ");
}

function runStep(step) {
  const startedAt = Date.now();
  process.stdout.write(`▶ ${step.name} … `);
  const result = spawnSync(step.command, step.args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - startedAt;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const passed = result.status === 0 && result.error === undefined;
  process.stdout.write(`${passed ? "✔" : "✗"} ${(durationMs / 1000).toFixed(1)}s\n`);

  if (!passed) {
    const tail = output.trimEnd().split("\n").slice(-20).join("\n");
    process.stdout.write(`${tail}\n`);
    if (result.error !== undefined) {
      process.stdout.write(`启动失败：${result.error.message}\n`);
    }
  }
  return { name: step.name, passed, durationMs, status: result.status, output };
}

function summarizeCounts(results) {
  const scriptTests = results.find(({ name }) => name.startsWith("脚本测试"));
  const unitTests = results.find(({ name }) => name.startsWith("单元测试"));
  return {
    script:
      scriptTests === undefined
        ? undefined
        : countFrom(
            scriptTests.output,
            /tests (\d+)[\s\S]*?pass (\d+)[\s\S]*?fail (\d+)[\s\S]*?skipped (\d+)/u,
          ),
    unit:
      unitTests === undefined
        ? undefined
        : countFrom(
            unitTests.output,
            /Tests\s+(\d+) passed(?:\s*\|\s*(\d+) skipped)?\s*\((\d+)\)/u,
          ),
  };
}

function main() {
  const expectedNode = readExpectedNodeVersion();
  const actualNode = process.versions.node;
  const relation =
    expectedNode === undefined ? "unknown" : compareVersions(actualNode, expectedNode);

  const pnpmProbe = spawnSync(pnpmCommand, ["--version"], { encoding: "utf8", windowsHide: true });
  const pnpmVersion =
    pnpmProbe.status === 0
      ? pnpmProbe.stdout.trim()
      : `不可用（${pnpmProbe.error?.message ?? "pnpm --version 失败"}）`;

  process.stdout.write(`平台：${process.platform} ${process.arch}\n`);
  process.stdout.write(
    `Node：${actualNode}${expectedNode === undefined ? "" : `（.nvmrc=${expectedNode}）`}\n`,
  );
  process.stdout.write(`pnpm：${pnpmVersion}\n\n`);

  if (relation === "lower") {
    process.stdout.write(
      `✗ Node 版本低于 .nvmrc 的 ${expectedNode}；.npmrc 的 engine-strict=true 会拒绝安装，先切换版本再跑。\n`,
    );
    process.exit(2);
  }
  if (relation === "higher") {
    process.stdout.write(
      `⚠ Node 版本高于 .nvmrc 的 ${expectedNode}（engines 允许 <25，但本机与 CI 不完全一致）。\n`,
    );
  }
  if (pnpmProbe.status !== 0) {
    process.stdout.write("✗ 未找到 pnpm；先执行 corepack enable。\n");
    process.exit(2);
  }

  const results = steps.map(runStep);
  const counts = summarizeCounts(results);

  process.stdout.write("\n=== 本机环境基线汇总（可直接粘贴入档）===\n");
  process.stdout.write(
    `平台：${process.platform} ${process.arch}；Node ${actualNode}；pnpm ${pnpmVersion}\n`,
  );
  for (const result of results) {
    process.stdout.write(
      `${result.passed ? "通过" : "失败"} | ${result.name} | ${(result.durationMs / 1000).toFixed(1)}s\n`,
    );
  }
  if (counts.script !== undefined) {
    process.stdout.write(`脚本测试计数（tests / pass / fail / skipped）：${counts.script}\n`);
  }
  if (counts.unit !== undefined) {
    process.stdout.write(`单元测试计数（passed / skipped / total）：${counts.unit}\n`);
  }

  const failed = results.filter(({ passed }) => !passed);
  if (failed.length > 0) {
    process.stdout.write(
      `\n结论：${failed.length} 项失败（${failed.map(({ name }) => name).join("、")}）。\n`,
    );
    process.exit(1);
  }
  process.stdout.write("\n结论：全部通过。下一步（可选，需 Docker）：pnpm verify:gate1:isolated\n");
  process.exit(0);
}

main();
