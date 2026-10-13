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
        // 2026-10-13 实测（确定性：`packages/ai` 内无环境门控跳过；覆盖率步骤跑在单一
        // ubuntu-latest job）：全包 93.68% lines / 91.15% stmts / 84.62% funcs / 87.74% branch。
        // 阈值取实测下方约 3—5 个点作回归护栏。
        // 原注释记的「主要拖累项 `upstash-redis.ts` 约 20% stmts」**已关闭**：2026-10-13 把该
        // 适配器的客户端依赖收窄为可注入的 `RedisScriptClient`，脚本返回值 → 结果对象的映射
        // 由默认运行的单测覆盖（实测 92.59% stmts）。Lua 脚本本身仍需真实 Upstash，由受门控的
        // 集成测试（`LOGIPLAN_UPSTASH_INTEGRATION=1`）覆盖，默认跳过——因此它不计入本阈值。
        "packages/ai/src/**/*.ts": {
          lines: 89,
          statements: 86,
          functions: 80,
          branches: 83,
        },
      },
    },
  },
});
