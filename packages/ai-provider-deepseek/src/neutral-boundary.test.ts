import { readFileSync, readdirSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative as pathRelative, resolve, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { createDeepSeekAdapter } from "./adapter";
import type { DeepSeekResponsesClient } from "./types";

const SRC_DIR = import.meta.dirname;
const PACKAGE_ROOT = resolve(SRC_DIR, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|mts|cts)$/u.test(entry.name) ? [full] : [];
  });

const relative = (base: string, file: string): string =>
  file
    .slice(base.length + 1)
    .split(sep)
    .join("/");

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");

const productionSources = sourceFiles(SRC_DIR)
  .filter((file) => !file.endsWith(".test.ts"))
  .map((file) => ({
    path: file,
    file: relative(SRC_DIR, file),
    text: readFileSync(file, "utf8"),
  }));

/**
 * 门 C 激活接缝：真实 HTTP 客户端是**唯一**允许出现鉴权头的文件。它仍然不得读取环境
 * 变量、不得导入外部包或网络内置——网络能力由运行时的 `fetch` 注入。
 */
const ACTIVATION_SEAMS = new Set(["client.ts"]);

const offendingFiles = (predicate: (text: string) => boolean): string[] =>
  productionSources
    .filter((source) => !ACTIVATION_SEAMS.has(source.file))
    .filter((source) => predicate(stripComments(source.text)))
    .map((source) => source.file);

const parsedSource = (text: string, file: string): ts.SourceFile =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

interface ImportUse {
  readonly specifier: string | null;
  readonly kind: "static" | "dynamic" | "require";
}

const literalText = (node: ts.Expression | undefined): string | null =>
  node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;

/** 统一抽取静态 import/export、import=require、dynamic import 和 require。 */
const importUses = (text: string, file: string): readonly ImportUse[] => {
  const uses: ImportUse[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      uses.push({ kind: "static", specifier: literalText(node.moduleSpecifier) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      uses.push({ kind: "static", specifier: literalText(node.moduleSpecifier) });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      uses.push({ kind: "require", specifier: literalText(node.moduleReference.expression) });
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        uses.push({ kind: "dynamic", specifier: literalText(node.arguments[0]) });
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        uses.push({ kind: "require", specifier: literalText(node.arguments[0]) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsedSource(text, file));
  return uses;
};

const escapesPackage = (sourcePath: string, specifier: string): boolean => {
  const target = resolve(dirname(sourcePath), specifier);
  const fromRoot = pathRelative(PACKAGE_ROOT, target);
  return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
};

const NETWORK_BUILTINS = new Set([
  "dgram",
  "dns",
  "dns/promises",
  "http",
  "http2",
  "https",
  "net",
  "tls",
]);

const isAllowedBuiltin = (specifier: string): boolean => {
  if (!isBuiltin(specifier)) return false;
  const normalized = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  return !NETWORK_BUILTINS.has(normalized);
};

const invalidImportUses = (text: string, sourcePath: string): readonly string[] =>
  importUses(text, sourcePath).flatMap((use) => {
    if (use.specifier === null) return [`${use.kind}: non-literal specifier`];
    if (use.specifier.startsWith(".")) {
      return escapesPackage(sourcePath, use.specifier)
        ? [`${use.kind}: package escape ${use.specifier}`]
        : [];
    }
    return isAllowedBuiltin(use.specifier) ? [] : [`${use.kind}: external ${use.specifier}`];
  });

const PROCESS_MODULE_SPECIFIERS = new Set(["process", "node:process"]);

const isProcessModuleSpecifier = (specifier: string | null): boolean =>
  specifier !== null && PROCESS_MODULE_SPECIFIERS.has(specifier);

/**
 * 检测对 Node `process` 全局的任何引用。
 *
 * 不能只匹配名称为 `process` 的标识符：`import proc from "node:process"` 会把全局
 * 别名成任意名字，此时标识符不再叫 `process`，但环境读取能力等价。因此同时检查
 * 静态 / 动态 / `require` / `import=` 四种导入形态的模块 specifier。
 */
const containsProcessReference = (text: string, file: string): boolean => {
  if (importUses(text, file).some((use) => isProcessModuleSpecifier(use.specifier))) {
    return true;
  }
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "process") found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(parsedSource(text, file));
  return found;
};

describe("DeepSeek dormant 边界", () => {
  it("生产源码不读环境或密钥，也不直接发起网络请求", () => {
    expect(
      productionSources
        .filter((source) => containsProcessReference(source.text, source.path))
        .map((source) => source.file),
    ).toEqual([]);
    expect(
      offendingFiles((text) =>
        /\b(?:Bun|Deno)\.env\b|DEEPSEEK_API_KEY|Authorization|\bBearer\b/u.test(text),
      ),
    ).toEqual([]);
    expect(
      offendingFiles((text) =>
        /\bfetch\s*\(|node:https?|from\s+["'](?:axios|undici)["']|XMLHttpRequest|new\s+WebSocket/u.test(
          text,
        ),
      ),
    ).toEqual([]);
  });

  it("真实客户端接缝只接收注入密钥与网络能力，不读环境、不导入网络内置", () => {
    const seam = productionSources.find((source) => source.file === "client.ts");
    expect(seam).toBeDefined();
    if (seam === undefined) return;
    // 环境读取检测必须覆盖别名导入形态（`node:process`）。
    expect(containsProcessReference(seam.text, seam.path)).toBe(false);
    expect(stripComments(seam.text)).not.toContain("DEEPSEEK_API_KEY");
    // 导入面仍受同一约束：只允许包内相对路径与 Node 内置，且不含网络内置。
    expect(invalidImportUses(seam.text, seam.path)).toEqual([]);
  });

  it("生产导入仅限本包相对路径或 Node 内置，不反向跨包且不导入外部 SDK", () => {
    const invalid = productionSources.flatMap((source) =>
      invalidImportUses(source.text, source.path).map(
        (violation) => `${source.file}: ${violation}`,
      ),
    );
    expect(invalid).toEqual([]);
  });

  it.each([
    ['import x from "./../../../ai/src/index";', "static relative escape"],
    ['export { x } from "../../../ai/src/index";', "export-from relative escape"],
    ['import "../../../ai/src/index";', "side-effect relative escape"],
    ['void import ( "../../../ai/src/index" );', "dynamic relative escape with whitespace"],
    ['require("../../../ai/src/index");', "require relative escape"],
    ['void import("axios");', "dynamic external package"],
    ['const target = "axios"; void import(target);', "dynamic non-literal"],
    ['const target = "axios"; require(target);', "require non-literal"],
    ['import "node:not-a-real-builtin";', "unknown node prefix"],
    ['import http from "http";', "bare network builtin"],
    ['import https from "node:https";', "node-prefixed network builtin"],
  ])("扫描器拒绝 $1", (code) => {
    expect(invalidImportUses(code, join(SRC_DIR, "mock.ts"))).not.toEqual([]);
  });

  it("扫描器接受包内 ./ 与 ../ 以及真实 Node builtin", () => {
    const code = `
      import "./adapter";
      export type { DeepSeekResponsesClient } from "./types";
      import packageJson from "../package.json";
      import { readFileSync } from "node:fs";
      const path = require("path");
      void import ( "./errors" );
      void packageJson;
      void readFileSync;
      void path;
    `;
    expect(invalidImportUses(code, join(SRC_DIR, "mock.ts"))).toEqual([]);
  });

  it.each([
    "void process.env.DEEPSEEK_API_KEY;",
    'void process["env"].DEEPSEEK_API_KEY;',
    'import proc from "node:process"; void proc.env;',
    'import { env as e } from "process"; void e;',
    'const p = await import("node:process"); void p;',
    'const p = require("node:process"); void p;',
    'import p = require("node:process"); void p;',
    'export { env } from "node:process";',
  ])("扫描器拒绝 process 读取及其全部导入形态：%s", (code) => {
    expect(containsProcessReference(code, "mock.ts")).toBe(true);
  });

  it("扫描器不把其他 Node 内置误判为 process", () => {
    expect(containsProcessReference('import path from "node:path"; void path;', "mock.ts")).toBe(
      false,
    );
    expect(containsProcessReference("const value = 1; void value;", "mock.ts")).toBe(false);
  });

  it("manifest 是无外部依赖的 private ESM，锁文件只有空 workspace importer", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      readonly name?: unknown;
      readonly private?: unknown;
      readonly type?: unknown;
      readonly dependencies?: unknown;
      readonly devDependencies?: unknown;
      readonly peerDependencies?: unknown;
      readonly optionalDependencies?: unknown;
    };
    expect(manifest).toMatchObject({
      name: "@logiplan/ai-provider-deepseek",
      private: true,
      type: "module",
    });
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();

    const lockfile = readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
    expect(lockfile).toMatch(/^  packages\/ai-provider-deepseek: \{\}$/mu);
  });

  it("全局 fetch 被禁用时仍只调用注入客户端并成功", async () => {
    const calls: string[] = [];
    const client: DeepSeekResponsesClient = {
      responses: {
        create: async (body) => {
          calls.push(body.model);
          return {
            id: "resp_boundary",
            model: body.model,
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: '{"ok":true}' }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          };
        },
      },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (): never => {
      throw new Error("network disabled in boundary test");
    };
    try {
      const adapter = createDeepSeekAdapter({
        client,
        priceVersion: "TEST_PRICE_V1",
        costLookup: () => 0.001,
        resolveSystemPrompt: () => "system",
        resolveOutputSchema: () => ({ type: "object" }),
      });
      const result = await adapter.invoke({
        role: "management_analysis",
        model: "deepseek-v4-pro",
        systemPromptVersion: "system-v1",
        outputSchemaVersion: "schema-v1",
        input: "test",
        evidenceWhitelist: [],
        reasoningEffort: "low",
        maxOutputTokens: 32,
        timeoutMs: 1_000,
      });
      expect(result.structuredOutput).toEqual({ ok: true });
      expect(calls).toEqual(["deepseek-v4-pro"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
