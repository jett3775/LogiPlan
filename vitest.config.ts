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
        "packages/db/src/migration-files.ts",
        "packages/db/src/release-package.ts",
        "packages/db/src/query-result.ts",
        "packages/db/src/query-service.ts",
        "packages/db/src/diagnostic-metrics.ts",
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
      },
    },
  },
});
