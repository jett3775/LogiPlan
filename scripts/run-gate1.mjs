#!/usr/bin/env node
// Gate 1 定向重复运行器：把命令行参数翻译成编排脚本既有的环境变量，
// 使 Windows 与 macOS 用同一条命令即可复现，避免 `$env:VAR = ...` 与 `VAR=...` 的平台差异。
//
// 用法（两端一致）：
//   node scripts/run-gate1.mjs --target firefox --repeat 20 [--timeline <路径>]
//
// 说明：
// - 只做参数翻译与进程启动，不复制编排逻辑；实际编排仍由 scripts/verify-gate1-isolated.mjs 负责。
// - 本文件**不在** neon-baseline 的执行闭包内，改动它不影响已冻结的工具 SHA。
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const gate1Targets = Object.freeze(["firefox", "snapshot"]);
const optionsWithValues = Object.freeze(["--target", "--repeat", "--timeline"]);
const defaultTimelineFile = "gate1-timeline.jsonl";

function readValue(argv, index) {
  const argument = argv[index];
  const separatorIndex = argument.indexOf("=");
  if (separatorIndex !== -1) {
    return { value: argument.slice(separatorIndex + 1), consumed: 0 };
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith("--")) {
    throw new Error(`${argument} 缺少取值`);
  }
  return { value: next, consumed: 1 };
}

export function parseGate1Arguments(argv) {
  const options = { target: "firefox", repeat: "20", timelineFile: defaultTimelineFile };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const name = argument.split("=")[0];
    if (!optionsWithValues.includes(name)) {
      throw new Error(`未知参数：${argument}（支持 --target、--repeat、--timeline）`);
    }
    const { value, consumed } = readValue(argv, index);
    index += consumed;
    if (name === "--target") options.target = value.trim();
    if (name === "--repeat") options.repeat = value.trim();
    if (name === "--timeline") options.timelineFile = value.trim();
  }

  if (!gate1Targets.includes(options.target)) {
    throw new Error(`--target 只接受 ${gate1Targets.join("、")}；收到「${options.target}」`);
  }
  if (!/^\d+$/u.test(options.repeat) || Number(options.repeat) < 1) {
    throw new Error(`--repeat 只接受正整数；收到「${options.repeat}」`);
  }
  if (options.timelineFile === "") {
    throw new Error("--timeline 不能为空");
  }
  return options;
}

export function toGate1Environment(options, baseEnvironment = process.env) {
  return {
    ...baseEnvironment,
    LOGIPLAN_GATE1_TARGET: options.target,
    LOGIPLAN_GATE1_REPEAT: options.repeat,
    LOGIPLAN_GATE1_TIMELINE_FILE: resolve(options.timelineFile),
  };
}

function main() {
  const orchestrationScript = fileURLToPath(
    new URL("./verify-gate1-isolated.mjs", import.meta.url),
  );

  let options;
  try {
    options = parseGate1Arguments(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "参数解析失败";
    process.stderr.write(
      `${message}\n用法：node scripts/run-gate1.mjs --target firefox|snapshot --repeat N [--timeline 路径]\n`,
    );
    process.exit(2);
  }

  // 复现口径必须能进日志：把解析后的目标、次数与时间线文件先写一行到 stderr，
  // 与编排脚本自身的逐次输出分开，便于事后从日志还原「这次到底跑的是什么」。
  process.stderr.write(
    `[Gate 1] 定向重复：target=${options.target} repeat=${options.repeat} ` +
      `timeline=${resolve(options.timelineFile)}\n`,
  );

  const child = spawn(process.execPath, [orchestrationScript], {
    stdio: "inherit",
    env: toGate1Environment(options),
    windowsHide: true,
  });

  child.once("error", (error) => {
    process.stderr.write(`Gate 1 编排脚本启动失败：${error.message}\n`);
    process.exit(1);
  });
  child.once("exit", (code, signal) => {
    if (signal !== null) {
      process.stderr.write(`Gate 1 编排脚本被信号终止：${signal}\n`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
