import { describe, expect, it } from "vitest";

import { readWebRuntimeDatabaseUrl } from "./runtime-env";

const validUrl = "postgresql://app_reader:reader-secret@host-pooler.neon.tech:5432/logiplan";

describe("web runtime database url validation", () => {
  it("returns null when DATABASE_URL is absent, so the build and readiness stay unchanged", () => {
    expect(readWebRuntimeDatabaseUrl({})).toBeNull();
  });

  it("treats an empty or whitespace-only value as absent", () => {
    expect(readWebRuntimeDatabaseUrl({ DATABASE_URL: "" })).toBeNull();
    expect(readWebRuntimeDatabaseUrl({ DATABASE_URL: "   " })).toBeNull();
  });

  it("accepts a postgresql url whose role is app_reader", () => {
    expect(readWebRuntimeDatabaseUrl({ DATABASE_URL: validUrl })).toBe(validUrl);
  });

  it("accepts the postgres:// scheme and a percent-encoded role name", () => {
    expect(
      readWebRuntimeDatabaseUrl({ DATABASE_URL: "postgres://app_reader@127.0.0.1:5432/db" }),
    ).toBe("postgres://app_reader@127.0.0.1:5432/db");
    expect(readWebRuntimeDatabaseUrl({ DATABASE_URL: "postgresql://app%5Freader@host/db" })).toBe(
      "postgresql://app%5Freader@host/db",
    );
  });

  it("rejects a non-postgres protocol", () => {
    expect(() => readWebRuntimeDatabaseUrl({ DATABASE_URL: "mysql://app_reader@host/db" })).toThrow(
      "必须是 postgresql:// 或 postgres:// 形式的连接串",
    );
  });

  it("rejects a value that is not a url at all", () => {
    expect(() => readWebRuntimeDatabaseUrl({ DATABASE_URL: "not a url" })).toThrow(
      "DATABASE_URL 未通过启动校验",
    );
  });

  it("rejects a management role before any query runs", () => {
    for (const role of ["data_publisher", "schema_migrator", "neondb_owner", "postgres"]) {
      expect(() =>
        readWebRuntimeDatabaseUrl({ DATABASE_URL: `postgresql://${role}@host/db` }),
      ).toThrow("用户名必须是 app_reader");
    }
  });

  it("rejects a role name with a malformed percent escape without leaking a URIError", () => {
    // URL 解析器不校验 userinfo 的百分号转义，所以 decodeURIComponent 会抛 URIError；
    // 这里断言我们退回到原始用户名并给出正常的校验失败，而不是让异常穿透 safeParse。
    expect(() =>
      readWebRuntimeDatabaseUrl({ DATABASE_URL: "postgresql://app%ZZreader@host/db" }),
    ).toThrow("用户名必须是 app_reader");
  });

  it("never echoes the connection string back in the error message", () => {
    let message = "";
    try {
      readWebRuntimeDatabaseUrl({
        DATABASE_URL:
          "postgresql://data_publisher:super-secret-password@db.example.com:5432/logiplan",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("用户名必须是 app_reader");
    expect(message).not.toContain("super-secret-password");
    expect(message).not.toContain("db.example.com");
    expect(message).not.toContain("postgresql://");
  });
});
