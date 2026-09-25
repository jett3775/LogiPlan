"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  deterministicResultSchema,
  type AnalysisScope,
  type AttributionFactor,
  type EvidenceObject,
} from "@logiplan/contracts";

import {
  decimalCompare,
  formatDecimal,
  formatMoney,
  formatPlainDecimal,
  formatSignedMoney,
  isPositiveDecimal,
} from "./lib/format";
import {
  FACTORS,
  VERSIONS,
  attributionIntents,
  evidenceIntentFromUrl,
  bindEvidenceAddress,
  type AttributionData,
  type DeterministicResult,
  type DiagnosticValue,
  type DrilldownPayload,
  type DrilldownRow,
} from "./lib/model";
import styles from "./workspace.module.css";

const factorLabels: Record<AttributionFactor, string> = {
  VOLUME: "量",
  MIX: "结构",
  EFFICIENCY: "效率与异常",
  PRICE: "价",
  FX: "汇率",
};

const rootHref =
  `/?period=2026&comparison=LATEST_OUTLOOK_VS_BUDGET&budget=${VERSIONS.budget}` +
  `&actual=${VERSIONS.actual}&forecast=${VERSIONS.forecast}`;

const factorFromUrl = () => {
  const value = new URLSearchParams(window.location.search).get("factor");
  return FACTORS.find((factor) => factor === value) ?? null;
};

const pathFromUrl = () => {
  const value = new URLSearchParams(window.location.search).get("path");
  return value ? new Set(value.split("~").filter(Boolean)) : new Set<string>();
};

const evidenceFromUrl = () => new URLSearchParams(window.location.search).get("evidence_id");

function updateAddress(changes: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value.length === 0) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  window.history.pushState({}, "", `${url.pathname}?${url.searchParams.toString()}`);
}

const diagnosticText = (value: DiagnosticValue | null) => {
  if (!value) return "不适用";
  if (value.unit === "COUNT") return `${formatPlainDecimal(value.display)} 单`;
  if (value.unit === "PERCENT") return `${value.display}%`;
  if (value.unit === "PERCENTAGE_POINT") {
    return `${isPositiveDecimal(value.high_precision) ? "+" : ""}${value.display} 个百分点`;
  }
  return `${value.display}`;
};

function Waterfall({
  data,
  selected,
  onSelect,
}: {
  data: AttributionData["bridge"]["payload"];
  selected: AttributionFactor | null;
  onSelect: (factor: AttributionFactor) => void;
}) {
  const items = [
    { id: "BUDGET", label: "Budget", displayValue: data.baseline.display },
    ...data.factors.map((factor) => ({
      id: factor.factor_id,
      label: factor.label_zh,
      displayValue: factor.amount.display,
    })),
    { id: "ACTUAL", label: "Actual", displayValue: data.current.display },
  ];

  return (
    <div>
      <div>
        <svg viewBox="0 0 760 235" role="group" aria-labelledby="waterfall-title waterfall-desc">
          <title id="waterfall-title">英国履约变动成本五因素瀑布图</title>
          <desc id="waterfall-desc">
            等高柱只表示固定步骤顺序，不表示金额大小或累计位置。金额权威值见标签。依次展示
            Budget、量、结构、效率与异常、价、汇率和 Actual。
          </desc>
          {items.map((item, index) => {
            const x = 30 + index * 102;
            if (index === 0 || index === items.length - 1) {
              return (
                <g key={item.id}>
                  <rect x={x} y="58" width="64" height="132" rx="3" className={styles.totalBar} />
                  <text x={x + 32} y="48" textAnchor="middle" className={styles.waterfallValue}>
                    {formatPlainDecimal(item.displayValue)}
                  </text>
                  <text x={x + 32} y="215" textAnchor="middle" className={styles.chartLabel}>
                    {item.label}
                  </text>
                </g>
              );
            }
            const factor = item.id as AttributionFactor;
            return (
              <g
                key={item.id}
                role="button"
                tabIndex={0}
                aria-label={`${item.label}因素 ${item.displayValue} CNY`}
                aria-pressed={selected === factor}
                onClick={() => onSelect(factor)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(factor);
                  }
                }}
              >
                <rect
                  x={x}
                  y="92"
                  width="64"
                  height="64"
                  rx="3"
                  className={selected === factor ? styles.selectedFactorBar : styles.factorBar}
                />
                <line x1={x - 38} x2={x} y1="124" y2="124" className={styles.connector} />
                <text x={x + 32} y="82" textAnchor="middle" className={styles.waterfallValue}>
                  {isPositiveDecimal(data.factors[index - 1]?.amount.high_precision ?? "0")
                    ? "+"
                    : ""}
                  {formatPlainDecimal(item.displayValue)}
                </text>
                <text x={x + 32} y="215" textAnchor="middle" className={styles.chartLabel}>
                  {item.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className={styles.limitNote}>
        等高步骤图：柱体仅编码顺序与选择状态，不编码金额大小或方向。
      </p>
      <div className={styles.factorCommands} aria-label="五因素筛选">
        {data.factors.map((factor) => (
          <button
            key={factor.factor_id}
            type="button"
            aria-pressed={selected === factor.factor_id}
            onClick={() => onSelect(factor.factor_id)}
          >
            <span>
              {factor.sequence}. {factor.label_zh}
            </span>
            <strong>{formatSignedMoney(factor.amount)}</strong>
          </button>
        ))}
      </div>
    </div>
  );
}

function EvidenceDrawer({
  evidence,
  notFound,
  onClose,
  onLocate,
  loading,
  error,
  scopeMismatch,
}: {
  evidence: EvidenceObject | null;
  notFound: boolean;
  onClose: () => void;
  onLocate: (() => void) | null;
  loading: boolean;
  error: string | null;
  scopeMismatch: boolean;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <aside
      className={styles.evidencePanel}
      role="dialog"
      aria-label="数字证据侧栏"
      aria-modal="false"
    >
      <div className={styles.panelHeader}>
        <div>
          <span className={styles.eyebrow}>不可变查询证据</span>
          <h2>{notFound ? "未找到数字证据" : evidence?.metric}</h2>
        </div>
        <button
          ref={closeRef}
          type="button"
          className={styles.iconButton}
          onClick={onClose}
          aria-label="关闭数字证据侧栏"
        >
          ×
        </button>
      </div>
      {loading ? (
        <p className={styles.loadingState}>正在读取精确证据…</p>
      ) : error ? (
        <p className={styles.errorState}>{error}</p>
      ) : notFound ? (
        <p className={styles.errorState}>
          该 evidence_id 不存在于当前固定范围，请返回页面数字重新打开。
        </p>
      ) : evidence ? (
        <>
          {scopeMismatch ? (
            <p className={styles.scopeBadge} role="status">
              证据范围与当前页面不同，仍显示原查询快照。
            </p>
          ) : null}
          <dl className={styles.evidenceList}>
            <div>
              <dt>证据 ID</dt>
              <dd>{evidence.evidence_id}</dd>
            </div>
            <div>
              <dt>数值</dt>
              <dd>
                {evidence.value} {evidence.unit}
              </dd>
            </div>
            <div>
              <dt>期间</dt>
              <dd>
                {evidence.period.from} 至 {evidence.period.to}
              </dd>
            </div>
            <div>
              <dt>比较</dt>
              <dd>{evidence.comparison}</dd>
            </div>
            <div>
              <dt>筛选</dt>
              <dd>
                {Object.entries(evidence.filters)
                  .map(([key, value]) => `${key}=${value.join(",")}`)
                  .join("；") || "无"}
              </dd>
            </div>
            <div>
              <dt>分组</dt>
              <dd>{evidence.group_by.join(" → ") || "汇总"}</dd>
            </div>
            <div>
              <dt>版本</dt>
              <dd>
                {evidence.versions.budget} / {evidence.versions.actual}
              </dd>
            </div>
            <div>
              <dt>计算版本</dt>
              <dd>{evidence.versions.calculation}</dd>
            </div>
            <div>
              <dt>计算方法</dt>
              <dd>{evidence.calculation_method}</dd>
            </div>
            <div>
              <dt>来源结果</dt>
              <dd>{evidence.source_result_id}</dd>
            </div>
            <div>
              <dt>生成时间</dt>
              <dd>{evidence.snapshot_generated_at}</dd>
            </div>
            <div>
              <dt>数据发布</dt>
              <dd>{evidence.data_release_id}</dd>
            </div>
            <div>
              <dt>证据快照</dt>
              <dd>{evidence.evidence_snapshot_id}</dd>
            </div>
          </dl>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={onLocate ?? undefined}
            disabled={!onLocate}
          >
            在表格中定位
          </button>
        </>
      ) : null}
    </aside>
  );
}

export function AttributionWorkspace({
  initialData,
  initialFactor,
  initialPath,
  initialEvidenceId,
  initialGuide,
}: {
  initialData: AttributionData;
  initialFactor: AttributionFactor | null;
  initialPath: string[];
  initialEvidenceId: string | null;
  initialGuide: number;
}) {
  const [selectedFactor, setSelectedFactor] = useState<AttributionFactor | null>(initialFactor);
  const [drilldown, setDrilldown] = useState(initialData.drilldown);
  const [expanded, setExpanded] = useState(new Set(initialPath));
  const [evidenceId, setEvidenceId] = useState(initialEvidenceId);
  const [resolvedEvidence, setResolvedEvidence] = useState<EvidenceObject | null>(null);
  const [evidenceScope, setEvidenceScope] = useState<AnalysisScope | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [guideStep, setGuideStep] = useState(initialGuide);
  const [loading, setLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const activeScope = useRef(
    JSON.stringify(attributionIntents(initialFactor ?? undefined).drilldown.scope),
  );
  const evidenceTrigger = useRef<HTMLButtonElement | null>(null);
  const evidenceRequestSequence = useRef(0);
  const evidenceController = useRef<AbortController | null>(null);

  const fetchEvidence = async (id: string | null) => {
    evidenceController.current?.abort();
    const controller = new AbortController();
    evidenceController.current = controller;
    const sequence = ++evidenceRequestSequence.current;
    setEvidenceError(null);
    if (!id) {
      setResolvedEvidence(null);
      setEvidenceScope(null);
      setEvidenceLoading(false);
      return;
    }
    setResolvedEvidence(null);
    setEvidenceLoading(true);
    try {
      const response = await fetch("/api/v1/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          evidenceIntentFromUrl(
            new URL(window.location.href),
            id,
            attributionIntents().country.scope,
          ),
        ),
        signal: controller.signal,
      });
      const body: unknown = await response.json();
      const parsed = deterministicResultSchema.safeParse(body);
      if (!response.ok || !parsed.success) {
        const message =
          body !== null &&
          typeof body === "object" &&
          "message_zh" in body &&
          typeof body.message_zh === "string"
            ? body.message_zh
            : "证据查询失败，请从页面数字重新打开。";
        throw new Error(message);
      }
      if (sequence === evidenceRequestSequence.current && !controller.signal.aborted) {
        const item = parsed.data.evidence.find((candidate) => candidate.evidence_id === id) ?? null;
        setResolvedEvidence(item);
        setEvidenceScope(item ? parsed.data.query_intent.scope : null);
        if (item) {
          const url = new URL(window.location.href);
          bindEvidenceAddress(url, item, parsed.data.query_intent.scope);
          window.history.replaceState({}, "", url);
        }
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (sequence === evidenceRequestSequence.current) {
        setEvidenceError(cause instanceof Error ? cause.message : "证据查询失败，请重试。");
      }
    } finally {
      if (sequence === evidenceRequestSequence.current) setEvidenceLoading(false);
    }
  };

  const selectedEvidence = resolvedEvidence;

  const fetchDrilldown = async (factor: AttributionFactor | null) => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    const sequence = ++requestSequence.current;
    const query = attributionIntents(factor ?? undefined).drilldown;
    const scopeKey = JSON.stringify(query.scope);
    activeScope.current = scopeKey;
    setLoading(true);
    setQueryError(null);
    try {
      const response = await fetch("/api/v1/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(query),
        signal: nextController.signal,
      });
      const body: unknown = await response.json();
      if (!response.ok || body === null || typeof body !== "object" || !("payload" in body)) {
        throw new Error("归因明细查询失败，请重试。");
      }
      if (sequence !== requestSequence.current || scopeKey !== activeScope.current) return;
      const parsed = deterministicResultSchema.safeParse(body);
      if (!parsed.success || parsed.data.query_intent.scope.factor_id !== (factor ?? undefined)) {
        throw new Error("归因明细来源范围与请求不一致，请重试。");
      }
      setDrilldown(body as DeterministicResult<DrilldownPayload>);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (sequence === requestSequence.current && scopeKey === activeScope.current) {
        setQueryError(cause instanceof Error ? cause.message : "归因明细查询失败，请重试。");
      }
    } finally {
      if (sequence === requestSequence.current && scopeKey === activeScope.current)
        setLoading(false);
    }
  };

  useEffect(() => {
    const onPopState = () => {
      const factor = factorFromUrl();
      setSelectedFactor(factor);
      setExpanded(pathFromUrl());
      const evidenceId = evidenceFromUrl();
      setEvidenceId(evidenceId);
      void fetchEvidence(evidenceId);
      const nextScope = JSON.stringify(attributionIntents(factor ?? undefined).drilldown.scope);
      if (nextScope !== activeScope.current) void fetchDrilldown(factor);
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      controller.current?.abort();
      evidenceController.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!initialEvidenceId) return;
    const timer = window.setTimeout(() => void fetchEvidence(initialEvidenceId), 0);
    return () => window.clearTimeout(timer);
  }, [initialEvidenceId]);

  const selectFactor = (factor: AttributionFactor) => {
    const next = selectedFactor === factor ? null : factor;
    setSelectedFactor(next);
    updateAddress({ factor: next });
    void fetchDrilldown(next);
  };

  const setPath = (next: Set<string>) => {
    setExpanded(next);
    updateAddress({ path: [...next].join("~") || null });
  };

  const toggleRow = (row: DrilldownRow) => {
    if (!row.children_available) return;
    const next = new Set(expanded);
    if (next.has(row.row_id)) next.delete(row.row_id);
    else next.add(row.row_id);
    setPath(next);
  };

  const sourceFactor = drilldown.query_intent.scope.factor_id ?? null;
  const rowsReady = !loading && !queryError && sourceFactor === selectedFactor;
  const visibleRows = useMemo(() => {
    const result: DrilldownRow[] = [];
    const children = (parent: string | null) =>
      drilldown.payload.rows
        .filter((row) => row.parent_row_id === parent)
        .toSorted((left, right) => {
          const leftValue = sourceFactor
            ? left.factor_contributions[sourceFactor].high_precision
            : left.variance.high_precision;
          const rightValue = sourceFactor
            ? right.factor_contributions[sourceFactor].high_precision
            : right.variance.high_precision;
          return (
            decimalCompare(rightValue, leftValue) ||
            left.label_zh.localeCompare(right.label_zh, "zh-CN")
          );
        });
    const append = (parent: string | null) => {
      for (const row of children(parent)) {
        result.push(row);
        if (expanded.has(row.row_id)) append(row.row_id);
      }
    };
    append(null);
    return result;
  }, [drilldown.payload.rows, expanded, sourceFactor]);

  const openEvidence = (
    id: string,
    trigger: HTMLButtonElement,
    rowSource?: DeterministicResult<DrilldownPayload>,
  ) => {
    if (!id) return;
    if (rowSource && !rowsReady) return;
    const source =
      rowSource ??
      [initialData.country, initialData.bridge, initialData.diagnostics, drilldown].find((result) =>
        result.evidence.some((item) => item.evidence_id === id),
      );
    const item = source?.evidence.find((item) => item.evidence_id === id);
    if (!source || !item?.evidence_snapshot_id) return;
    evidenceTrigger.current = trigger;
    setEvidenceId(id);
    updateAddress({
      period: "2026-08",
      comparison: "ACTUAL_VS_BUDGET",
      destination: "GB",
      budget: VERSIONS.budget,
      actual: VERSIONS.actual,
      method: "CHAIN",
      evidence_id: id,
      evidence_snapshot_id: item?.evidence_snapshot_id ?? null,
      evidence_scope: source ? JSON.stringify(source.query_intent.scope) : null,
    });
    void fetchEvidence(id);
  };

  const closeEvidence = () => {
    setEvidenceId(null);
    updateAddress({ evidence_id: null, evidence_snapshot_id: null, evidence_scope: null });
    void fetchEvidence(null);
    window.setTimeout(() => evidenceTrigger.current?.focus(), 0);
  };

  const locateEvidence = selectedEvidence?.filters.row_id?.[0]
    ? () => {
        const rowId = selectedEvidence.filters.row_id?.[0];
        if (!rowId) return;
        const parts = rowId.split("/");
        const next = new Set(expanded);
        for (let index = 1; index < parts.length; index += 1) {
          next.add(parts.slice(0, index).join("/"));
        }
        setPath(next);
        window.setTimeout(() => document.getElementById(rowId)?.focus(), 0);
      }
    : null;

  const guideAdvance = () => {
    if (guideStep === 3) {
      setGuideStep(4);
      if (selectedFactor !== "MIX") {
        setSelectedFactor("MIX");
        updateAddress({ factor: "MIX", guide: "4" });
        void fetchDrilldown("MIX");
      }
      const path = new Set([
        "FC:DE_FC",
        "FC:DE_FC/MODE:AIR",
        "FC:DE_FC/MODE:AIR/CARRIER:CARRIER_C",
      ]);
      setPath(path);
    } else setGuideStep(0);
  };

  return (
    <div className={styles.workspace}>
      <aside className={styles.rail} aria-label="分析工作台导航">
        <div className={styles.brand}>
          <span className={styles.brandMark}>LP</span>
          <div>
            <strong>LogiPlan</strong>
            <span>物流财务分析</span>
          </div>
        </div>
        <nav>
          <Link href={rootHref}>预算执行驾驶舱</Link>
          <Link className={styles.activeNav} href="/attribution">
            英国异常归因
          </Link>
        </nav>
        <div className={styles.scopeCard}>
          <span className={styles.eyebrow}>只读分析范围</span>
          <strong>2026-08 · 英国</strong>
          <span>Actual vs Budget</span>
          <span>CHAIN 连环替代</span>
          <span>不分摊固定成本</span>
        </div>
        <Link className={styles.backLink} href={rootHref}>
          ← 返回驾驶舱
        </Link>
      </aside>

      <main className={styles.main}>
        <header className={styles.pageHeader}>
          <div>
            <span className={styles.eyebrow}>核心异常纵向切片</span>
            <h1>英国履约变动成本归因</h1>
            <p>从成本结果、业务诊断到五因素、四级下钻与数字证据。</p>
          </div>
          <div className={styles.scopePills} aria-label="当前范围">
            <span>2026-08</span>
            <span>英国</span>
            <span>Actual vs Budget</span>
            <span>CHAIN</span>
          </div>
        </header>
        <div className={styles.disclosure} role="note">
          目的国页面只展示履约变动成本；仓租、基础人工、管理人工和系统费用不分摊至英国。
        </div>

        <section className={styles.summaryGrid} aria-label="英国成本摘要">
          <article>
            <span>Actual 履约变动成本</span>
            <strong>{formatMoney(initialData.country.payload.current)}</strong>
          </article>
          <article>
            <span>Budget 履约变动成本</span>
            <strong>{formatMoney(initialData.country.payload.baseline)}</strong>
          </article>
          <article>
            <span>不利差异</span>
            <strong className={styles.adverseText}>
              {formatSignedMoney(initialData.country.payload.variance)}
            </strong>
            <small>Actual − Budget</small>
          </article>
        </section>

        <section className={styles.diagnosticStrip} aria-label="经营与服务诊断指标">
          {initialData.diagnostics.payload.diagnostics.map((item) => (
            <article key={item.diagnostic_id}>
              <span>{item.label}</span>
              <strong>{diagnosticText(item.current)}</strong>
              {item.diagnostic_id === "SERVICE_MATURITY" ? (
                <small>{initialData.diagnostics.payload.service_evaluation.status_label_zh}</small>
              ) : (
                <small>
                  Budget {diagnosticText(item.baseline)} · 变化 {diagnosticText(item.delta)}
                </small>
              )}
            </article>
          ))}
        </section>

        <div className={styles.attributionTop}>
          <section className={styles.panel} aria-labelledby="bridge-title">
            <div className={styles.sectionHeading}>
              <div>
                <span className={styles.eyebrow}>固定顺序 · 高精度勾稽</span>
                <h2 id="bridge-title">五因素原生 SVG 瀑布</h2>
              </div>
              {selectedFactor ? (
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => selectFactor(selectedFactor)}
                >
                  清除因素
                </button>
              ) : null}
            </div>
            <Waterfall
              data={initialData.bridge.payload}
              selected={selectedFactor}
              onSelect={selectFactor}
            />
            <p className={styles.chartNote}>
              固定顺序：量 → 结构 → 效率与异常 → 价 → 汇率。报告尾差不改变高精度勾稽。
            </p>
          </section>

          <aside className={styles.aiPanel} aria-labelledby="ai-title">
            <div className={styles.sectionHeading}>
              <div>
                <span className={styles.aiBadge}>示例回答</span>
                <h2 id="ai-title">AI 管理分析</h2>
              </div>
            </div>
            <p className={styles.aiScope}>范围：2026 年 8 月｜英国｜Actual vs Budget｜五因素合计</p>
            <section>
              <h3>结论</h3>
              <p>英国履约变动成本显著超出 Budget，结构因素是最大不利驱动。</p>
              <button
                type="button"
                className={styles.evidenceButton}
                onClick={(event) => openEvidence("E01-country", event.currentTarget)}
              >
                成本差异证据
              </button>
            </section>
            <section>
              <h3>证据</h3>
              <p>空运与 Carrier C 包裹占比同时上升，结构因素贡献最突出。</p>
              <div className={styles.evidenceLinks}>
                <button
                  type="button"
                  onClick={(event) => openEvidence("ATTRIBUTION_BRIDGE:MIX", event.currentTarget)}
                >
                  结构因素
                </button>
                <button
                  type="button"
                  onClick={(event) =>
                    openEvidence("DIAGNOSTIC_METRICS:AIR_SHARE:DELTA", event.currentTarget)
                  }
                >
                  空运占比
                </button>
                <button
                  type="button"
                  onClick={(event) =>
                    openEvidence("DIAGNOSTIC_METRICS:CARRIER_C_SHARE:DELTA", event.currentTarget)
                  }
                >
                  Carrier C 占比
                </button>
              </div>
            </section>
            <section>
              <h3>影响</h3>
              <p>准时履约率仅作服务诊断，当前 cohort 尚未最终成熟，不直接进入成本归因。</p>
            </section>
            <section>
              <h3>建议</h3>
              <p>可考虑评估降低空运比例和调整 Carrier C 份额。</p>
              <span className={styles.statusLabel}>尚未进行情景验证</span>
              <span className={styles.statusLabel}>执行可行性未验证</span>
            </section>
            <section>
              <h3>限制</h3>
              <p>当前事实仅支持线路层下钻，无法生成订单级 Top 结果。</p>
              <span className={styles.limitLabel}>相关性不等于因果 · 不得推断未记录的经营因果</span>
            </section>
          </aside>
        </div>

        <section className={styles.panel} aria-labelledby="drilldown-title">
          <div className={styles.sectionHeading}>
            <div>
              <span className={styles.eyebrow}>
                默认路径：发货仓 → 运输方式 → 承运商 → 成本类别
              </span>
              <h2 id="drilldown-title">履约变动成本下钻</h2>
            </div>
            <div aria-live="polite">
              {loading ? (
                <span className={styles.loadingState}>正在更新归因明细…</span>
              ) : selectedFactor ? (
                <span className={styles.scopeBadge}>按{factorLabels[selectedFactor]}贡献排序</span>
              ) : (
                <span className={styles.scopeBadge}>按总差异排序</span>
              )}
            </div>
          </div>
          {queryError ? (
            <div className={styles.errorState} role="alert">
              {queryError}
              <button type="button" onClick={() => void fetchDrilldown(selectedFactor)}>
                重试
              </button>
            </div>
          ) : null}
          <div className={styles.tableScroller}>
            <table aria-busy={!rowsReady}>
              <thead>
                <tr>
                  <th>维度</th>
                  <th>Budget</th>
                  <th>Actual</th>
                  <th>总差异</th>
                  <th>差异率</th>
                  <th>{selectedFactor ? `${factorLabels[selectedFactor]}贡献` : "五因素合计"}</th>
                  <th>证据</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, index) => {
                  const level = {
                    FULFILLMENT_CENTER: 0,
                    TRANSPORT_MODE: 1,
                    CARRIER: 2,
                    COST_COMPONENT: 3,
                  }[row.level];
                  const contribution = sourceFactor
                    ? row.factor_contributions[sourceFactor]
                    : row.variance;
                  const baseId = `ATTRIBUTION_DRILLDOWN:${row.row_id}`;
                  const primaryId = sourceFactor ? `${baseId}:FACTOR:${sourceFactor}` : baseId;
                  return (
                    <tr key={row.row_id} id={row.row_id} tabIndex={-1}>
                      <th scope="row" style={{ paddingInlineStart: `${16 + level * 24}px` }}>
                        {row.children_available ? (
                          <button
                            type="button"
                            className={styles.expandButton}
                            aria-expanded={expanded.has(row.row_id)}
                            onClick={() => toggleRow(row)}
                          >
                            {expanded.has(row.row_id) ? "−" : "+"}
                            <span>{row.label_zh}</span>
                          </button>
                        ) : (
                          <span>{row.label_zh}</span>
                        )}
                        {index === 0 && row.level === "FULFILLMENT_CENTER" ? (
                          <span className={styles.adverseTag}>最大不利贡献</span>
                        ) : null}
                      </th>
                      <td>
                        <button
                          type="button"
                          className={styles.evidenceButton}
                          disabled={!rowsReady}
                          aria-label={`${row.label_zh} Budget 证据`}
                          onClick={(event) =>
                            openEvidence(`${baseId}:BASELINE`, event.currentTarget, drilldown)
                          }
                        >
                          {formatMoney(row.baseline_cost)}
                        </button>
                      </td>
                      <td>
                        <button
                          type="button"
                          className={styles.evidenceButton}
                          disabled={!rowsReady}
                          aria-label={`${row.label_zh} Actual 证据`}
                          onClick={(event) =>
                            openEvidence(`${baseId}:CURRENT`, event.currentTarget, drilldown)
                          }
                        >
                          {formatMoney(row.current_cost)}
                        </button>
                      </td>
                      <td className={styles.adverseText}>
                        <button
                          type="button"
                          className={styles.evidenceButton}
                          disabled={!rowsReady}
                          aria-label={`${row.label_zh} 总差异证据`}
                          onClick={(event) => openEvidence(baseId, event.currentTarget, drilldown)}
                        >
                          {formatSignedMoney(row.variance)}
                        </button>
                      </td>
                      <td>{formatDecimal(row.variance_rate)}</td>
                      <td>
                        <button
                          type="button"
                          className={styles.evidenceButton}
                          disabled={!rowsReady}
                          aria-label={`${row.label_zh} 主贡献证据`}
                          onClick={(event) =>
                            openEvidence(primaryId, event.currentTarget, drilldown)
                          }
                        >
                          {formatSignedMoney(contribution)}
                        </button>
                      </td>
                      <td>
                        <button
                          type="button"
                          className={styles.evidenceButton}
                          disabled={!rowsReady}
                          onClick={(event) =>
                            openEvidence(primaryId, event.currentTarget, drilldown)
                          }
                        >
                          数字证据
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">英国合计</th>
                  <td>{formatMoney(initialData.country.payload.baseline)}</td>
                  <td>{formatMoney(initialData.country.payload.current)}</td>
                  <td>{formatSignedMoney(initialData.country.payload.variance)}</td>
                  <td>—</td>
                  <td>
                    {selectedFactor
                      ? formatSignedMoney(
                          initialData.bridge.payload.factors.find(
                            (factor) => factor.factor_id === selectedFactor,
                          )?.amount,
                        )
                      : formatSignedMoney(initialData.country.payload.variance)}
                  </td>
                  <td>勾稽</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className={styles.limitNote}>
            数据粒度限制：当前支持线路层及成本类别，不提供订单明细、Top 订单或订单—包裹追踪。
          </p>
        </section>
      </main>

      {guideStep === 3 || guideStep === 4 ? (
        <aside className={styles.guide} aria-label="四步演示主线">
          <span className={styles.eyebrow}>演示主线 · 第 {guideStep} / 4 步</span>
          <strong>
            {guideStep === 3
              ? "选择结构因素并展开德国仓 → 空运 → Carrier C"
              : "查看 AI 管理分析并打开数字证据"}
          </strong>
          <p>
            {guideStep === 3
              ? "下一步将设置结构因素并恢复指定下钻路径；仍可自由操作其他区域。"
              : "示例回答不调用真实模型，数字均可打开结构化证据。"}
          </p>
          <div>
            <button type="button" onClick={() => setGuideStep(0)}>
              退出
            </button>
            <button type="button" onClick={guideAdvance}>
              {guideStep === 3 ? "下一步" : "完成"}
            </button>
          </div>
        </aside>
      ) : null}
      {evidenceId ? (
        <EvidenceDrawer
          evidence={selectedEvidence}
          notFound={!evidenceLoading && !selectedEvidence}
          onClose={closeEvidence}
          onLocate={locateEvidence}
          loading={evidenceLoading}
          error={evidenceError}
          scopeMismatch={!!evidenceScope && (evidenceScope.factor_id ?? null) !== selectedFactor}
        />
      ) : null}
    </div>
  );
}
