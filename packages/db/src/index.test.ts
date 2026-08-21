import { describe, expect, it } from "vitest";

import { createReadOnlyPool, getRuntimePoolDefaults } from "./index";

describe("database pool configuration", () => {
  it("uses the frozen small-pool limits", () => {
    expect(getRuntimePoolDefaults()).toEqual({
      max: 2,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 5_000,
      statement_timeout: 9_000,
    });
  });

  it("rejects an empty connection string before opening a pool", () => {
    expect(() => createReadOnlyPool("")).toThrow("DATABASE_URL 不能为空");
  });
});
