/**
 * `@logiplan/ai`：供应商中立的编排层（docs/gate2-design.md §1.2）。
 *
 * 依赖方向单向：本包只依赖 `@logiplan/contracts` 与已在锁文件中的通用库，
 * **不得**导入任何供应商 SDK、供应商错误类型或供应商响应结构。
 * 供应商适配器落在独立包 `packages/ai-provider-*`，反向依赖本包。
 */

export {
  GATEWAY_ERROR_CODES,
  isGatewayErrorCode,
  type GatewayErrorCode,
} from "./gateway/gateway-error-code";
export {
  FAIL_CLOSED_TRIGGERS,
  allFailClosedDecisions,
  decideFailClosed,
  type FailClosedDecision,
  type FailClosedOutcome,
  type FailClosedSource,
  type FailClosedTrigger,
} from "./gateway/fail-closed";
export {
  PROVIDER_CAPABILITY_NAMES,
  allCapabilitiesGranted,
  capabilityGate,
  missingRequiredCapabilities,
  noCapabilitiesGranted,
  type CapabilityGate,
  type ProviderCapabilities,
  type ProviderCapabilityName,
} from "./adapter/provider-capabilities";
export type {
  AdapterCostEstimate,
  AdapterRequest,
  AdapterResult,
  AdapterUsage,
  ProviderAdapter,
} from "./adapter/adapter-contract";
export {
  AI_ROLES,
  isAiRole,
  resolveRoleRoute,
  resolveRoleRouteWithCapabilities,
  type AiRole,
  type RoleRouteCapabilityResolution,
  type RoleRouteConfig,
  type RoleRouteResolution,
} from "./routing/role-routing";
export {
  AI_AUDIT_FIELD_NAMES,
  AI_AUDIT_FORBIDDEN_CONTENT_KINDS,
  type AiAuditFieldName,
  type AiAuditForbiddenContentKind,
  type AiAuditMetadata,
} from "./audit/audit-metadata";
export {
  FEASIBILITY_STATUS_ZH,
  GATEWAY_ERROR_STATUS_ZH,
  ORDER_GRAIN_LABEL_ZH,
  ORDER_LEVEL_NOT_AVAILABLE_MESSAGE_ZH,
  PROVIDER_CAPABILITY_ZH,
  REQUIRED_LIMITATION_LABEL_ZH,
  SCENARIO_NOT_RUN_LABEL_ZH,
  SCENARIO_VALIDATION_STATUS_ZH,
} from "./labels/zh-labels";
export {
  FIXED_EXAMPLE_EVALUATION_IDS,
  FIXED_EXAMPLE_EVALUATION_QUESTIONS,
  FIXED_EXAMPLE_SUPPORTED_NUMBERS,
  type EvaluationQuestion,
  type FixedExampleEvaluationId,
} from "./fixed-example/evaluation-baseline";
export {
  FIXED_EXAMPLE_DATA_RELEASE_ID,
  FIXED_EXAMPLE_NUMBERS,
  FIXED_EXAMPLE_OUTPUT_SCHEMA_VERSION,
  FIXED_EXAMPLE_SCOPE_LABEL,
  buildFixedExampleAnalysis,
} from "./fixed-example/fixed-example";
export {
  collectStrings,
  findUnsupportedNumbers,
  findUnsupportedSavingsClaims,
  inspectAnswerText,
  inspectText,
  isMoneyLikeToken,
  normalizeNumberToken,
  supportedFormsOf,
  type OutputGuardViolation,
} from "./fixed-example/output-guards";
export {
  SNAPSHOT_VERSION_FIELDS,
  checkSnapshotVersions,
  compareSnapshotVersions,
  snapshotVersionsSchema,
  type SnapshotVersionCheck,
  type SnapshotVersionField,
  type SnapshotVersionMismatch,
  type SnapshotVersions,
} from "./snapshot/snapshot-versions";
export type { EvidenceSnapshot, EvidenceSnapshotPayload } from "./snapshot/snapshot-payload";
export {
  EvidenceSnapshotStore,
  MAX_SNAPSHOTS_PER_TAB,
  MAX_SNAPSHOT_BYTES,
  RESERVED_SNAPSHOT_ID,
  SNAPSHOT_KEY_PREFIX,
  SNAPSHOT_LRU_INDEX_KEY,
  isReservedSnapshotId,
  snapshotByteLength,
  snapshotKey,
  type SessionStorageLike,
  type SnapshotClock,
  type SnapshotIndexEntry,
  type SnapshotRestoreResult,
  type SnapshotStoreOptions,
  type SnapshotWriteResult,
} from "./snapshot/snapshot-store";
