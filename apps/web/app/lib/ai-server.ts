import {
  AI_ROLE_ROUTES,
  buildFixedExampleAnalysis,
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
 * 4. **预算结算**：`runGatewaySession` 内、且**仅当收到供应商响应时**才把预留替换为实际成本。
 *
 * ## 本部署不发起任何真实调用
 *
 * 适配器由 `options.adapter` 注入；本轮**恒为 `null`**（门 C 未开启）。`null` 时装配层
 * **完全不进入会话**（不预检、不预留、不写账本、不写限流窗口），直接回落固定示例 ⇒
 * **零真实调用、零付费**，线上与本机行为不变。
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

export interface AiAssemblyOptions {
  readonly environment: Record<string, string | undefined>;
  /** 供应商适配器；`null` = 本部署没有真实调用路径（门 C 未开启）。 */
  readonly adapter: ProviderAdapter | null;
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

  // ③ 本部署没有供应商适配器（门 C 未开启）⇒ **完全不进入会话**：不预检、不预留、不写
  //    账本、不写限流窗口，直接回落固定示例。（切片 2 的接缝曾在**每个请求**上预留预算
  //    却从不结算——那条路径已随本次装配改造消失。）
  if (options.adapter === null) {
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
          adapter: options.adapter,
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
