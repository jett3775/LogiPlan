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

/* ---------------------------------------------------------------------------
 * 切片 2：成本包围（匿名标识 / 限流 / 费用 / 两级熔断 / 可观测性）
 * docs/gate2-implementation-plan.md §4、docs/decisions.md D-181、D-190。
 * 本切片**不发起任何真实模型调用**；`evaluateControlPlane` 只产出「是否允许真实调用」。
 * ------------------------------------------------------------------------- */

export {
  ANON_ID_DERIVATION_VERSION,
  anonymousDayStamp,
  dailyAnonymousKey,
  deriveAnonymousId,
  digestUserAgent,
  normalizeIp,
  type AnonymousIdInput,
} from "./control-plane/anonymous-id";
export {
  ControlPlaneUnavailableError,
  isBudgetReserveOutcome,
  isBudgetSettleOutcome,
  isSlidingWindowOutcome,
  type BudgetReserveOutcome,
  type BudgetSettleOutcome,
  type RedisLike,
  type SlidingWindowOutcome,
} from "./control-plane/redis-like";
export {
  checkRateLimit,
  rateLimitKey,
  RATE_LIMIT_MAX_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
  type RateLimitDecision,
  type RateLimitInput,
} from "./control-plane/rate-limit";
export {
  deriveBudgetThreshold,
  estimateCostCny,
  estimateCostUsd,
  fxRateFor,
  FX_VERSION_V1,
  isThresholdCurrent,
  MAX_INPUT_TOKENS,
  MONTHLY_BUDGET_CNY,
  PRICE_VERSION_V1,
  priceTableFor,
  SAFETY_MARGIN,
  USD_CNY_RATE_V1,
  usdToCny,
  type BudgetThreshold,
  type ModelPrice,
  type TokenUsage,
} from "./control-plane/pricing";
export {
  budgetLedgerKey,
  monthStamp,
  readMonthlyUsage,
  reserveBudget,
  reserveFailureErrorCode,
  settleBudget,
  type BudgetReserveInput,
  type BudgetReserveResult,
  type BudgetSettleInput,
  type BudgetSettleResult,
  type MonthlyUsage,
  type MonthlyUsageInput,
} from "./control-plane/budget-ledger";
export {
  isMonthlyBudgetBreached,
  isTransientFailure,
  L1CircuitBreaker,
  L1_CONSECUTIVE_FAILURE_THRESHOLD,
  L1_WINDOW_MS,
  TRANSIENT_FAILURE_CODES,
  type CircuitBreakerOptions,
  type CircuitState,
} from "./control-plane/circuit-breaker";
export {
  buildControlPlaneAuditRecord,
  CONTROL_PLANE_AUDIT_EVENTS,
  CONTROL_PLANE_AUDIT_FIELD_NAMES,
  emitControlPlaneAudit,
  noopAuditSink,
  type AuditSink,
  type ControlPlaneAuditEvent,
  type ControlPlaneAuditFieldName,
  type ControlPlaneAuditRecord,
  type ControlPlaneCircuitState,
} from "./control-plane/audit-log";
export {
  CONTROL_PLANE_ENV_KEYS,
  CONTROL_PLANE_TIMEOUT_MS,
  controlPlaneUnavailableDecision,
  DEFAULT_ROLE_COST_PROFILES,
  evaluateControlPlane,
  recordProviderAttemptOutcome,
  type ControlPlaneClock,
  type ControlPlaneConfig,
  type ControlPlaneDecision,
  type ControlPlaneDeps,
  type ControlPlaneRequest,
  type ControlPlaneRuntime,
  type CreateControlPlaneOptions,
  type RoleCostProfile,
} from "./control-plane/control-plane";
// 服务端装配入口（含 Upstash Redis 客户端）**不**从主 barrel 导出：主 barrel 被客户端
// 组件消费，导出它会把服务端基础设施打进浏览器包（P1-1）。改用子路径 `@logiplan/ai/server`
// （见 `packages/ai/package.json` 的 `exports` 与 `control-plane/server.ts`）。
export {
  defaultRetryHooks,
  HARD_TIMEOUT_MS,
  invokeWithRetry,
  isRetryableError,
  MAX_ATTEMPTS,
  runWithHardTimeout,
  type AttemptOutcome,
  type RetryHooks,
  type TimedResult,
} from "./gateway/retry-policy";
