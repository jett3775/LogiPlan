import type { Pool } from "pg";
import {
  deterministicResultSchema,
  deterministicResultInputSchema,
  type QueryIntent,
  type QueryIntentV11,
} from "@logiplan/contracts";

import { canonicalJson, resultId } from "./query-result";
import type { DeterministicResult, QueryServiceError } from "./query-service";

/** Realtime queries always append; publisher materialization keeps its own idempotent path. */
export async function persistQueryEvidenceSnapshot(
  db: Pick<Pool, "query">,
  result: DeterministicResult,
  dataReleaseId: unknown,
): Promise<DeterministicResult> {
  const validated = deterministicResultInputSchema.parse(result);
  if (
    validated.contract_version !== "V1.1" ||
    !("contract_version" in validated.query_intent) ||
    validated.query_intent.evidence_snapshot_id !== undefined ||
    typeof dataReleaseId !== "string" ||
    dataReleaseId.length === 0 ||
    validated.evidence.some(
      (item) => item.evidence_snapshot_id !== undefined || item.data_release_id !== undefined,
    )
  )
    throw new Error("Invalid realtime snapshot input");
  const saved = await db.query(
    "SELECT logiplan.persist_query_evidence_snapshot($1::jsonb) AS result",
    [JSON.stringify({ ...validated, _data_release_id: dataReleaseId })],
  );
  if (saved.rowCount !== 1) throw new Error("Realtime snapshot save returned no unique result");
  const restored = deterministicResultSchema.parse(saved.rows[0]?.result);
  const snapshotId = restored.evidence[0]?.evidence_snapshot_id;
  if (
    restored.evidence.some(
      (item) =>
        !/^ES-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
          item.evidence_snapshot_id ?? "",
        ) ||
        item.evidence_snapshot_id !== snapshotId ||
        item.data_release_id !== dataReleaseId,
    )
  )
    throw new Error("Realtime snapshot save returned invalid binding");
  const expected = {
    ...validated,
    evidence: validated.evidence.map((item) => ({
      ...item,
      evidence_snapshot_id: snapshotId,
      data_release_id: dataReleaseId,
    })),
  };
  if (validated.query_intent.question_type === "EVIDENCE_LOOKUP") {
    expected.payload = { evidence: expected.evidence[0] };
  }
  // JSON normalization matches the database wire representation of optional fields.
  if (canonicalJson(restored) !== canonicalJson(JSON.parse(JSON.stringify(expected)))) {
    throw new Error("Realtime snapshot save changed the deterministic result");
  }
  return restored;
}

export async function persistEvidenceSnapshot(
  db: Pick<Pool, "query">,
  result: DeterministicResult,
  dataReleaseId: string,
): Promise<DeterministicResult> {
  const validated = deterministicResultInputSchema.parse(result);
  if (validated.evidence.length === 0) return validated;
  const saved = await db.query("SELECT logiplan.persist_evidence_snapshot($1::jsonb) AS result", [
    JSON.stringify({ ...validated, _data_release_id: dataReleaseId }),
  ]);
  return deterministicResultSchema.parse(saved.rows[0]?.result);
}

export async function lookupEvidenceSnapshot(
  db: Pick<Pool, "query">,
  intent: QueryIntentV11,
  requestId: string,
): Promise<DeterministicResult | QueryServiceError> {
  const failure = (code: QueryServiceError["code"], message_zh: string): QueryServiceError => ({
    error_id: `ERR-${requestId}`,
    code,
    message_zh,
    request_id: requestId,
  });
  const rows = await db.query(
    `SELECT s.result, NOT EXISTS (
       SELECT 1 FROM logiplan.active_release a WHERE a.data_release_id = s.data_release_id
     ) AS historical
     FROM logiplan.evidence_snapshot s WHERE s.evidence_snapshot_id = $1`,
    [intent.evidence_snapshot_id],
  );
  if (!rows.rows[0]) return failure("EVIDENCE_NOT_FOUND", "未找到精确匹配的证据快照");
  const saved = deterministicResultSchema.parse(rows.rows[0].result);
  const found = saved.evidence.find((item) => item.evidence_id === intent.evidence_id);
  if (!found) return failure("EVIDENCE_NOT_FOUND", "快照中不存在该 evidence_id");
  if (canonicalJson(saved.query_intent.scope) !== canonicalJson(intent.scope)) {
    return failure("INVALID_FILTER", "证据快照与请求范围不匹配");
  }
  if (
    rows.rows[0].historical !== true ||
    saved.warnings.some((warning) => warning.code === "HISTORICAL_VERSION")
  )
    return saved;
  return {
    ...saved,
    warnings: [
      ...saved.warnings,
      {
        code: "HISTORICAL_VERSION" as const,
        message: "证据快照来自非当前活动数据发布",
      },
    ],
  };
}

export async function findMaterializedSnapshot(
  db: Pick<Pool, "query">,
  intent: QueryIntent,
  dataReleaseId?: string,
): Promise<DeterministicResult | null> {
  const rows = await db.query(
    `SELECT s.result FROM logiplan.evidence_snapshot AS s
     WHERE s.result->>'result_id' = $1
       AND s.data_release_id = COALESCE($2, (SELECT data_release_id FROM logiplan.active_release))
     ORDER BY created_at DESC LIMIT 1`,
    [resultId(intent), dataReleaseId ?? null],
  );
  const row = rows.rows[0];
  return row === undefined ? null : deterministicResultSchema.parse(row.result);
}
