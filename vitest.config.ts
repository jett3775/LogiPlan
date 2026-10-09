import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/web/tests/playwright-config.test.ts"],
    passWithNoTests: false,
    sequence: {
      shuffle: false,
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // Next App Router entries are validated by Playwright and are not Vitest sources.
      include: [
        "packages/contracts/src/index.ts",
        "packages/domain/src/index.ts",
        "packages/db/src/index.ts",
        "packages/db/src/runtime-env.ts",
        "packages/db/src/migration-files.ts",
        "packages/db/src/release-package.ts",
        "packages/db/src/query-result.ts",
        "packages/db/src/query-service.ts",
        "packages/db/src/diagnostic-metrics.ts",
        "packages/ai/src/**/*.ts",
      ],
      exclude: ["**/*.test.ts"],
      thresholds: {
        "packages/contracts/src/**/*.ts": {
          lines: 95,
          statements: 95,
          functions: 95,
          branches: 95,
        },
        "packages/domain/src/**/*.ts": {
          lines: 95,
          statements: 95,
          functions: 95,
          branches: 95,
        },
        "packages/db/src/**/*.ts": {
          lines: 90,
          statements: 90,
          functions: 0,
          branches: 85,
        },
        "packages/db/src/diagnostic-metrics.ts": {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 100,
        },
        // 成本包围（闸门二切片 2）是唯一挡在真实花费前面的东西，必须进覆盖率门。
        // 2026-10-09 实测（确定性：`packages/ai` 内无环境门控跳过）：
        //   全包 86.80% stmts / 81.49% branch / 78.49% funcs / 89.87% lines。
        // 阈值取实测下方约 3—5 个点作回归护栏。主要拖累项是 `upstash-redis.ts`
        // （约 20% stmts）：它的 Lua/eval 路径需要真实 Upstash 实例才能执行，属已知
        // 本机不可测；门 C（首次真实付费调用）前补做真实原子性验证后应上调阈值。
        "packages/ai/src/**/*.ts": {
          lines: 85,
          statements: 83,
          functions: 75,
          branches: 78,
        },
      },
    },
  },
});
