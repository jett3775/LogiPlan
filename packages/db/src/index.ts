import { Pool, type PoolConfig } from "pg";

const runtimePoolDefaults = {
  max: 2,
  connectionTimeoutMillis: 2_000,
  idleTimeoutMillis: 5_000,
  statement_timeout: 9_000,
} as const satisfies Pick<
  PoolConfig,
  "max" | "connectionTimeoutMillis" | "idleTimeoutMillis" | "statement_timeout"
>;

export function createReadOnlyPool(connectionString: string): Pool {
  if (connectionString.length === 0) {
    throw new Error("DATABASE_URL 不能为空");
  }

  return new Pool({
    ...runtimePoolDefaults,
    connectionString,
    application_name: "logiplan-web",
  });
}

export function getRuntimePoolDefaults(): Readonly<typeof runtimePoolDefaults> {
  return runtimePoolDefaults;
}

export { checkReadiness, runDeterministicQuery } from "./query-service";
export type { DeterministicResult, QueryServiceError } from "./query-service";
