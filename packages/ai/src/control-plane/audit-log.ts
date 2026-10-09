import type { GatewayErrorCode } from "../gateway/gateway-error-code";
import type { AiRole } from "../routing/role-routing";
import type { CircuitState } from "./circuit-breaker";

/**
 * 成本包围审计记录（docs/gate2-design.md §8、docs/decisions.md D-138）。
 *
 * ## 为什么不就地扩 `AI_AUDIT_FIELD_NAMES`
 *
 * `AI_AUDIT_FIELD_NAMES`（`audit/audit-metadata.ts`）描述的是**真实模型调用**的审计记录，
 * 由切片 1a 冻结，其测试断言「字段恰好等于白名单，多一个即失败」。成本包围发生在**调用
 * 之前**，记录的是限流、预算与熔断状态，字段集合本就不同；把两者混进一张表会让「新增成本
 * 字段」被迫修改调用审计的边界断言，破坏该断言的独立性，也违反 D-138 的最小必要原则。
 *
 * 因此这里定义**独立**的记录类型与**独立**的白名单常量。两张表都只含 D-138 允许的
 * 运行元数据，都**不得**包含原始 IP、完整 User-Agent、请求体或业务正文（D-138、D-181）。
 */

export const CONTROL_PLANE_AUDIT_EVENTS = [
  "DECISION",
  "RATE_LIMIT",
  "BUDGET_RESERVE",
  "BUDGET_SETTLE",
  "CIRCUIT",
] as const;

export type ControlPlaneAuditEvent = (typeof CONTROL_PLANE_AUDIT_EVENTS)[number];

/** 熔断状态：L1 的三态，或 L2 的全局打开。 */
export type ControlPlaneCircuitState = CircuitState | "L2_OPEN";

/** 允许记录的字段名；测试逐项核对「恰好相等」。 */
export const CONTROL_PLANE_AUDIT_FIELD_NAMES = [
  "occurred_at",
  "environment",
  "request_id",
  "role",
  "event",
  "error_code",
  "rate_limit_remaining",
  "budget_used_cny",
  "budget_cap_cny",
  "circuit_state",
  "fell_back_to_fixed_example",
] as const;

export type ControlPlaneAuditFieldName = (typeof CONTROL_PLANE_AUDIT_FIELD_NAMES)[number];

export interface ControlPlaneAuditRecord {
  readonly occurred_at: string;
  readonly environment: string;
  readonly request_id: string;
  readonly role: AiRole | null;
  readonly event: ControlPlaneAuditEvent;
  readonly error_code: GatewayErrorCode | null;
  readonly rate_limit_remaining: number | null;
  readonly budget_used_cny: number | null;
  readonly budget_cap_cny: number | null;
  readonly circuit_state: ControlPlaneCircuitState | null;
  /**
   * 成本包围是否迫使本请求回落固定示例（即拒绝了真实调用）。
   *
   * 切片 2 尚无真实调用路径，故该字段描述的是**门控决策**；切片 3 起它与「是否真的
   * 调用了模型」一一对应。
   */
  readonly fell_back_to_fixed_example: boolean;
}

/**
 * 从输入构造审计记录：显式逐字段拷贝，**保证输出恰好只含白名单字段**
 * （即便输入对象被塞入额外键，也不会泄漏到日志）。
 */
export const buildControlPlaneAuditRecord = (
  input: ControlPlaneAuditRecord,
): ControlPlaneAuditRecord => ({
  occurred_at: input.occurred_at,
  environment: input.environment,
  request_id: input.request_id,
  role: input.role,
  event: input.event,
  error_code: input.error_code,
  rate_limit_remaining: input.rate_limit_remaining,
  budget_used_cny: input.budget_used_cny,
  budget_cap_cny: input.budget_cap_cny,
  circuit_state: input.circuit_state,
  fell_back_to_fixed_example: input.fell_back_to_fixed_example,
});

export interface AuditSink {
  write(record: ControlPlaneAuditRecord): void;
}

/**
 * 默认 sink：**切片 2 不落盘**——写入即丢弃。AC2.10 在本切片验证的是「记录字段恰好等于
 * 白名单」（类型 + 单测锁定），**不**声称已有日志后端持久化；真实 sink 由切片 3 注入。
 */
export const noopAuditSink: AuditSink = { write: () => undefined };

/**
 * 发射一条审计记录。默认 sink 为空实现（切片 2 无落盘）；切片 3 起注入真实日志后端。
 * 无论 sink 为何，`buildControlPlaneAuditRecord` 已保证记录**恰好**只含白名单字段。
 */
export const emitControlPlaneAudit = (
  record: ControlPlaneAuditRecord,
  sink: AuditSink = noopAuditSink,
): void => {
  sink.write(record);
};
