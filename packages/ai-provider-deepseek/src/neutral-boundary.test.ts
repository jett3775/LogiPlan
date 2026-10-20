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

const offendingFiles = (predicate: (text: string) => boolean): string[] =>
  productionSources
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

const containsProcessReference = (text: string, file: string): boolean => {
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

  it.each(["process.env.DEEPSEEK_API_KEY", 'process["env"].DEEPSEEK_API_KEY'])(
    "扫描器拒绝常规 process 环境读取：%s",
    (expression) => {
      expect(containsProcessReference(`void ${expression};`, "mock.ts")).toBe(true);
    },
  );

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
