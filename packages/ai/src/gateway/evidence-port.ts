/**
 * 确定性证据注入端口（docs/gate2-design.md §1.2「确定性证据注入」、§4.3）。
 *
 * ## 为什么是「注入端口」而不是直接查询
 *
 * 设计 §1.1 的单向依赖**未允许** `packages/ai → packages/db` 这条边：确定性查询只能由
 * 服务端（`apps/web`）执行，`packages/ai` **不得** `import` `packages/db`。因此本文件只
 * 定义端口与白名单的**形状**，真实查询结果由调用方（`apps/web`）传入，本包只消费。
 *
 * ## 白名单是「范围锚定」的，不是全局扁平集合（§4.3 的 2026-10-05 注记）
 *
 * 服务端 `EVIDENCE_LOOKUP` 对范围不一致直接拒绝（`INVALID_FILTER`）。在英国归因范围下，
 * 公司口径证据（`E08-*`、`E04-total`、`FIXED_COST_BREAKDOWN:*`、`MONTHLY_COST_TREND:*`、
 * `TOP_ADVERSE_ANOMALIES:*`）**不可引用**。因此白名单必须**连同其范围锚点**一并注入：
 * 每个 `DeterministicResultSet` 自带 `scope_anchor`，白名单整体也带 `scope_anchor`。
 * 本包**不硬编码**任何证据 ID 或范围取值——两者都由调用方注入。
 */

/**
 * 一次确定性查询产出的结果集：证据 ID 与数值**绑定**同一结果、同一范围锚点。
 *
 * - `evidence_ids`：该结果集实际产出的 `EvidenceObject.evidence_id`（形态 `类型名:parts`）。
 * - `numbers`：该结果集产出的数值（`required_numbers` 形式，如 `574474.2232`、`0.1369`），
 *   用于输出三检第③检的数值回指。
 */
export interface DeterministicResultSet {
  readonly result_id: string;
  /** 范围锚点（服务端对 `AnalysisScope` 的规范化标识）；本包不解释其内部结构。 */
  readonly scope_anchor: string;
  readonly evidence_ids: readonly string[];
  readonly numbers: readonly string[];
}

/**
 * 服务端注入的证据白名单（范围锚定）。整体锚点 + 各结果集锚点必须一致（单范围白名单）。
 */
export interface EvidenceWhitelist {
  /** 本次回答允许引用的范围锚点；与调用方请求的范围锚点比对（范围不一致即失败）。 */
  readonly scope_anchor: string;
  readonly result_sets: readonly DeterministicResultSet[];
}

/**
 * 证据注入端口：由调用方（`apps/web`）用服务端确定性查询结果实现，`packages/ai` 只消费。
 * 端口是**唯一**的确定性事实入口，中立层不自行查询、不缓存。
 */
export interface EvidencePort {
  resolve(scopeAddress: string): EvidenceWhitelist | Promise<EvidenceWhitelist>;
}

/** 白名单里全部证据 ID 的去重并集。 */
export const allWhitelistedEvidenceIds = (whitelist: EvidenceWhitelist): readonly string[] => [
  ...new Set(whitelist.result_sets.flatMap((set) => set.evidence_ids)),
];

/** 白名单是否单范围（整体锚点与每个结果集锚点一致）。 */
export const whitelistIsSingleScope = (whitelist: EvidenceWhitelist): boolean =>
  whitelist.result_sets.every((set) => set.scope_anchor === whitelist.scope_anchor);
