import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * AC3.3 供应商中立（必须进 CI）：脚本化断言业务包**未导入任何供应商 SDK**、
 * 未出现**供应商专有响应结构**。
 *
 * 覆盖 `apps/web`、`packages/ai`、`packages/db`、`packages/domain`、`packages/contracts`
 * 五个包（供应商适配器包 `packages/ai-provider-*` 是**唯一**允许持有 SDK 的地方，不在本扫描面）。
 * 本文件位于 `packages/ai/src/**`，故 `pnpm test` / CI 自动收集，无需改 `package.json` 或 `scripts/`。
 *
 * 说明：`provider: "openai"` 这样的**中立 provider 标识字符串**不是 SDK 导入、也不是响应结构，
 * 故不在禁止集内；禁止的是对供应商 SDK 包的 import 语句与 `ChatCompletion` 之类的专有结构。
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const SCANNED_ROOTS = [
  join(REPO_ROOT, "apps", "web"),
  join(REPO_ROOT, "packages", "ai"),
  join(REPO_ROOT, "packages", "db"),
  join(REPO_ROOT, "packages", "domain"),
  join(REPO_ROOT, "packages", "contracts"),
];

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "coverage", ".vercel"]);
const SOURCE_EXT = /\.(ts|tsx|mts|cts)$/u;

const sourceFiles = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(full);
    return SOURCE_EXT.test(entry.name) ? [full] : [];
  });
};

const relative = (file: string): string =>
  file
    .slice(REPO_ROOT.length + 1)
    .split(sep)
    .join("/");

/** 供应商 SDK 的包名（导入 specifier）。 */
const PROVIDER_SDK_SPECIFIER =
  /^(?:openai|@azure\/openai|langchain|@langchain\/[^/]+|dify|dify-client|@dify\/[^/]+|anthropic|@anthropic-ai\/[^/]+|cohere-ai|@google\/generative-ai|@mistralai\/[^/]+|ollama|ollama-js|@aws-sdk\/client-bedrock[^/]*|qwen|@qwen\/[^/]+|deepseek|@deepseek\/[^/]+)(?:\/.*)?$/u;

/** 供应商专有响应结构 / SDK 类型标识。 */
const PROVIDER_STRUCTURE =
  /\bChatCompletion\b|\bchat\.completions\b|\bopenai\.types\b|\bAzureOpenAI\b|\bOpenAIError\b|\bAnthropic\b|\bGenerativeModel\b|\bCohereClient\b/u;

const extractImportSpecifiers = (source: string): string[] => {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s+"([^"]+)"/gu,
    /\bimport\s*\(\s*"([^"]+)"\s*\)/gu,
    /\bimport\s+"([^"]+)"/gu,
    /\brequire\(\s*"([^"]+)"\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) specifiers.push(match[1]);
    }
  }
  return specifiers;
};

const files = SCANNED_ROOTS.flatMap((root) => sourceFiles(root)).map((file) => ({
  file: relative(file),
  text: readFileSync(file, "utf8"),
}));

/**
 * 本扫描器自身的正则字面量包含被禁 token（`ChatCompletion` 等），会对自身误报；
 * 故把扫描器文件本身排除在**结构**断言之外（导入断言不受影响——本文件的导入 specifier
 * 只有 `node:fs` / `node:path` / `vitest`）。
 */
const SELF_FILE = "packages/ai/src/supplier-neutrality.test.ts";

describe("AC3.3 供应商中立（五个业务包）", () => {
  it("扫描面非空（否则断言会因空集恒真）", () => {
    expect(files.length).toBeGreaterThan(50);
    for (const pkg of [
      "apps/web/",
      "packages/ai/",
      "packages/db/",
      "packages/domain/",
      "packages/contracts/",
    ]) {
      expect(
        files.some((f) => f.file.startsWith(pkg)),
        pkg,
      ).toBe(true);
    }
  });

  it("未导入任何供应商 SDK", () => {
    const offenders: string[] = [];
    for (const source of files) {
      for (const specifier of extractImportSpecifiers(source.text)) {
        if (PROVIDER_SDK_SPECIFIER.test(specifier)) {
          offenders.push(`${source.file} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("未出现供应商专有响应结构", () => {
    const offenders = files
      .filter((source) => source.file !== SELF_FILE)
      .filter((source) => PROVIDER_STRUCTURE.test(source.text))
      .map((source) => source.file);
    expect(offenders).toEqual([]);
  });

  it("（正对照）同一扫描器在适配器包上确实命中 SDK 导入，证明断言有效", () => {
    const adapterRoot = join(REPO_ROOT, "packages", "ai-provider-openai");
    const adapterFiles = sourceFiles(adapterRoot).map((file) => readFileSync(file, "utf8"));
    const hits = adapterFiles.flatMap((text) =>
      extractImportSpecifiers(text).filter((specifier) => PROVIDER_SDK_SPECIFIER.test(specifier)),
    );
    expect(hits).toContain("openai");
  });
});
