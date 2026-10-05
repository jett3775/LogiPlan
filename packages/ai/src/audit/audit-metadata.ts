import type { GatewayErrorCode } from "../gateway/gateway-error-code";
import type { AiRole } from "../routing/role-routing";

/**
 * 审计元数据（docs/gate2-design.md §8、D-138、D-174）。
 *
 * 只记录最小必要运行元数据：时间、环境、`request_id`、角色、供应商、模型、
 * 适配器/提示词/输出模式/价格版本、标准化 token、延迟、成本估算、HTTP 状态、
 * 标准化错误码、是否被取消、是否回退固定示例。
 *
 * 禁止记录自然语言问题全文、模型回答全文、证据正文或值、固定示例正文、
 * Cookie、Authorization、数据库连接信息、原始 IP、完整请求头（D-138）。
 */

export interface AiAuditMetadata {
  readonly request_id: string;
  readonly occurred_at: string;
  readonly environment: string;
  readonly role: AiRole;
  readonly provider: string;
  readonly model: string;
  readonly adapter_version: string;
  readonly system_prompt_version: string;
  readonly output_schema_version: string;
  readonly price_version: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly latency_ms: number;
  readonly cost_estimate_usd: number;
  readonly http_status: number | null;
  readonly error_code: GatewayErrorCode | null;
  readonly cancelled: boolean;
  readonly fell_back_to_fixed_example: boolean;
}

/** 允许记录的字段名，顺序与 `AiAuditMetadata` 一致；测试逐项核对。 */
export const AI_AUDIT_FIELD_NAMES = [
  "request_id",
  "occurred_at",
  "environment",
  "role",
  "provider",
  "model",
  "adapter_version",
  "system_prompt_version",
  "output_schema_version",
  "price_version",
  "input_tokens",
  "output_tokens",
  "latency_ms",
  "cost_estimate_usd",
  "http_status",
  "error_code",
  "cancelled",
  "fell_back_to_fixed_example",
] as const;

export type AiAuditFieldName = (typeof AI_AUDIT_FIELD_NAMES)[number];

/**
 * 明确禁止出现在审计元数据里的内容类别（D-138）。测试断言
 * `AI_AUDIT_FIELD_NAMES` 与该集合不相交，防止后续切片把正文塞进日志。
 */
export const AI_AUDIT_FORBIDDEN_CONTENT_KINDS = [
  "natural_language_question",
  "model_answer_text",
  "evidence_body",
  "evidence_value",
  "fixed_example_text",
  "cookie",
  "authorization",
  "database_connection",
  "raw_ip",
  "full_user_agent",
  "request_headers",
] as const;

export type AiAuditForbiddenContentKind = (typeof AI_AUDIT_FORBIDDEN_CONTENT_KINDS)[number];
