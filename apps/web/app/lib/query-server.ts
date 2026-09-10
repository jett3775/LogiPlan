import "server-only";

import { randomUUID } from "node:crypto";
import { createReadOnlyPool, runDeterministicQuery } from "@logiplan/db";
import { deterministicResultSchema } from "@logiplan/contracts";
import type { AttributionFactor, QueryIntent } from "@logiplan/contracts";

import {
  attributionIntents,
  dashboardIntents,
  type AnomalyPayload,
  type AttributionData,
  type BridgePayload,
  type CountryPayload,
  type DashboardData,
  type DashboardPayload,
  type DeterministicResult,
  type DiagnosticPayload,
  type DrilldownPayload,
  type FixedCostPayload,
  type TrendPayload,
  type WarehousePayload,
} from "./model";

let pool: ReturnType<typeof createReadOnlyPool> | null = null;

function runtimePool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("服务端未配置 DATABASE_URL，无法读取正式演示数据。");
  }
  pool ??= createReadOnlyPool(connectionString);
  return pool;
}

async function execute<T>(intent: QueryIntent): Promise<DeterministicResult<T>> {
  const result = await runDeterministicQuery(runtimePool(), intent, randomUUID());
  if ("code" in result) {
    throw new Error(result.message_zh);
  }
  const validated = deterministicResultSchema.safeParse(result);
  if (!validated.success) {
    throw new Error("查询服务返回结果未通过 V1 运行时契约校验。");
  }
  return validated.data as DeterministicResult<T>;
}

export async function loadDashboardData(): Promise<DashboardData> {
  const [overview, trend, anomalies, fixed, warehouses] = await Promise.all([
    execute<DashboardPayload>(dashboardIntents.overview),
    execute<TrendPayload>(dashboardIntents.trend),
    execute<AnomalyPayload>(dashboardIntents.anomalies),
    execute<FixedCostPayload>(dashboardIntents.fixed),
    execute<WarehousePayload>(dashboardIntents.warehouses),
  ]);
  return { overview, trend, anomalies, fixed, warehouses };
}

export async function loadAttributionData(factor?: AttributionFactor): Promise<AttributionData> {
  const intents = attributionIntents(factor);
  const [country, bridge, diagnostics, drilldown] = await Promise.all([
    execute<CountryPayload>(intents.country),
    execute<BridgePayload>(intents.bridge),
    execute<DiagnosticPayload>(intents.diagnostics),
    execute<DrilldownPayload>(intents.drilldown),
  ]);
  return { country, bridge, diagnostics, drilldown };
}
