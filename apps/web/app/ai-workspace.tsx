"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { managementAnalysisSchema } from "@logiplan/contracts";
import type { ManagementAnalysis, RichSection } from "@logiplan/contracts";
import {
  EvidenceSnapshotStore,
  FEASIBILITY_STATUS_ZH,
  SCENARIO_VALIDATION_STATUS_ZH,
  type EvidenceSnapshot,
} from "@logiplan/ai";

import {
  AI_QUESTION_MAX_CODE_POINTS,
  ANSWER_TYPE_ZH,
  AI_RESPOND_STATUS_ZH,
  FIXED_EXAMPLE_SNAPSHOT_VERSIONS,
  aiPageAddressFromLocation,
  bindAiEvidenceAddress,
  type AiAnswerBlock,
  type AiRespondBody,
  type AiRespondStatusCode,
  type AiEvidenceEntry,
} from "./lib/ai-model";
import styles from "./workspace.module.css";

/**
 * 闸门二 AI 管理分析区块（docs/gate2-implementation-plan.md 切片 1b 执行步骤 6）。
 *
 * ## 为什么五区块在提交问题之后才渲染
 *
 * 归因页已有一块静态「AI 管理分析」面板，它的「限制」标签里就写着
 * 「相关性不等于因果 · 不得推断未记录的经营因果」（`attribution-workspace.tsx:764`），
 * 而 `apps/web/tests/gate1.spec.ts` 用**非精确**正则 `getByText(/相关性不等于因果/u)`
 * 断言它可见。若本区块无条件渲染限制标签，同一句中文会出现两处，
 * Playwright 严格模式即报「resolved to 2 elements」——那是闸门一验收标准的回归
 * （AC1.1 要求既有测试零改动且全绿）。
 *
 * 因此本区块以「分析师先提问、页面再回答」为触发条件：未提问时只渲染表单，
 * 五区块与限制标签一律不出现；提问后才渲染。这样既满足本切片的呈现要求，
 * 又不触碰既有断言，也符合 `gate2-design.md` §7——所有失败矩阵的触发条件都源自「输入」。
 */
export function AiWorkspace() {
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState<AiRespondStatusCode | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AiAnswerBlock | null>(null);
  const [snapshotNote, setSnapshotNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setSnapshotNote(null);
    try {
      const response = await fetch("/api/v1/ai/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          page_address: aiPageAddressFromLocation(window.location.href),
        }),
      });
      const body = (await response.json()) as AiRespondBody;
      if (!body.ok) {
        setAnswer(null);
        setStatus(body.status);
        setDetail(body.message_zh);
        return;
      }
      const parsed = managementAnalysisSchema.safeParse(body.answer.analysis);
      if (!parsed.success) {
        setAnswer(null);
        setStatus("EVIDENCE_WHITELIST_VIOLATION");
        setDetail("服务端回答未通过输出契约校验，管理分析已整体丢弃；归因页数字与证据不受影响。");
        return;
      }
      setAnswer({ ...body.answer, analysis: parsed.data });
      setStatus("FIXED_EXAMPLE");
      setDetail(null);
      setSnapshotNote(writeAnswerSnapshot(body.answer, parsed.data));
    } catch {
      setAnswer(null);
      setStatus("DETERMINISTIC_SOURCE_UNAVAILABLE");
      setDetail("管理分析服务暂时不可用，请稍后重试；归因页数字与证据不受影响。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.panel} aria-labelledby="ai-question-title">
      <div className={styles.sectionHeading}>
        <div>
          <span className={styles.eyebrow}>闸门二 · 供应商中立层</span>
          <h2 id="ai-question-title">AI 管理分析提问</h2>
        </div>
        <span className={styles.aiBadge}>本切片不调用模型</span>
      </div>
      <p className={styles.aiScope}>
        只提交自然语言问题与页面范围地址；证据由服务端按当前页面范围解析，浏览器不能指定证据。
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="ai-question">管理分析问题（最多 {AI_QUESTION_MAX_CODE_POINTS} 字）</label>
        <textarea
          id="ai-question"
          name="question"
          rows={2}
          value={question}
          required
          maxLength={AI_QUESTION_MAX_CODE_POINTS}
          aria-describedby="ai-question-hint"
          onChange={(event) => setQuestion(event.target.value)}
        />
        <p id="ai-question-hint" className={styles.aiScope}>
          例：英国本月履约变动成本为什么超出 Budget？
        </p>
        <button type="submit" className={styles.primaryButton} disabled={busy}>
          {busy ? "正在生成管理分析…" : "获取管理分析"}
        </button>
      </form>
      {status !== null ? (
        <p role="status">
          回答状态：{AI_RESPOND_STATUS_ZH[status]}
          {detail !== null ? `（${detail}）` : ""}
        </p>
      ) : (
        <p className={styles.aiScope}>
          尚未提问：提交问题后展示结论、证据、影响、建议与限制五个区块。
        </p>
      )}
      {snapshotNote !== null ? <p className={styles.limitNote}>{snapshotNote}</p> : null}
      {answer !== null ? <Answer answer={answer} /> : null}
    </section>
  );
}

function Answer({ answer }: { answer: AiAnswerBlock }) {
  const analysis = answer.analysis;
  return (
    <div>
      <p className={styles.aiScope}>
        范围：{answer.scope_label}；答案类型：{ANSWER_TYPE_ZH[answer.answer_type]}
      </p>
      <section aria-labelledby="ai-section-conclusion">
        <h3 id="ai-section-conclusion">结论</h3>
        <RichSectionBody section={analysis.conclusion} index={answer.evidence} />
      </section>
      <section aria-labelledby="ai-section-evidence">
        <h3 id="ai-section-evidence">证据</h3>
        <RichSectionBody section={analysis.evidence} index={answer.evidence} />
      </section>
      <section aria-labelledby="ai-section-impact">
        <h3 id="ai-section-impact">影响</h3>
        <RichSectionBody section={analysis.impact} index={answer.evidence} />
      </section>
      <section aria-labelledby="ai-section-recommendations">
        <h3 id="ai-section-recommendations">建议</h3>
        <ol>
          {analysis.recommendations.map((item, position) => (
            <li key={`${position}-${item.text.slice(0, 12)}`}>
              <p>{item.text}</p>
              <p>
                <span className={styles.statusLabel}>
                  情景计算：{SCENARIO_VALIDATION_STATUS_ZH[item.scenario_validation_status]}
                </span>
                <span className={styles.statusLabel}>
                  可行性：{FEASIBILITY_STATUS_ZH[item.feasibility_status]}
                </span>
              </p>
              <EvidenceLinks ids={item.evidence_ids} index={answer.evidence} />
            </li>
          ))}
        </ol>
      </section>
      <section aria-labelledby="ai-section-limitations">
        <h3 id="ai-section-limitations">限制</h3>
        <p>{analysis.limitations.text}</p>
        <ul>
          {(analysis.limitations.status_labels ?? []).map((label) => (
            <li key={label}>
              <span className={styles.limitLabel}>{label}</span>
            </li>
          ))}
        </ul>
        <EvidenceLinks ids={analysis.limitations.evidence_ids} index={answer.evidence} />
      </section>
    </div>
  );
}

/**
 * 区块正文 + 该区块引用到的证据链接。
 *
 * 只对 `evidence_ids` 里的证据渲染链接：固定示例把 E08／E09 的三个数字放在
 * `limitations.text` 里且**不给**证据 ID（那三个数字在本页范围内没有可解析的证据对象，
 * 见 `fixed-example.ts` 的范围纪律），因此它们天然呈现为不可点开的口径说明。
 */
function RichSectionBody({
  section,
  index,
}: {
  section: RichSection;
  index: readonly AiEvidenceEntry[];
}) {
  return (
    <>
      <p>{section.text}</p>
      <EvidenceLinks ids={section.evidence_ids} index={index} />
    </>
  );
}

function EvidenceLinks({
  ids,
  index,
}: {
  ids: readonly string[];
  index: readonly AiEvidenceEntry[];
}) {
  if (ids.length === 0) return null;
  return (
    <ul>
      {ids.map((id) => {
        const entry = index.find((candidate) => candidate.evidence_id === id);
        if (entry === undefined) return null;
        const url = new URL("/attribution", window.location.origin);
        bindAiEvidenceAddress(url, entry);
        return (
          <li key={id}>
            <Link
              className={styles.inlineLink}
              href={`${url.pathname}${url.search}`}
              aria-label={`打开数字证据：${entry.label_zh} ${entry.value} ${entry.unit}`}
            >
              {entry.label_zh}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 把回答绑定的确定性结果写成**本页不可变快照**（`gate2-design.md` §4.1、D-190 决策四）。
 *
 * 键名是 `logiplan.ai.snapshot.<snapshot_id>`，而 `snapshot_id` 就是服务端用真实确定性结果
 * 绑定进来的 `ES-<uuid>`；因此这份快照是数据库快照在本标签页的不可变副本，两者同源。
 *
 * ## 失败态一律统一处理（交接要点 3）
 *
 * `SnapshotWriteResult` 有五个失败态：`rejected_too_large`、`rejected_reserved_id`、
 * `rejected_invalid_id`、`storage_unavailable`，以及写入本身不成立的情形。逐个列举会让
 * 新增失败态静默漏处理，所以这里只判一次 `status !== "written"`：非 `written` 即回落
 * 固定示例（当前渲染的本来就是固定示例），并且**不**声称快照可用。
 */
function writeAnswerSnapshot(answer: AiAnswerBlock, analysis: ManagementAnalysis): string {
  try {
    const store = new EvidenceSnapshotStore({
      storage: window.sessionStorage,
      clock: { now: () => Date.now() },
    });
    const snapshot: EvidenceSnapshot = {
      snapshot_id: analysis.evidence_snapshot_id,
      captured_at: new Date().toISOString(),
      versions: FIXED_EXAMPLE_SNAPSHOT_VERSIONS,
      payload: answer.snapshot_seed,
    };
    const written = store.write(snapshot);
    if (written.status !== "written") return "本页证据快照未能保存，已按固定示例呈现。";
    const restored = store.restore(snapshot.snapshot_id, FIXED_EXAMPLE_SNAPSHOT_VERSIONS);
    if (restored.status !== "restored") return "本页证据快照校验未通过，已按固定示例呈现。";
    return "本页证据快照已保存在本标签页并通过版本校验。";
  } catch {
    return "本页证据快照不可用，已按固定示例呈现。";
  }
}
