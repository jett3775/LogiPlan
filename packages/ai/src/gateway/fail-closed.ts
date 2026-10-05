import { GATEWAY_ERROR_CODES, type GatewayErrorCode } from "./gateway-error-code";
import { GATEWAY_ERROR_STATUS_ZH } from "../labels/zh-labels";

/**
 * 失败关闭矩阵（docs/gate2-design.md §7）。
 *
 * 统一口径：任一失败路径都不调用或不展示模型输出，页面回到固定示例，
 * 确定性分析与闸门一数字**不受影响**。矩阵中不存在「部分可用」出口。
 *
 * 注意本模块**只声明固定示例出口**这一种答案类型：本切片不存在产生真实生成回答的路径。
 */

/** 失败关闭出口的固定形态：类型层面即锁死「不调用、不受影响」。 */
export interface FailClosedOutcome {
  readonly liveCallAllowed: false;
  readonly answerType: "FIXED_EXAMPLE";
  readonly deterministicAnalysisAffected: false;
}

export type FailClosedSource =
  | "INPUT_VALIDATION"
  | "CONTROL_PLANE"
  | "BUDGET"
  | "PROVIDER_TRANSPORT"
  | "OUTPUT_VALIDATION"
  | "CIRCUIT_BREAKER";

export interface FailClosedTrigger {
  readonly source: FailClosedSource;
  readonly errorCode: GatewayErrorCode;
  readonly triggerZh: string;
}

/** docs/gate2-design.md §7 失败关闭矩阵逐行落地。 */
export const FAIL_CLOSED_TRIGGERS: readonly FailClosedTrigger[] = [
  {
    source: "INPUT_VALIDATION",
    errorCode: "INPUT_REJECTED",
    triggerZh: "输入超 500 Unicode 字符、内容审核命中或审核服务异常",
  },
  {
    source: "CONTROL_PLANE",
    errorCode: "CONTROL_PLANE_UNAVAILABLE",
    triggerZh: "限流与预算服务不可用、超时或返回不确定状态",
  },
  {
    source: "CONTROL_PLANE",
    errorCode: "RATE_LIMITED",
    triggerZh: "滑动窗口限流命中",
  },
  {
    source: "BUDGET",
    errorCode: "BUDGET_EXCEEDED",
    triggerZh: "预算预留失败或月度预算熔断生效",
  },
  {
    source: "PROVIDER_TRANSPORT",
    errorCode: "PROVIDER_RATE_LIMITED",
    triggerZh: "供应商 429，重试 1 次后仍失败",
  },
  {
    source: "PROVIDER_TRANSPORT",
    errorCode: "PROVIDER_UNAVAILABLE",
    triggerZh: "供应商 5xx，重试 1 次后仍失败",
  },
  {
    source: "PROVIDER_TRANSPORT",
    errorCode: "PROVIDER_TIMEOUT",
    triggerZh: "20 秒硬超时",
  },
  {
    source: "PROVIDER_TRANSPORT",
    errorCode: "PROVIDER_REQUEST_INVALID",
    triggerZh: "供应商 4xx 参数错误，按冻结口径不重试",
  },
  {
    source: "CIRCUIT_BREAKER",
    errorCode: "PROVIDER_UNAVAILABLE",
    triggerZh: "L1 供应商短窗熔断生效",
  },
  {
    source: "OUTPUT_VALIDATION",
    errorCode: "SCHEMA_VALIDATION_FAILED",
    triggerZh: "结构化输出未通过公共 Zod 模式校验",
  },
  {
    source: "OUTPUT_VALIDATION",
    errorCode: "EVIDENCE_WHITELIST_VIOLATION",
    triggerZh: "输出引用了证据白名单之外的证据",
  },
  {
    source: "OUTPUT_VALIDATION",
    errorCode: "NUMERIC_MISMATCH",
    triggerZh: "输出中的数字无法回指同一次确定性结果",
  },
];

export interface FailClosedDecision extends FailClosedOutcome {
  readonly errorCode: GatewayErrorCode;
  /** 面向用户的受控中文状态；页面不得只显示内部错误码。 */
  readonly statusZh: string;
  readonly triggersZh: readonly string[];
}

const FAIL_CLOSED_OUTCOME: FailClosedOutcome = {
  liveCallAllowed: false,
  answerType: "FIXED_EXAMPLE",
  deterministicAnalysisAffected: false,
};

/**
 * 标准化错误码 → 失败关闭决策。返回的结果恒为固定示例出口，
 * 不存在返回模型输出的分支。
 */
export const decideFailClosed = (errorCode: GatewayErrorCode): FailClosedDecision => {
  const triggersZh = FAIL_CLOSED_TRIGGERS.filter((trigger) => trigger.errorCode === errorCode).map(
    (trigger) => trigger.triggerZh,
  );
  return {
    ...FAIL_CLOSED_OUTCOME,
    errorCode,
    statusZh: GATEWAY_ERROR_STATUS_ZH[errorCode],
    triggersZh,
  };
};

/** 全部错误码的失败关闭决策，供穷尽性测试与路由层使用。 */
export const allFailClosedDecisions = (): readonly FailClosedDecision[] =>
  GATEWAY_ERROR_CODES.map((code) => decideFailClosed(code));
