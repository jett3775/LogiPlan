import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";
import typescriptEslint from "typescript-eslint";

const webFiles = ["apps/web/**/*.{js,jsx,ts,tsx,mjs,cjs}"];

export default defineConfig([
  ...typescriptEslint.configs.recommended,
  ...nextVitals.map((config) => ({ ...config, files: webFiles })),
  ...nextTypeScript.map((config) => ({ ...config, files: webFiles })),
  {
    files: webFiles,
    settings: {
      next: {
        rootDir: "apps/web/",
      },
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  globalIgnores([
    "**/.next/**",
    "**/coverage/**",
    "**/node_modules/**",
    ".tmp/**",
    "data/generated/**",
    "outputs/**",
    "prototype/**",
  ]),
]);
