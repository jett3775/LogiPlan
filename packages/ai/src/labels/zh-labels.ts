import type { GatewayErrorCode } from "../gateway/gateway-error-code";
import type { ProviderCapabilityName } from "../adapter/provider-capabilities";

/**
 * 面向用户的中文穷尽映射（AC1.8）。
 *
 * 每张表的类型都是 `Readonly<Record<枚举, string>>`：枚举新增取值而未补中文时
 * `tsc` 报错；补了中文而枚举没有该取值时同样报错。运行时另有穷尽性测试兜底。
 *
 * 说明：本模块**不映射答案类型**（`FIXED_EXAMPLE` 等取值）的页面文案——那属切片 1b；
 * 本切片的中立层只产出固定示例出口，不构造任何非固定示例的答案类型取值。
 */

/** 标准化错误码的中文状态文案；页面不得只显示内部错误码。 */
export const GATEWAY_ERROR_STATUS_ZH: Readonly<Record<GatewayErrorCode, string>> = {
  INPUT_REJECTED: "输入未被接受",
  SCHEMA_VALIDATION_FAILED: "回答未通过输出格式校验，已改用固定示例",
  EVIDENCE_WHITELIST_VIOLATION: "回答引用了证据白名单之外的内容，已改用固定示例",
  NUMERIC_MISMATCH: "回答中的数字无法回指确定性结果，已改用固定示例",
  PROVIDER_TIMEOUT: "模型服务超时，已改用固定示例",
  PROVIDER_RATE_LIMITED: "模型服务限流，已改用固定示例",
  PROVIDER_UNAVAILABLE: "模型服务暂不可用，已改用固定示例",
  PROVIDER_REQUEST_INVALID: "模型请求参数不合法，已改用固定示例",
  BUDGET_EXCEEDED: "本月模型调用预算已用尽，已改用固定示例",
  RATE_LIMITED: "请求过于频繁，已改用固定示例",
  CONTROL_PLANE_UNAVAILABLE: "限流与预算服务暂不可用，已改用固定示例",
};

/** 建议的情景计算状态中文文案。 */
export const SCENARIO_VALIDATION_STATUS_ZH = {
  NOT_RUN: "尚未做情景计算",
  RUN: "已完成情景计算",
} as const satisfies Readonly<Record<"NOT_RUN" | "RUN", string>>;

/** 建议的可行性状态中文文案。 */
export const FEASIBILITY_STATUS_ZH = {
  NOT_VALIDATED: "未验证",
  PARTIALLY_VALIDATED: "部分验证",
  VALIDATED: "已验证",
} as const satisfies Readonly<
  Record<"NOT_VALIDATED" | "PARTIALLY_VALIDATED" | "VALIDATED", string>
>;

/** 供应商能力项的中文名称（能力声明缺失时的受控文案用）。 */
export const PROVIDER_CAPABILITY_ZH: Readonly<Record<ProviderCapabilityName, string>> = {
  structuredOutput: "结构化输出",
  reasoningControl: "推理强度控制",
  dataRetentionToggle: "数据留存开关",
  safetyIdentifier: "安全标识",
  moderation: "内容审核",
};

/**
 * 订单粒度保护的受控中文说明（docs/query-contract.md §12 的
 * `ORDER_LEVEL_NOT_AVAILABLE` 语义）。页面不得向用户只显示内部错误码。
 */
export const ORDER_LEVEL_NOT_AVAILABLE_MESSAGE_ZH =
  "当前事实粒度为月 × 目的国 × 发货仓 × 承运商 × 运输方式，没有订单级收入、成本或订单—包裹关联，无法提供订单级成本明细或订单 Top 10；可以提供线路层下钻。";

/** 固定示例必须直接显示的限制标签（docs/query-contract.md §10）。 */
export const REQUIRED_LIMITATION_LABEL_ZH = "相关性不等于因果 · 不得推断未记录的经营因果";

/** 未做情景计算时的限制标签；与「不得给出未经情景计算支持的节省金额」配套。 */
export const SCENARIO_NOT_RUN_LABEL_ZH = "建议未经情景计算 · 不给出未经情景计算支持的节省金额";

/** 订单粒度保护的限制标签。 */
export const ORDER_GRAIN_LABEL_ZH = `订单粒度不可得 · ${ORDER_LEVEL_NOT_AVAILABLE_MESSAGE_ZH}`;
