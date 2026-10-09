import type { GatewayErrorCode } from "../gateway/gateway-error-code";
import { runWithHardTimeout } from "../gateway/retry-policy";
import type { AiRole } from "../routing/role-routing";
import { deriveAnonymousId } from "./anonymous-id";
import {
  buildControlPlaneAuditRecord,
  type ControlPlaneAuditRecord,
  type ControlPlaneCircuitState,
} from "./audit-log";
import { readMonthlyUsage, reserveBudget, reserveFailureErrorCode } from "./budget-ledger";
import { isMonthlyBudgetBreached, isTransientFailure, L1CircuitBreaker } from "./circuit-breaker";
import { estimateCostCny, MAX_INPUT_TOKENS, type BudgetThreshold } from "./pricing";
import { checkRateLimit } from "./rate-limit";
import type { RedisLike } from "./redis-like";

/**
 * 成本包围控制面编排（docs/gate2-design.md §3、§7、D-181、D-190）。
 *
 * 顺序：L1 熔断判定 → 滑动窗口限流 → L2 月度预算判定 → 原子预留。
 * 任一环节不可用 / 超时 / 返回不确定状态 → **失败关闭**（`CONTROL_PLANE_UNAVAILABLE`）；
 * 限流命中 → `RATE_LIMITED`；预算不足或 L2 生效 → `BUDGET_EXCEEDED`。
 *
 * 本模块只决定「是否**允许**真实调用」，**不发起任何模型调用**。切片 2 不存在真实调用
 * 路径（AC2.12）；切片 3 将消费 `liveCallPermitted`。
 */

/** 控制面自身调用的硬超时：控制面必须远快于模型调用。 */
export const CONTROL_PLANE_TIMEOUT_MS = 2_000;

export interface RoleCostProfile {
  readonly model: string;
  readonly maxOutputTokens: number;
}

/** 角色成本档案；模型与输出上限取自 `gate2-design.md` §2 的冻结角色配置。 */
export const DEFAULT_ROLE_COST_PROFILES: Readonly<Record<AiRole, RoleCostProfile>> = {
  intent_parse: { model: "gpt-5.6-luna", maxOutputTokens: 400 },
  management_analysis: { model: "gpt-5.6-terra", maxOutputTokens: 1200 },
  fallback: { model: "gpt-5.6-luna", maxOutputTokens: 400 },
};

export interface ControlPlaneConfig {
  readonly environment: string;
  readonly secret: string;
  readonly threshold: BudgetThreshold;
  readonly currentPriceVersion: string;
  readonly currentFxVersion: string;
  readonly rateLimitWindowMs: number;
  readonly rateLimitLimit: number;
  readonly controlPlaneTimeoutMs: number;
  readonly roleCostProfiles: Readonly<Record<AiRole, RoleCostProfile>>;
}

export interface ControlPlaneClock {
  now(): number;
}

export interface ControlPlaneDeps {
  readonly redis: RedisLike;
  readonly breaker: L1CircuitBreaker;
  readonly clock: ControlPlaneClock;
}

export interface ControlPlaneRequest {
  readonly request_id: string;
  readonly role: AiRole;
  readonly rawIp: string;
  readonly userAgent: string;
}

export interface ControlPlaneDecision {
  readonly liveCallPermitted: boolean;
  readonly errorCode: GatewayErrorCode | null;
  readonly audit: ControlPlaneAuditRecord;
}

interface AuditFields {
  readonly errorCode: GatewayErrorCode | null;
  readonly rateLimitRemaining?: number | null;
  readonly budgetUsedCny?: number | null;
  readonly budgetCapCny?: number | null;
  readonly circuitState?: ControlPlaneCircuitState | null;
}

const buildAudit = (
  environment: string,
  request: ControlPlaneRequest,
  nowMs: number,
  fields: AuditFields,
): ControlPlaneAuditRecord =>
  buildControlPlaneAuditRecord({
    occurred_at: new Date(nowMs).toISOString(),
    environment,
    request_id: request.request_id,
    role: request.role,
    event: "DECISION",
    error_code: fields.errorCode,
    rate_limit_remaining: fields.rateLimitRemaining ?? null,
    budget_used_cny: fields.budgetUsedCny ?? null,
    budget_cap_cny: fields.budgetCapCny ?? null,
    circuit_state: fields.circuitState ?? null,
    fell_back_to_fixed_example: fields.errorCode !== null,
  });

const failClosed = (
  environment: string,
  request: ControlPlaneRequest,
  nowMs: number,
  errorCode: GatewayErrorCode,
  fields: Omit<AuditFields, "errorCode"> = {},
): ControlPlaneDecision => ({
  liveCallPermitted: false,
  errorCode,
  audit: buildAudit(environment, request, nowMs, { ...fields, errorCode }),
});

/** 控制面不可用时的失败关闭决策；供「未配置控制面」的调用方复用。 */
export const controlPlaneUnavailableDecision = (
  environment: string,
  request: ControlPlaneRequest,
  nowMs: number,
): ControlPlaneDecision => failClosed(environment, request, nowMs, "CONTROL_PLANE_UNAVAILABLE");

const reserveAmountCny = (config: ControlPlaneConfig, role: AiRole): number => {
  const profile = config.roleCostProfiles[role];
  return estimateCostCny(config.currentPriceVersion, config.currentFxVersion, profile.model, {
    inputTokens: MAX_INPUT_TOKENS,
    outputTokens: profile.maxOutputTokens,
  });
};

const runChecks = async (
  deps: ControlPlaneDeps,
  config: ControlPlaneConfig,
  request: ControlPlaneRequest,
  nowMs: number,
): Promise<ControlPlaneDecision> => {
  const scope = await deriveAnonymousId({
    rawIp: request.rawIp,
    userAgent: request.userAgent,
    secret: config.secret,
    nowMs,
  });

  if (!deps.breaker.canAttempt(request.role, nowMs)) {
    return failClosed(config.environment, request, nowMs, "PROVIDER_UNAVAILABLE", {
      circuitState: deps.breaker.state(request.role, nowMs),
    });
  }

  const rate = await checkRateLimit(deps.redis, {
    scope,
    role: request.role,
    requestId: request.request_id,
    nowMs,
    windowMs: config.rateLimitWindowMs,
    limit: config.rateLimitLimit,
  });
  if (!rate.allowed) {
    return failClosed(config.environment, request, nowMs, "RATE_LIMITED", {
      rateLimitRemaining: rate.remaining,
    });
  }

  const usage = await readMonthlyUsage(deps.redis, { threshold: config.threshold, nowMs });
  if (isMonthlyBudgetBreached(usage.used_cny, config.threshold)) {
    return failClosed(config.environment, request, nowMs, "BUDGET_EXCEEDED", {
      budgetUsedCny: usage.used_cny,
      budgetCapCny: usage.cap_cny,
      circuitState: "L2_OPEN",
    });
  }

  const reserved = await reserveBudget(deps.redis, {
    threshold: config.threshold,
    nowMs,
    requestId: request.request_id,
    amountCny: reserveAmountCny(config, request.role),
    currentPriceVersion: config.currentPriceVersion,
    currentFxVersion: config.currentFxVersion,
  });
  if (!reserved.ok) {
    return failClosed(
      config.environment,
      request,
      nowMs,
      reserveFailureErrorCode(reserved.reason),
      {
        budgetUsedCny: reserved.totalCny,
        budgetCapCny: reserved.capCny,
      },
    );
  }

  return {
    liveCallPermitted: true,
    errorCode: null,
    audit: buildAudit(config.environment, request, nowMs, {
      errorCode: null,
      rateLimitRemaining: rate.remaining,
      budgetUsedCny: reserved.totalCny,
      budgetCapCny: reserved.capCny,
    }),
  };
};

/**
 * 评估一次成本包围。任何异常（连接失败、超时、不确定结构、**甚至注入时钟抛错**）都收敛为
 * `CONTROL_PLANE_UNAVAILABLE` 的失败关闭决策，绝不抛给上层。
 *
 * `deps.clock.now()` 也在 `try` 之内：时钟是注入依赖，其异常同样属于「控制面不可用」，
 * 不得逃逸到请求处理链（P2 修复）。
 */
export const evaluateControlPlane = async (
  deps: ControlPlaneDeps,
  config: ControlPlaneConfig,
  request: ControlPlaneRequest,
): Promise<ControlPlaneDecision> => {
  try {
    const nowMs = deps.clock.now();
    const timed = await runWithHardTimeout(
      () => runChecks(deps, config, request, nowMs),
      config.controlPlaneTimeoutMs,
    );
    if (timed.timedOut) {
      return controlPlaneUnavailableDecision(config.environment, request, nowMs);
    }
    return timed.value;
  } catch {
    // 时钟抛错时没有可信的 `nowMs`，用 `Date.now()` 只作审计时间戳。
    return controlPlaneUnavailableDecision(config.environment, request, Date.now());
  }
};

export interface ControlPlaneRuntime {
  readonly deps: ControlPlaneDeps;
  readonly config: ControlPlaneConfig;
}

/**
 * 记录一次**真实调用**的结果，驱动 L1 连续故障计数（D-190 决策一）。
 *
 * 切片 3 在每次供应商调用结束后调用本函数（成功→`recordSuccess`；瞬时故障→
 * `recordTransientFailure`；其余错误码不改变计数）。切片 2 无真实调用，故本函数是
 * 「已接线但尚未被触发」的接缝——L1 的**跨请求累计**由 `server.ts` 的进程级单例保证。
 */
export const recordProviderAttemptOutcome = (
  runtime: ControlPlaneRuntime,
  role: AiRole,
  errorCode: GatewayErrorCode | null,
): void => {
  if (errorCode === null) {
    runtime.deps.breaker.recordSuccess(role);
    return;
  }
  if (isTransientFailure(errorCode)) {
    runtime.deps.breaker.recordTransientFailure(role, runtime.deps.clock.now());
  }
};

/** 控制面所需的服务端环境变量（D-177：密钥只走环境变量，不进构建产物）。 */
export const CONTROL_PLANE_ENV_KEYS = {
  secret: "LOGIPLAN_AI_ANON_SECRET",
  upstashUrl: "UPSTASH_REDIS_REST_URL",
  upstashToken: "UPSTASH_REDIS_REST_TOKEN",
} as const;

export interface CreateControlPlaneOptions {
  readonly redis?: RedisLike;
  readonly clock?: ControlPlaneClock;
  readonly environmentName?: string;
}
