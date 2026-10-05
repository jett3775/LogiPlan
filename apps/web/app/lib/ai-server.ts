import "server-only";

import { buildFixedExampleAnalysis } from "@logiplan/ai";
import { attributionFactorSchema } from "@logiplan/contracts";
import type { AttributionFactor, EvidenceObject } from "@logiplan/contracts";

import {
  AI_RESPOND_STATUS_ZH,
  PRIMARY_EVIDENCE_ID,
  bindAnswerToRealSnapshot,
  buildEvidenceWhitelist,
  type AiAnswerBlock,
  type AiRespondStatusCode,
} from "./ai-model";
import { loadAttributionData } from "./query-server";

/**
 * 服务端回答入口（docs/gate2-implementation-plan.md 切片 1b 执行步骤 5）。
 *
 * 浏览器只提交自然语言问题与页面范围地址；确定性查询与证据白名单组装**全部**在服务端
 * 完成。`MANAGEMENT_ANALYSIS` 在 `packages/db/src/query-service.ts:590` 是被拒绝的
 * question_type（「管理分析必须消费确定性结果集合，不能直接查询事实」），因此这里
 * **不经过** `POST /api/v1/query`，而是直接调用查询服务的函数。
 *
 * 本切片不调用任何模型：`answer_type` 恒为 `FIXED_EXAMPLE`
 * （`gate2-design.md` §7 的统一口径）。
 */

export type AiAnswerOutcome =
  | { readonly ok: true; readonly answer: AiAnswerBlock }
  | {
      readonly ok: false;
      readonly status: Exclude<AiRespondStatusCode, "FIXED_EXAMPLE">;
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

const unavailable = (): AiAnswerOutcome => ({
  ok: false,
  status: "DETERMINISTIC_SOURCE_UNAVAILABLE",
  message_zh: AI_RESPOND_STATUS_ZH.DETERMINISTIC_SOURCE_UNAVAILABLE,
});

const discarded = (detail: string): AiAnswerOutcome => ({
  ok: false,
  status: "EVIDENCE_WHITELIST_VIOLATION",
  message_zh: `${detail}，管理分析已整体丢弃；归因页数字与证据不受影响。`,
});

/** 产出管理分析回答。失败路径一律失败关闭（`gate2-design.md` §7）：不返回任何部分答案。 */
export const answerManagementQuestion = async (pageAddress: string): Promise<AiAnswerOutcome> => {
  let data;
  try {
    data = await loadAttributionData(factorFromPageAddress(pageAddress));
  } catch {
    return unavailable();
  }
  const binding = bindAnswerToRealSnapshot(
    buildFixedExampleAnalysis(),
    buildEvidenceWhitelist(data),
  );
  if (!binding.ok) {
    return discarded(`回答引用了 ${binding.missing.length} 条不在证据白名单内的内容`);
  }
  const primary: EvidenceObject | undefined = data.country.evidence.find(
    (item) => item.evidence_id === PRIMARY_EVIDENCE_ID,
  );
  if (primary === undefined || primary.evidence_snapshot_id === undefined) {
    return discarded("主证据对象缺失或未绑定真实快照");
  }
  const fixed = binding.analysis;
  return {
    ok: true,
    answer: {
      scope_label: fixed.scope_label,
      answer_type: fixed.answer_type,
      analysis: fixed,
      evidence: binding.cited,
      // 快照载荷取主证据所属的那次确定性结果，与 `evidence_snapshot_id` 的绑定来源同源。
      snapshot_seed: {
        query_intent: data.country.query_intent,
        deterministic_result: data.country,
        evidence: [primary],
      },
    },
  };
};
