import type { ProviderAdapter } from "../adapter/adapter-contract";
import { buildControlPlaneAuditRecord } from "../control-plane/audit-log";
import { settleBudget } from "../control-plane/budget-ledger";
import {
  evaluateControlPlane,
  recordProviderAttemptOutcome,
  type ControlPlaneDecision,
  type ControlPlaneRequest,
  type ControlPlaneRuntime,
} from "../control-plane/control-plane";
import { usdToCny } from "../control-plane/pricing";
import {
  LOCAL_INPUT_MODERATION,
  type InputModerationDecision,
  type InputModerationPort,
} from "../moderation/input-moderation";
import type { AiRole } from "../routing/role-routing";
import type { EvidenceWhitelist } from "./evidence-port";
import { runGateway, type GatewayConfig, type GatewayOutcome } from "./gateway";
import type { RetryHooks } from "./retry-policy";

/**
 * 端到端会话编排：**控制面预检 → 网关编排 → 记录尝试结局 → 结算**。
 *
 * 这是「网页 ↔ 控制面 ↔ 网关 ↔ 适配器」四层装配边界里**唯一**把四者串起来的地方
 * （`docs/decisions.md` D-192）。放在中立层而不是 `apps/web`，是因为它的全部依赖都可注入
 * （控制面运行时、适配器、时钟），因此可以用替身完整验证六种结局而**不发起任何真实调用**。
 *
 * ## 为什么结算必须在这里，而不是在网关内
 *
 * 网关（`gateway.ts`）不接触预算账本：它只回报 `spend`（是否响应、用量、成本）。结算要读
 * **阈值 / Redis / 时钟**——三者都在 `ControlPlaneRuntime` 里，属于控制面装配层的输入。
 * 把「预留（预检内）— 结算（本模块）」配成一对，才能保证每次预留都有对应结算。
 *
 * ## 失败方向
 *
 * - 预检不放行 ⇒ **未**发起调用、**未**预留 ⇒ 不记录、不结算。
 * - 预检放行 ⇒ 一定发生过一次预留 ⇒ **一定**尝试结算。
 *   - **成本完整且为正**（`spend.cost_complete && cost_usd > 0`）⇒ 结算为**实际**成本
 *     （真实支出被如实记账）。
 *   - **发生过重试**（`cost_complete=false`：失败的那次尝试可能已被计费但用量未知）、
 *     未收到响应（超时 / 供应商错误），或适配器自报成本非正 ⇒ **不结算**，保留预留额：
 *     实际花费未知或不可信时宁可多计、不可少计（D-181「宁可回落固定示例，也不越过预算」）。
 *   - 结算 / 记录本身失败 ⇒ **记录失败但不丢弃已生成的回答**：预留额仍在账本上（方向保守），
 *     丢弃一次已经付费的回答既不省钱、又让用户看不到结果。
 *
 * ## 「本部署没有适配器」不在这里
 *
 * 适配器**必填**：调用方（装配层）在没有真实调用路径时**在进入本函数之前**直接回落固定
 * 示例。这样本模块内不存在任何适配器对象，`packages/ai` 就不会出现供应商实现的装配点
 * （`no-live-call.test.ts` 的 AC2.12 断言），也避免「先预留预算再发现没有适配器」的账本泄漏。
 */

export const GATEWAY_SESSION_SETTLEMENTS = ["not_attempted", "settled", "settle_failed"] as const;
export type GatewaySessionSettlement = (typeof GATEWAY_SESSION_SETTLEMENTS)[number];

export const GATEWAY_SESSION_RECORDS = ["not_attempted", "recorded", "record_failed"] as const;
export type GatewaySessionRecord = (typeof GATEWAY_SESSION_RECORDS)[number];

export interface GatewaySessionDeps {
  readonly config: GatewayConfig;
  readonly runtime: ControlPlaneRuntime;
  /**
   * 供应商适配器（**必填**）。「本部署没有真实调用路径」由调用方在**进入本函数之前**判定
   * 并直接回落固定示例——这样本模块内不存在任何适配器对象，`packages/ai` 也就不会出现
   * 供应商实现的装配点（`no-live-call.test.ts` 的 AC2.12 断言）。
   */
  readonly adapter: ProviderAdapter;
  /**
   * 平台侧输入审核端口（D-193 决策三）。默认本地规则审核；注入替身便于定向测试。
   * 审核异常同样失败关闭。
   */
  readonly moderation?: InputModerationPort;
  readonly retryHooks?: RetryHooks;
  readonly now?: () => number;
  readonly random?: () => number;
}

export interface GatewaySessionRequest {
  readonly request_id: string;
  readonly role: AiRole;
  readonly input: string;
  readonly scope_anchor: string;
  readonly evidence: EvidenceWhitelist;
  /** 原始 IP / User-Agent **只**用于控制面内的匿名派生；不落盘、不入日志、不进审计（D-138）。 */
  readonly rawIp: string;
  readonly userAgent: string;
}

export interface GatewaySessionOutcome {
  readonly outcome: GatewayOutcome;
  readonly preflight: ControlPlaneDecision;
  readonly settlement: GatewaySessionSettlement;
  readonly record: GatewaySessionRecord;
  /** 结算写入账本的实际金额（CNY）；未结算时为 0。 */
  readonly settle_amount_cny: number;
}

export const runGatewaySession = async (
  deps: GatewaySessionDeps,
  request: GatewaySessionRequest,
): Promise<GatewaySessionOutcome> => {
  const now = deps.now ?? Date.now;
  const gatewayDeps = {
    adapter: deps.adapter,
    ...(deps.retryHooks === undefined ? {} : { retryHooks: deps.retryHooks }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.random === undefined ? {} : { random: deps.random }),
  };

  // ⓪ 平台侧输入审核（D-193 决策三）：**先于**限流、L2 熔断检查与预算预留执行。
  //    命中或审核异常 ⇒ 失败关闭、不重试、直接回落固定示例；不产生预留、不写账本、
  //    不写限流窗口、不调用适配器。规则 id 不进入审计（审计字段受 D-138 白名单约束）。
  const moderationPort = deps.moderation ?? LOCAL_INPUT_MODERATION;
  let moderated: InputModerationDecision;
  try {
    moderated = await moderationPort.check(request.input);
  } catch {
    moderated = { ok: false, rule: "PORT_FAILURE" };
  }
  if (!moderated.ok) {
    const rejectedAtMs = now();
    const rejection: ControlPlaneDecision = {
      liveCallPermitted: false,
      errorCode: "INPUT_REJECTED",
      audit: buildControlPlaneAuditRecord({
        occurred_at: new Date(rejectedAtMs).toISOString(),
        environment: deps.config.environment,
        request_id: request.request_id,
        role: request.role,
        event: "DECISION",
        error_code: "INPUT_REJECTED",
        rate_limit_remaining: null,
        budget_used_cny: null,
        budget_cap_cny: null,
        circuit_state: null,
        fell_back_to_fixed_example: true,
      }),
    };
    const outcome = await runGateway(deps.config, gatewayDeps, {
      request_id: request.request_id,
      role: request.role,
      input: request.input,
      scope_anchor: request.scope_anchor,
      evidence: request.evidence,
      preflight: { liveCallPermitted: false, errorCode: "INPUT_REJECTED" },
    });
    return {
      outcome,
      preflight: rejection,
      settlement: "not_attempted",
      record: "not_attempted",
      settle_amount_cny: 0,
    };
  }

  // ① 控制面预检：限流 → L2 预算 → 原子预留 → L1 熔断。任何异常都在
  //    `evaluateControlPlane` 内收敛为 `CONTROL_PLANE_UNAVAILABLE` 的失败关闭。
  const controlRequest: ControlPlaneRequest = {
    request_id: request.request_id,
    role: request.role,
    rawIp: request.rawIp,
    userAgent: request.userAgent,
  };
  const preflight = await evaluateControlPlane(
    deps.runtime.deps,
    deps.runtime.config,
    controlRequest,
  );

  const outcome = await runGateway(deps.config, gatewayDeps, {
    request_id: request.request_id,
    role: request.role,
    input: request.input,
    scope_anchor: request.scope_anchor,
    evidence: request.evidence,
    preflight: { liveCallPermitted: preflight.liveCallPermitted, errorCode: preflight.errorCode },
  });

  // ② 预检不放行 ⇒ 没有调用、也没有预留 ⇒ 不记录、不结算。
  if (!preflight.liveCallPermitted) {
    return {
      outcome,
      preflight,
      settlement: "not_attempted",
      record: "not_attempted",
      settle_amount_cny: 0,
    };
  }

  // ③ 记录尝试结局（只有真正发起过调用才记录）。L1 计数落在 Redis，跨实例一致。
  let record: GatewaySessionRecord = "recorded";
  try {
    await recordProviderAttemptOutcome(
      deps.runtime,
      request.role,
      outcome.kind === "live" ? null : outcome.errorCode,
    );
  } catch {
    record = "record_failed";
  }

  // ④ 结算：把预留替换为实际。只有**成本完整且为正**时才可信。
  //
  // `cost_complete` 由网关给出，含义是「这份金额覆盖了本次调用的**全部**尝试」：
  // 发生过重试时（前一次尝试可能已被供应商计费但适配器不携带用量）它为 false。
  // 此时按末次金额结算会**少记**真实支出、使 L2 上限可被击穿，故**保留预留额**。
  // 同理，金额非正或非有限（适配器自报 0 / 未知价格）也不结算——宁可多计、不可少计（D-181）。
  let settlement: GatewaySessionSettlement = "not_attempted";
  let settleAmountCny = 0;
  const spend = outcome.spend;
  if (spend.cost_complete && Number.isFinite(spend.cost_usd) && spend.cost_usd > 0) {
    const actualCny = usdToCny(spend.cost_usd, deps.runtime.config.currentFxVersion);
    if (!Number.isFinite(actualCny) || actualCny <= 0) {
      settlement = "settle_failed";
    } else {
      try {
        await settleBudget(deps.runtime.deps.redis, {
          threshold: deps.runtime.config.threshold,
          nowMs: now(),
          requestId: request.request_id,
          actualCny,
        });
        settlement = "settled";
        settleAmountCny = actualCny;
      } catch {
        settlement = "settle_failed";
      }
    }
  }

  return { outcome, preflight, settlement, record, settle_amount_cny: settleAmountCny };
};
