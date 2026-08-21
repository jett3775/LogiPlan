import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const migrationFilePattern = /^(?<version>\d{4})_(?<name>[a-z0-9_]+)\.sql$/u;

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly fileName: string;
  readonly sql: string;
  readonly checksum: string;
}

export function checksumSql(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export async function loadMigrationFiles(directory: string): Promise<readonly MigrationFile[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const migrations: MigrationFile[] = [];
  const versions = new Set<string>();

  for (const fileName of names) {
    const match = migrationFilePattern.exec(fileName);
    if (match?.groups === undefined) {
      throw new Error(`迁移文件名无效：${fileName}`);
    }

    const version = match.groups.version;
    const name = match.groups.name;
    if (version === undefined || name === undefined) {
      throw new Error(`迁移文件名无法解析：${fileName}`);
    }
    if (versions.has(version)) {
      throw new Error(`迁移版本重复：${version}`);
    }
    versions.add(version);

    const sql = await readFile(path.join(directory, fileName), "utf8");
    if (sql.trim().length === 0) {
      throw new Error(`迁移文件为空：${fileName}`);
    }
    migrations.push({ version, name, fileName, sql, checksum: checksumSql(sql) });
  }

  return migrations;
}
