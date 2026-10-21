import type { ManagementAnalysis } from "@logiplan/contracts";

import type { AdapterRequest, ProviderAdapter } from "../adapter/adapter-contract";
import type { AiAuditMetadata } from "../audit/audit-metadata";
import { AI_ROLE_ROUTES } from "../config/role-config";
import { PRICE_VERSION_V2 } from "../control-plane/pricing";
import { buildFixedExampleAnalysis } from "../fixed-example/fixed-example";
import { GATEWAY_ERROR_STATUS_ZH } from "../labels/zh-labels";
import { resolveRoleRoute, type AiRole, type RoleRouteConfig } from "../routing/role-routing";
import { allWhitelistedEvidenceIds, type EvidenceWhitelist } from "./evidence-port";
import { isGatewayErrorCode, type GatewayErrorCode } from "./gateway-error-code";
import { runOutputChecks } from "./output-checks";
import {
  HARD_TIMEOUT_MS,
  invokeWithRetry,
  type AttemptOutcome,
  type RetryHooks,
  type TimedResult,
} from "./retry-policy";

/**
 * 网关编排（docs/gate2-design.md §1.2、§7；切片 3b 执行步骤 3—5）。
 *
 * 链路：**角色路由 → 组装 `AdapterRequest` → 调用适配器 → 输出三检 → 中文输出与
 * `limitations` → 审计元数据**。任一环节失败都**失败关闭**：整体丢弃、回落固定示例，
 * 不裁剪、不修补、不部分展示，也绝不把失败结果当作真实生成结果（AC3.7、AC3.8）。
 *
 * ## 重试归属（切片 3b 协调项 2）
 *
 * **适配器只做单次尝试 + 单次尝试的硬超时**；重试（429/5xx 恰好 1 次）由本包的
 * `gateway/retry-policy.ts` 承担（AC2.9 已验收）。因此本网关**不再叠加**第二条超时——
 * 每次尝试的硬超时由适配器施加，网关的重试包装器只用**直通**超时钩子，避免同一次调用
 * 上存在两条竞争的预算（叠加会变成最多 4 次尝试，正是本切片要消除的缺陷）。
 *
 * ## 证据与范围
 *
 * 确定性证据由调用方（`apps/web`）注入（`EvidenceWhitelist`）；本包不 `import`
 * `packages/db`，不硬编码任何证据 ID 或范围。提示词 / 输出模式版本解析器由中立层的
 * 真实注册表（`config/registry.ts`）在适配器装配处注入（切片 3b 协调项 4）。
 */

export const GATEWAY_BACKOFF_MIN_MS = 100;
export const GATEWAY_BACKOFF_MAX_MS = 500;

export interface GatewayConfig {
  readonly environment: string;
  /** 价格版本；进入成本估算与审计（AC3.9）。 */
  readonly priceVersion: string;
  /** 受版本控制的角色配置；默认取 `config/role-config.ts`。 */
  readonly routes: readonly RoleRouteConfig[];
}

export interface GatewayDeps {
  /** 注入的供应商适配器（本切片注入假适配器；真实 SDK 客户端在门 C 开启后装配）。 */
  readonly adapter: ProviderAdapter;
  /** 重试钩子；默认直通超时 + 短随机退避。 */
  readonly retryHooks?: RetryHooks;
  readonly now?: () => number;
  readonly random?: () => number;
}

/**
 * 控制面（限流 / 预算 / 熔断）的预检结论；**必填**，本包只消费。
 *
 * 没有控制面结论 = **失败关闭**：调用方必须先取得结论再调用，本包绝不「缺省即放行」。
 */
export interface GatewayPreflight {
  readonly liveCallPermitted: boolean;
  readonly errorCode: GatewayErrorCode | null;
}

export interface GatewayRequest {
  readonly request_id: string;
  readonly role: AiRole;
  /** 已通过输入校验（≤500 Unicode 字符）的自然语言。 */
  readonly input: string;
  /** 调用方请求的范围锚点；与注入白名单锚点比对（范围不一致即失败）。 */
  readonly scope_anchor: string;
  /** 服务端注入的确定性证据白名单（范围锚定）。 */
  readonly evidence: EvidenceWhitelist;
  /**
   * 控制面预检结论（限流 / 预算 / 两级熔断）——**必填**（D-181 / §7、D-190）。
   *
   * 无控制面结论即**失败关闭**：调用方必须先取得控制面结论；漏传会被 typecheck 在
   * 编译期拒绝，运行时也绝不发起真实调用——不存在「缺省放行」而绕过月度预算上限或
   * 熔断的路径。
   */
  readonly preflight: GatewayPreflight;
}

/**
 * 供应商花费报告。
 *
 * ## 为什么需要 `cost_complete`（重试的费用处理）
 *
 * 429 / 5xx 会触发**恰好一次重试**（`retry-policy.ts`）。失败的那次尝试可能已经到达供应商
 * 并被计费，但适配器抛错时**不携带用量**，因此那一次的成本**未知**。若只按最后一次尝试的
 * 成本结算，账本就会**少记**真实支出，使月度上限可被击穿（D-181）。
 *
 * 因此本报告不只给金额，还给「这份金额是否覆盖了全部尝试」：
 * - `cost_complete = responded && attempts === 1`——只有「一次尝试且收到响应」时，
 *   报告的成本才等于本次调用的全部花费；
 * - 有任何一次尝试未计入（重试、超时、供应商错误）⇒ `cost_complete = false`，
 *   结算方据此**保留预留额**（宁可多计、不可少计）。
 *
 * `responded = false` 表示**没有收到供应商响应**（未调用、或调用超时 / 失败）——此时
 * `cost_usd` 为 0，但那是「未知」而不是「确定没花钱」。
 */
export interface ProviderSpendReport {
  readonly responded: boolean;
  readonly cost_complete: boolean;
  /** 实际尝试次数（含重试）；路由 / 能力门 / 预检失败为 0。 */
  readonly attempts: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cost_usd: number;
  readonly latency_ms: number;
}

export type GatewayOutcome =
  | {
      readonly kind: "live";
      readonly analysis: ManagementAnalysis;
      /** 本次调用的实际花费；结算方据此把预留替换为实际值。 */
      readonly spend: ProviderSpendReport;
      readonly audit: AiAuditMetadata;
    }
  | {
      readonly kind: "fallback";
      readonly analysis: ManagementAnalysis;
      readonly errorCode: GatewayErrorCode;
      /**
       * 已经发生的花费。**输出三检未过但供应商已响应**时 `responded=true` 且带真实成本——
       * 否则结算会把预留释放成 0，使月度账本**少报**真实支出、让 L2 上限可被击穿。
       * 路由 / 能力门 / 预检失败（未调用）时为 `responded=false, cost_usd=0`。
       */
      readonly spend: ProviderSpendReport;
      /** 面向用户的受控中文状态；页面不得只显示内部错误码。 */
      readonly statusZh: string;
      readonly audit: AiAuditMetadata;
    };

/** 默认角色配置；调用方可用 `GatewayConfig.routes` 覆盖（测试注入替身路由）。 */
export const defaultGatewayConfig = (environment: string): GatewayConfig => ({
  environment,
  priceVersion: PRICE_VERSION_V2,
  routes: AI_ROLE_ROUTES,
});

/**
 * 从适配器抛出的错误中取出**中立**错误码：只按结构读取 `code` 字段并用
 * `isGatewayErrorCode` 收窄，**不导入**任何供应商适配器包（保持单向依赖与
 * 「`packages/ai` 不导入 `ai-provider-*`」的边界）。
 */
export const extractNeutralErrorCode = (error: unknown): GatewayErrorCode | null => {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (isGatewayErrorCode(code)) return code;
  }
  return null;
};

const passthroughTimeout = async <T>(task: () => Promise<T>): Promise<TimedResult<T>> => ({
  timedOut: false,
  value: await task(),
});

/** 默认重试钩子：直通超时（适配器已施加每次尝试的硬超时）+ 短随机退避。 */
export const defaultGatewayRetryHooks = (random: () => number = Math.random): RetryHooks => ({
  withHardTimeout: passthroughTimeout,
  backoff: async (): Promise<void> => {
    const span = GATEWAY_BACKOFF_MAX_MS - GATEWAY_BACKOFF_MIN_MS;
    const ms = GATEWAY_BACKOFF_MIN_MS + Math.floor(random() * (span + 1));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  },
});

interface AuditInput {
  readonly request: GatewayRequest;
  readonly environment: string;
  readonly priceVersion: string;
  readonly occurredAtMs: number;
  readonly route: RoleRouteConfig | null;
  readonly adapterVersion: string;
  readonly errorCode: GatewayErrorCode | null;
}

/** 与路由 / 错误码无关的审计字段；每个出口再补 `route` 与 `errorCode`。 */
type AuditBase = Omit<AuditInput, "route" | "errorCode">;

interface AuditOutcomeFields {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly costUsd: number;
}

const buildAudit = (input: AuditInput, outcome: AuditOutcomeFields): AiAuditMetadata => ({
  request_id: input.request.request_id,
  occurred_at: new Date(input.occurredAtMs).toISOString(),
  environment: input.environment,
  role: input.request.role,
  provider: outcome.provider,
  model: outcome.model,
  adapter_version: input.adapterVersion,
  system_prompt_version: input.route?.systemPromptVersion ?? "",
  output_schema_version: input.route?.outputSchemaVersion ?? "",
  price_version: input.priceVersion,
  input_tokens: outcome.inputTokens,
  output_tokens: outcome.outputTokens,
  latency_ms: outcome.latencyMs,
  cost_estimate_usd: outcome.costUsd,
  http_status: null,
  error_code: input.errorCode,
  cancelled: false,
  fell_back_to_fixed_example: input.errorCode !== null,
});

/** 未发起任何供应商调用时的花费报告。 */
const NO_SPEND: ProviderSpendReport = {
  responded: false,
  cost_complete: false,
  attempts: 0,
  input_tokens: 0,
  output_tokens: 0,
  cost_usd: 0,
  latency_ms: 0,
};

/** 一次（或多次）尝试结束后的花费报告：只有单次尝试才可能「成本完整」。 */
const spendOf = (
  responded: boolean,
  attempts: number,
  usage: { readonly inputTokens: number; readonly outputTokens: number },
  costUsd: number,
  latencyMs: number,
): ProviderSpendReport => ({
  responded,
  cost_complete: responded && attempts === 1,
  attempts,
  input_tokens: usage.inputTokens,
  output_tokens: usage.outputTokens,
  cost_usd: costUsd,
  latency_ms: latencyMs,
});

const fallback = (
  base: AuditBase,
  route: RoleRouteConfig | null,
  errorCode: GatewayErrorCode,
  latencyMs: number,
  spend: ProviderSpendReport = NO_SPEND,
): GatewayOutcome => ({
  kind: "fallback",
  analysis: buildFixedExampleAnalysis(),
  errorCode,
  spend,
  statusZh: GATEWAY_ERROR_STATUS_ZH[errorCode],
  audit: buildAudit(
    { ...base, route, errorCode },
    {
      provider: route?.provider ?? "unresolved",
      model: route?.model ?? "unresolved",
      inputTokens: spend.input_tokens,
      outputTokens: spend.output_tokens,
      // 已响应时用供应商报告的真实延迟；未响应时用本网关的墙钟。
      latencyMs: spend.latency_ms > 0 ? spend.latency_ms : latencyMs,
      costUsd: spend.cost_usd,
    },
  ),
});

/**
 * 执行一次网关编排。是否发起真实调用由注入的适配器决定（本切片注入假适配器）。
 * 任何失败路径都返回 `fallback`（固定示例 + 受控中文），不存在「部分可用」出口。
 */
export const runGateway = async (
  config: GatewayConfig,
  deps: GatewayDeps,
  request: GatewayRequest,
): Promise<GatewayOutcome> => {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const elapsed = (): number => now() - startedAt;
  const auditBase: AuditBase = {
    request,
    environment: config.environment,
    priceVersion: config.priceVersion,
    occurredAtMs: startedAt,
    adapterVersion: deps.adapter.adapterVersion,
  };

  const routeResolution = resolveRoleRoute(config.routes, request.role);
  if (!routeResolution.ok) {
    return fallback(auditBase, null, routeResolution.errorCode, elapsed());
  }
  const route = routeResolution.route;

  // 控制面预检：限流 / 预算 / 熔断不通过即不调用（无结论已由类型系统拦在编译期）。
  // 先于能力门判定：平台侧输入审核拒绝（`INPUT_REJECTED`）也是以「预检不放行」的形式进入，
  // 必须原样返回该错误码，不能被能力门改写成请求参数错误。
  if (!request.preflight.liveCallPermitted) {
    return fallback(
      auditBase,
      route,
      request.preflight.errorCode ?? "CONTROL_PLANE_UNAVAILABLE",
      elapsed(),
    );
  }

  // 需求侧能力门：角色需要但适配器未声明的能力 → 失败关闭（不静默降级）。
  const missing = route.requiredCapabilities.filter((name) => !deps.adapter.capabilities[name]);
  if (missing.length > 0) {
    return fallback(auditBase, route, "PROVIDER_REQUEST_INVALID", elapsed());
  }

  const adapterRequest: AdapterRequest = {
    role: request.role,
    model: route.model,
    systemPromptVersion: route.systemPromptVersion,
    outputSchemaVersion: route.outputSchemaVersion,
    input: request.input,
    evidenceWhitelist: allWhitelistedEvidenceIds(request.evidence),
    reasoningEffort: route.reasoningEffort,
    maxOutputTokens: route.maxOutputTokens,
    timeoutMs: HARD_TIMEOUT_MS,
  };

  let attempts = 0;
  const attemptFn = async (): Promise<AttemptOutcome> => {
    attempts += 1;
    try {
      const result = await deps.adapter.invoke(adapterRequest);
      return { kind: "result", result };
    } catch (error) {
      return { kind: "error", errorCode: extractNeutralErrorCode(error) ?? "PROVIDER_UNAVAILABLE" };
    }
  };

  const hooks = deps.retryHooks ?? defaultGatewayRetryHooks(deps.random);
  const outcome = await invokeWithRetry(attemptFn, hooks);

  if (outcome.kind === "error") {
    // 尝试过但没拿到响应 ⇒ 成本**未知**：明确回报 `responded:false, cost_complete:false`，
    // 由结算方保留预留额，不得按 0 结算。
    return fallback(auditBase, route, outcome.errorCode, elapsed(), {
      ...NO_SPEND,
      attempts,
      latency_ms: elapsed(),
    });
  }

  const spend = spendOf(
    true,
    attempts,
    outcome.result.usage,
    outcome.result.costEstimate.amount,
    outcome.result.latencyMs,
  );

  const checks = runOutputChecks({
    output: outcome.result.structuredOutput,
    evidence: request.evidence,
    expectedScopeAnchor: request.scope_anchor,
  });
  if (!checks.ok) {
    // 响应已收到 ⇒ 供应商已计费。此处必须回报**真实**花费，否则结算会释放预留、少报支出。
    return fallback(auditBase, route, checks.failure.code, elapsed(), spend);
  }

  return {
    kind: "live",
    analysis: checks.analysis,
    spend,
    audit: buildAudit(
      { ...auditBase, route, errorCode: null },
      {
        provider: outcome.result.provider,
        model: outcome.result.model,
        inputTokens: outcome.result.usage.inputTokens,
        outputTokens: outcome.result.usage.outputTokens,
        latencyMs: outcome.result.latencyMs,
        costUsd: outcome.result.costEstimate.amount,
      },
    ),
  };
};
