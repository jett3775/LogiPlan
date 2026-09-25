import { afterEach, describe, expect, it, vi } from "vitest";

const managementEnvironmentKeys = [
  "MIGRATION_DATABASE_URL",
  "PUBLISHER_DATABASE_URL",
  "SNAPSHOT_TEST_SUPERUSER_URL",
  "POSTGRES_SUPERUSER_PASSWORD",
  "LOGIPLAN_SCHEMA_MIGRATOR_PASSWORD",
  "LOGIPLAN_DATA_PUBLISHER_PASSWORD",
  "LOGIPLAN_APP_READER_PASSWORD",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Playwright Web server environment", () => {
  async function webServerEnvironment() {
    const { default: config } = await import("../../../playwright.config");
    const webServer = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
    return webServer?.env;
  }

  it("removes database management credentials when the reader URL is configured", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://app_reader:reader@127.0.0.1:55439/logiplan");
    for (const name of managementEnvironmentKeys) vi.stubEnv(name, `secret-${name}`);
    vi.resetModules();

    const env = await webServerEnvironment();
    expect(env?.DATABASE_URL).toContain("app_reader");
    for (const name of managementEnvironmentKeys) expect(env?.[name]).toBe("");
  });

  it("still clears management credentials when no reader URL is configured", async () => {
    vi.stubEnv("CI", "1");
    vi.stubEnv("DATABASE_URL", "");
    for (const name of managementEnvironmentKeys) vi.stubEnv(name, `secret-${name}`);
    vi.resetModules();

    const env = await webServerEnvironment();
    expect(env?.DATABASE_URL).toBe("");
    for (const name of managementEnvironmentKeys) expect(env?.[name]).toBe("");
  });
});
