import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { checksumSql, loadMigrationFiles } from "./migration-files";

describe("migration files", () => {
  it("loads valid files in version order with stable checksums", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "logiplan-migrations-"));
    await writeFile(path.join(directory, "0002_second.sql"), "SELECT 2;\n", "utf8");
    await writeFile(path.join(directory, "0001_first.sql"), "SELECT 1;\n", "utf8");

    const files = await loadMigrationFiles(directory);

    expect(files.map(({ version }) => version)).toEqual(["0001", "0002"]);
    expect(files[0]?.checksum).toBe(checksumSql("SELECT 1;\n"));
  });

  it("rejects duplicate migration versions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "logiplan-migrations-"));
    await writeFile(path.join(directory, "0001_first.sql"), "SELECT 1;\n", "utf8");
    await writeFile(path.join(directory, "0001_other.sql"), "SELECT 2;\n", "utf8");

    await expect(loadMigrationFiles(directory)).rejects.toThrow("迁移版本重复：0001");
  });

  it("rejects unversioned SQL files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "logiplan-migrations-"));
    await writeFile(path.join(directory, "setup.sql"), "SELECT 1;\n", "utf8");

    await expect(loadMigrationFiles(directory)).rejects.toThrow("迁移文件名无效：setup.sql");
  });
});
