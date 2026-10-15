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
    /**
     * 门 C（D-192 阶段 2）：`provider/assembly.ts` 是**唯一**允许导入供应商适配器包的模块。
     * 它是 `packages/ai` 里的供应商客户端装配入口（**不在**主 barrel 里，`no-live-call.test.ts`
     * 的可达性断言锁死这一点）；适配器包自身只依赖 `openai`，且 AC3.3 指定它为唯一允许持有
     * 供应商 SDK 的地方。
     */
    const PROVIDER_ASSEMBLY = new Set(["provider/assembly.ts"]);
    const imports: string[] = [];
    for (const source of productionSources) {
      for (const match of source.text.matchAll(IMPORT_SPECIFIER)) {
        const specifier = match[1] ?? "";
        const isRelative = specifier.startsWith(".");
        if (isRelative || allowed.has(specifier)) continue;
        if (PROVIDER_ASSEMBLY.has(source.file) && specifier === "@logiplan/ai-provider-openai") {
          continue;
        }
        imports.push(`${source.file} → ${specifier}`);
      }
    }
    expect(imports).toEqual([]);
  });

  it("不导入任何供应商 SDK（任何生产文件）", () => {
    // 供应商 SDK 的**导入语句**在生产源码中一律禁止。注意这里只看 import/require 语句，
    // 不禁止「openai」作为**中立 provider 标识**出现在受版本控制的角色配置里（D-180/D-190）。
    const sdkImport =
      /\bfrom\s+["'](?:openai|@azure\/openai|langchain|dify|anthropic|cohere-ai|@google\/generative-ai|@mistralai\/[^"']+|ollama|@aws-sdk\/client-bedrock[^"']*|qwen|deepseek)["']/u;
    const requireImport =
      /\brequire\(\s*["'](?:openai|@azure\/openai|langchain|dify|anthropic)["']\s*\)/u;
    const offenders = productionSources
      .filter((source) => sdkImport.test(source.text) || requireImport.test(source.text))
      .map((source) => source.file);
    expect(offenders).toEqual([]);
  });

  it("供应商专有标识只允许出现在受版本控制的角色配置（provider 标识）", () => {
    // 切片 3b：D-180/D-190 要求 provider 标识写在 `packages/ai` 内**受版本控制的角色配置**里，
    // 故 `config/role-config.ts` 合法地含有 `provider: "openai"`。其余生产文件不得出现任何
    // 供应商 SDK 名或专有标识（含注释）。
    const providerIdentifier = /\bopenai\b/u;
    const otherVendors =
      /azure\/openai|langchain|dify|anthropic|cohere|gemini|google\/generativeai|mistralai|ollama|bedrock|qwen|deepseek/u;
    const offenders = productionSources
      // 门 C（D-192 阶段 2）：`provider/assembly.ts` 合法地出现适配器包名（含 `openai` 字样），
      // 它是唯一的供应商客户端装配入口；该模块不在主 barrel 里。
      .filter(
        (source) =>
          source.file !== "config/role-config.ts" && source.file !== "provider/assembly.ts",
      )
      .filter((source) => providerIdentifier.test(source.text) || otherVendors.test(source.text))
      .map((source) => source.file);
    expect(offenders).toEqual([]);
    // 正对照：role-config.ts 确实持有 provider 标识（否则上一条断言会因误判而恒真）。
    const roleConfig = productionSources.find((source) => source.file === "config/role-config.ts");
    expect(roleConfig?.text).toContain('"openai"');
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
