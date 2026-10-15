import {
  AI_ROLE_ROUTES,
  PRICE_VERSION_V1,
  buildFixedExampleAnalysis,
  estimateCostUsd,
  resolveOutputSchema,
  resolveSystemPrompt,
  runGatewaySession,
  type ProviderAdapter,
} from "@logiplan/ai";
import {
  controlPlaneUnavailableDecision,
  createControlPlaneFromEnvironment,
  emitControlPlaneAudit,
  type ControlPlaneRequest,
  type ControlPlaneRuntime,
} from "@logiplan/ai/server";
import { attributionFactorSchema } from "@logiplan/contracts";
import type { AttributionFactor, ManagementAnalysis } from "@logiplan/contracts";

import {
  AI_RESPOND_STATUS_ZH,
  bindAnswerToRealSnapshot,
  buildAnswerSnapshotSeeds,
  buildEvidenceWhitelist,
  buildNeutralEvidenceWhitelist,
  deriveSafetyIdentifier,
  type AiAnswerBlock,
} from "./ai-model";
import { loadAttributionData } from "./query-server";

/**
 * 服务端装配层（D-192）：把**网页 → 控制面 → 网关 → 适配器**四层接在一起。
 *
 * 这是四层之间唯一的组装点，其余三层的边界保持不变：
 *
 * | 层                        | 拥有                                                             | 不拥有                                     |
 * | ------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
 * | `apps/web`（本文件）      | 确定性查询、证据白名单、页面地址校验、控制面装配、适配器注入、HTTP 形状 | 不做角色路由 / 输出三检 / 成本判定         |
 * | `packages/ai` 控制面      | 匿名派生、限流、预算预留、两级熔断                                | 不接触 HTTP、不查库                        |
 * | `packages/ai` 网关与会话  | 角色路由 → 能力门 → 预检消费 → 适配器 → 重试 → 三检 → 结算编排    | 不派生匿名、不查库、不构造适配器           |
 * | `packages/ai-provider-*`  | 供应商协议与错误映射、成本估算                                    | 不含业务规则；**本轮不装配**（门 C 未开）  |
 *
 * ## 四条接线位置
 *
 * 1. **证据范围**：`loadAttributionData` → `buildNeutralEvidenceWhitelist`（中立，网关输入）
 *    + `buildEvidenceWhitelist`（页面呈现）。四族锚点不一致即失败关闭。
 * 2. **匿名标识**：`deriveSafetyIdentifier`——适配器的 `safety_identifier` 只能取它的返回值；
 *    原始 IP / User-Agent 不落盘、不入日志、不进审计（D-138 / D-181）。
 * 3. **预算预留**：`runGatewaySession` 内的 `evaluateControlPlane`（限流 → L2 → 原子预留 → L1）。
 * 4. **预算结算**：`runGatewaySession` 内、且**仅当成本完整且为正**（`spend.cost_complete && cost_usd > 0`）
 *    时才把预留替换为实际成本；**发生过重试**时成本不完整（首次尝试可能已被计费）⇒ 保留预留额。
 *
 * ## 本部署不发起任何真实调用
 *
 * 适配器由 `options.createAdapter`（默认 `createProviderAdapter`）产出；本轮**恒为 `null`**
 * （门 C 未开启）。`null` 时装配层**完全不进入会话**（不预检、不预留、不写账本、不写限流窗口），
 * 直接回落固定示例 ⇒ **零真实调用、零付费**，线上与本机行为不变。
 *
 * ## 服务端边界
 *
 * 本模块**没有**写 `import "server-only"`，因为它必须能在 Node 测试环境下被导入
 * （`apps/web/tests/ai-assembly.test.ts` 用 `vi.mock` 替身驱动装配层）。服务端边界由
 * **传递依赖**强制：`./query-server` 带 `server-only`，而 `ai-assembly.test.ts` 正是通过
 * 替身替换它来避免加载真实数据库客户端——任何客户端组件导入本模块都会在构建期报错。
 */

/** 角色：管理分析（`gate2-design.md` §6 的受版本控制角色配置）。 */
const MANAGEMENT_ANALYSIS_ROLE = "management_analysis" as const;

/**
 * 供应商适配器接缝的显式开关（门 C）。
 *
 * 即使有人把 `OPENAI_API_KEY` 放进环境，只要本开关不是 `"1"`，装配层也**不会**构造真实
 * 适配器 ⇒ 不产生任何真实调用。门 C 开启时，真实客户端在此接入（用
 * `deriveSafetyIdentifier` 的返回值作为 `safety_identifier`）。
 */
export const LIVE_CALLS_ENV_KEY = "LOGIPLAN_AI_LIVE_CALLS";

/** 供应商密钥的环境变量名；只由服务端环境读出并直接交给适配器包，不落盘、不入日志（D-177）。 */
export const OPENAI_API_KEY_ENV_KEY = "OPENAI_API_KEY";

/**
 * 真实客户端装配接缝（门 C）：装配层把「**按需派生匿名标识**」的能力交给工厂，
 * 工厂只有在确实要装配适配器时才调用它。
 *
 * 为什么是「按需」而不是直接传值：本部署（门 C 未开启）恒不装配适配器，按需派生
 * 可避免每个请求都做一次无用的 HMAC 派生。
 */
export type ProviderAdapterFactory = (input: {
  readonly environment: Record<string, string | undefined>;
  /** 按需派生匿名标识；适配器的 `safety_identifier` **只能**取它的返回值。 */
  readonly resolveSafetyIdentifier: () => Promise<string | null>;
  readonly priceVersion: string;
}) => ProviderAdapter | null | Promise<ProviderAdapter | null>;

/**
 * 默认的适配器工厂——**门 C 的显式开关**。
 *
 * 三个条件都满足才会有适配器：
 * 1. `LOGIPLAN_AI_LIVE_CALLS === "1"`（授权位；即使环境里放了 `OPENAI_API_KEY`，缺这个开关也不装配）；
 * 2. `OPENAI_API_KEY` 非空（密钥只走服务端环境变量，不进构建产物）；
 * 3. 能派生出匿名标识（缺主密钥即失败关闭——适配器必须有 `safety_identifier`）。
 *
 * 三者缺一即返回 `null` ⇒ 装配层完全不进入会话 ⇒ **零真实调用**。本函数**动态**导入
 * `@logiplan/ai/provider`（`packages/ai` 的子路径，内含供应商 SDK），因此开关关闭时连
 * 供应商 SDK 都不会被加载。
 *
 * ⚠️ **门 C 验收时必须确认真的拿到了适配器**：任一条件不满足都只是静默回落固定示例、
 * **不会报错**。判据是响应 `status === "LIVE_GENERATED"`（已记为遗留 P2）。
 */
export const createProviderAdapter: ProviderAdapterFactory = async (input) => {
  if (input.environment[LIVE_CALLS_ENV_KEY] !== "1") return null;
  const apiKey = input.environment[OPENAI_API_KEY_ENV_KEY];
  if (apiKey === undefined || apiKey.length === 0) return null;
  const safetyIdentifier = await input.resolveSafetyIdentifier();
  if (safetyIdentifier === null) return null;

  // 只有真正要装配时才加载供应商 SDK。`apps/web` **不**导入供应商 SDK（AC3.3），也**不**
  // 直接导入适配器包（那会破坏「适配器包只被 `packages/ai` 依赖」的边界）；只走
  // `@logiplan/ai/provider` 这个**子路径**——它是 `packages/ai` 里唯一的调用方。
  const { createOpenAiAdapterFromApiKey } = await import("@logiplan/ai/provider");
  return createOpenAiAdapterFromApiKey({
    apiKey,
    safetyIdentifier,
    priceVersion: input.priceVersion,
    // 价格表单一来源：`packages/ai` 的 `pricing.ts`（未知模型 / 版本 → `Infinity`，失败关闭）。
    costLookup: estimateCostUsd,
    resolveSystemPrompt,
    resolveOutputSchema,
  });
};

export interface AiAssemblyOptions {
  readonly environment: Record<string, string | undefined>;
  /** 适配器工厂；默认 `createProviderAdapter`（门 C 未开启时恒返回 `null`）。 */
  readonly createAdapter?: ProviderAdapterFactory;
  /** 原始 IP / User-Agent **只**用于匿名派生；不落盘、不入日志。 */
  readonly rawIp: string;
  readonly userAgent: string;
  readonly now?: () => number;
  /** 控制面装配工厂；默认 `createControlPlaneFromEnvironment`。测试注入替身运行时。 */
  readonly createRuntime?: (
    environment: Record<string, string | undefined>,
  ) => Promise<ControlPlaneRuntime | null>;
}

export type AiAssemblyOutcome =
  | {
      readonly ok: true;
      readonly status: "FIXED_EXAMPLE" | "LIVE_GENERATED";
      readonly answer: AiAnswerBlock;
    }
  | {
      readonly ok: false;
      readonly status: "EVIDENCE_WHITELIST_VIOLATION" | "DETERMINISTIC_SOURCE_UNAVAILABLE";
      readonly message_zh: string;
    };

/**
 * 从页面范围地址取出因素。
 *
 * 归因页 `?factor=` 只影响下钻排序与行级证据的 `:FACTOR:` 后缀；固定示例引用的是顶层行
 * ID（`ATTRIBUTION_DRILLDOWN:FC:DE_FC`，`query-service.ts:1801` 在任何因素下都产出），
 * 因此这里如实沿用页面当前因素，不强制清空。
 */
const factorFromPageAddress = (pageAddress: string): AttributionFactor | undefined => {
  const parsed = attributionFactorSchema.safeParse(
    new URL(pageAddress, "http://127.0.0.1").searchParams.get("factor"),
  );
  return parsed.success ? parsed.data : undefined;
};

/**
 * 匿名标识接线位置（D-192 第 2 条）定义在 `ai-model.ts` 的 `deriveSafetyIdentifier`——
 * 放在纯模块里是为了让「适配器标识与控制面标识同源」这一性质可被默认测试集验证。
 */

const unavailable = (): AiAssemblyOutcome => ({
  ok: false,
  status: "DETERMINISTIC_SOURCE_UNAVAILABLE",
  message_zh: AI_RESPOND_STATUS_ZH.DETERMINISTIC_SOURCE_UNAVAILABLE,
});

const discarded = (detail: string): AiAssemblyOutcome => ({
  ok: false,
  status: "EVIDENCE_WHITELIST_VIOLATION",
  message_zh: `${detail}，管理分析已整体丢弃；归因页数字与证据不受影响。`,
});

/**
 * 产出管理分析回答。失败路径一律失败关闭（`gate2-design.md` §7）：不返回任何部分答案。
 */
export const answerManagementQuestion = async (
  pageAddress: string,
  question: string,
  requestId: string,
  options: AiAssemblyOptions,
): Promise<AiAssemblyOutcome> => {
  const now = options.now ?? Date.now;
  const environmentName = options.environment["NODE_ENV"] ?? "unknown";

  // ① 确定性证据（唯一触库处）。
  let data;
  try {
    data = await loadAttributionData(factorFromPageAddress(pageAddress));
  } catch {
    return unavailable();
  }

  // ② 证据范围：中立白名单是网关的唯一确定性事实入口，必须**单范围**。
  const neutralWhitelist = buildNeutralEvidenceWhitelist(data);
  if (neutralWhitelist === null) {
    return discarded("证据结果集不属于同一范围");
  }
  const pageWhitelist = buildEvidenceWhitelist(data);

  const controlRequest: ControlPlaneRequest = {
    request_id: requestId,
    role: MANAGEMENT_ANALYSIS_ROLE,
    rawIp: options.rawIp,
    userAgent: options.userAgent,
  };

  let analysis: ManagementAnalysis;
  let status: "FIXED_EXAMPLE" | "LIVE_GENERATED" = "FIXED_EXAMPLE";

  // ③ 匿名标识 + 适配器装配（门 C 接缝）。工厂**按需**派生匿名标识——本部署恒不装配
  //    适配器，故连派生都不会发生。原始 IP / User-Agent 只在这一条闭包里流动。
  //
  // 工厂抛错（真实客户端构造失败等）⇒ **失败关闭**：不得逃逸到请求处理链（P1 修复）。
  const createAdapter = options.createAdapter ?? createProviderAdapter;
  let adapter: ProviderAdapter | null;
  try {
    adapter = await createAdapter({
      environment: options.environment,
      resolveSafetyIdentifier: () =>
        deriveSafetyIdentifier({
          environment: options.environment,
          rawIp: options.rawIp,
          userAgent: options.userAgent,
          nowMs: now(),
        }),
      priceVersion: PRICE_VERSION_V1,
    });
  } catch {
    adapter = null;
  }

  // ④ 没有适配器（门 C 未开启）⇒ **完全不进入会话**：不预检、不预留、不写账本、不写限流
  //    窗口，直接回落固定示例。（切片 2 的接缝曾在**每个请求**上预留预算却从不结算——
  //    那条路径已随本次装配改造消失。）
  if (adapter === null) {
    analysis = buildFixedExampleAnalysis();
  } else {
    const createRuntime = options.createRuntime ?? createControlPlaneFromEnvironment;
    const runtime = await createRuntime(options.environment);
    if (runtime === null) {
      // 控制面不可用 ⇒ 失败关闭：不发起任何调用、不预留预算。
      emitControlPlaneAudit(
        controlPlaneUnavailableDecision(environmentName, controlRequest, now()).audit,
      );
      analysis = buildFixedExampleAnalysis();
    } else {
      // ④ 会话编排：预检（限流 / 预算预留 / 熔断）→ 网关 → 记录 → 结算。
      const session = await runGatewaySession(
        {
          config: {
            environment: runtime.config.environment,
            priceVersion: runtime.config.currentPriceVersion,
            routes: AI_ROLE_ROUTES,
          },
          runtime,
          adapter,
          ...(options.now === undefined ? {} : { now: options.now }),
        },
        {
          request_id: requestId,
          role: MANAGEMENT_ANALYSIS_ROLE,
          input: question,
          scope_anchor: neutralWhitelist.scope_anchor,
          evidence: neutralWhitelist,
          rawIp: options.rawIp,
          userAgent: options.userAgent,
        },
      );
      emitControlPlaneAudit(session.preflight.audit);
      analysis = session.outcome.analysis;
      status = session.outcome.kind === "live" ? "LIVE_GENERATED" : "FIXED_EXAMPLE";
    }
  }

  // ⑤ 绑定服务端真实快照（D-191：按族多份）。
  const binding = bindAnswerToRealSnapshot(analysis, pageWhitelist);
  if (!binding.ok) {
    return discarded(`回答引用了 ${binding.missing.length} 条不在证据白名单内的内容`);
  }
  const seeds = buildAnswerSnapshotSeeds(binding.cited, data);
  if (seeds === null) {
    return discarded("回答引用的证据族快照载荷缺失");
  }

  return {
    ok: true,
    status,
    answer: {
      scope_label: binding.analysis.scope_label,
      answer_type: binding.analysis.answer_type,
      analysis: binding.analysis,
      evidence: binding.cited,
      snapshot_seeds: seeds,
    },
  };
};
