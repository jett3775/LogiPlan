import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 边界自证（1a 额外自证项）：
 *
 * 1. `packages/ai` 的**非测试源码**中不存在任何 `LIVE_GENERATED` 取值，
 *    即本切片没有任何产生真实生成回答的代码路径；
 * 2. `packages/ai` 不导入任何供应商 SDK 或外部依赖，只允许 workspace 契约包与
 *    已在锁文件中的通用库；
 * 3. `packages/ai` 不出现供应商专有标识。
 */

const SRC_DIR = import.meta.dirname;
const PACKAGE_ROOT = join(SRC_DIR, "..");

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });

/**
 * 相对 `src` 的 POSIX 风格路径。
 *
 * `join()` 在 Windows 上产出反斜杠，直接比较会让本文件在 Windows runner 上
 * 失败（CI run 37251048989 的 `Cross-platform checks (windows-latest)` 曾因此
 * 红过一次）。故统一归一化为 `/`，使断言与平台无关。
 */
const relative = (file: string): string =>
  file
    .slice(SRC_DIR.length + 1)
    .split(sep)
    .join("/");

const productionSources = sourceFiles(SRC_DIR)
  .filter((file) => !file.endsWith(".test.ts"))
  .map((file) => ({ file: relative(file), text: readFileSync(file, "utf8") }));

const IMPORT_SPECIFIER = /from\s+"([^"]+)"/gu;

describe("无 LIVE_GENERATED 产出路径", () => {
  it("非测试源码中零处出现 LIVE_GENERATED", () => {
    const offenders = productionSources
      .filter((source) => source.text.includes("LIVE_GENERATED"))
      .map((source) => source.file);
    expect(offenders).toEqual([]);
    expect(productionSources.length).toBeGreaterThanOrEqual(10);
  });

  it("答案类型只出现在固定示例出口与失败关闭决策中，取值恒为 FIXED_EXAMPLE", () => {
    const withAnswerType = productionSources
      .filter((source) => source.text.includes("answer_type") || source.text.includes("answerType"))
      .map((source) => source.file)
      .sort();
    expect(withAnswerType).toEqual(["fixed-example/fixed-example.ts", "gateway/fail-closed.ts"]);
    for (const source of productionSources) {
      const declared = source.text.match(/answer_?[Tt]ype:\s*"([A-Z_]+)"/gu) ?? [];
      for (const entry of declared) {
        expect(entry).toContain("FIXED_EXAMPLE");
      }
    }
  });
});

describe("供应商中立", () => {
  it("只导入相对路径、@logiplan/contracts、zod 与中立的 Upstash Redis 客户端", () => {
    // 切片 2 经门 A（2026-10-08）授权新增 `@upstash/redis`——它是 D-182/§10 明确允许的
    // **中立层**依赖（限流与费用存储），不是供应商 SDK。除它之外不得新增任何外部依赖。
    const allowed = new Set(["./", "../", "@logiplan/contracts", "zod", "@upstash/redis"]);
    const imports: string[] = [];
    for (const source of productionSources) {
      for (const match of source.text.matchAll(IMPORT_SPECIFIER)) {
        const specifier = match[1] ?? "";
        const isRelative = specifier.startsWith(".");
        if (!isRelative && !allowed.has(specifier)) imports.push(`${source.file} → ${specifier}`);
      }
    }
    expect(imports).toEqual([]);
  });

  it("不出现供应商 SDK 或专有标识", () => {
    const forbidden =
      /\bopenai\b|azure\/openai|langchain|dify|anthropic|cohere|gemini|google\/generativeai|mistralai|ollama|bedrock|qwen|deepseek/u;
    const offenders = productionSources
      .filter((source) => forbidden.test(source.text))
      .map((source) => source.file);
    expect(offenders).toEqual([]);
  });

  it("Upstash Redis 客户端只出现在指定的中立适配器文件", () => {
    const offenders = productionSources
      .filter(
        (source) =>
          source.text.includes("@upstash") && source.file !== "control-plane/upstash-redis.ts",
      )
      .map((source) => source.file);
    expect(offenders).toEqual([]);
  });

  it("依赖只有 workspace 契约包、zod 与中立的 Upstash Redis 客户端", () => {
    const manifest: unknown = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
    expect(manifest).toMatchObject({
      name: "@logiplan/ai",
      dependencies: {
        "@logiplan/contracts": "workspace:*",
        "@upstash/redis": "1.39.0",
        zod: "4.4.3",
      },
    });
  });
});

describe("无供应商错误类型与响应结构", () => {
  it("标准化错误码只有中立码值", () => {
    const errorCodeSource = productionSources.find((source) =>
      source.file.endsWith("gateway-error-code.ts"),
    );
    expect(errorCodeSource).toBeDefined();
    const values = [...(errorCodeSource?.text ?? "").matchAll(/"([A-Z_]{4,})"/gu)].map(
      (match) => match[1] ?? "",
    );
    expect(values).toEqual([
      "INPUT_REJECTED",
      "SCHEMA_VALIDATION_FAILED",
      "EVIDENCE_WHITELIST_VIOLATION",
      "NUMERIC_MISMATCH",
      "PROVIDER_TIMEOUT",
      "PROVIDER_RATE_LIMITED",
      "PROVIDER_UNAVAILABLE",
      "PROVIDER_REQUEST_INVALID",
      "BUDGET_EXCEEDED",
      "RATE_LIMITED",
      "CONTROL_PLANE_UNAVAILABLE",
    ]);
  });
});
