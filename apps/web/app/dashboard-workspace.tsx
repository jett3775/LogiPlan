"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { deterministicResultSchema, type EvidenceObject } from "@logiplan/contracts";

import { formatDecimal, formatMoney, formatSignedMoney } from "./lib/format";
import {
  VERSIONS,
  dashboardIntents,
  evidenceIntentFromUrl,
  historicalEvidenceIntentFromUrl,
  bindEvidenceAddress,
  clearEvidenceAddress,
  type DashboardData,
} from "./lib/model";
import styles from "./workspace.module.css";

const attributionHref =
  `/attribution?period=2026-08&comparison=ACTUAL_VS_BUDGET&destination=GB&budget=${VERSIONS.budget}` +
  `&actual=${VERSIONS.actual}&method=CHAIN`;

const warehouseLabels: Record<string, string> = { DE_FC: "德国仓", FR_FC: "法国仓" };
const countryLabels: Record<string, string> = { GB: "英国", DE: "德国", FR: "法国" };
const HISTORICAL_EVIDENCE_TIMEOUT_MS = 10_000;

function currentAnalysisAddress(url: URL): string {
  clearEvidenceAddress(url);
  return `${url.pathname}${url.search}${url.hash}`;
}

function EvidencePanel({
  evidence,
  loading,
  error,
  onClose,
}: {
  evidence: EvidenceObject | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <aside className={styles.evidencePanel} role="dialog" aria-label="数字证据">
      <div className={styles.panelHeader}>
        <div>
          <span className={styles.eyebrow}>结构化证据</span>
          <h2>{loading ? "正在读取数字证据" : error ? "证据查询失败" : evidence?.metric}</h2>
        </div>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onClose}
          aria-label="关闭数字证据"
        >
          ×
        </button>
      </div>
      {loading ? (
        <p className={styles.loadingState}>正在读取精确证据…</p>
      ) : error ? (
        <p className={styles.errorState}>{error}</p>
      ) : evidence ? (
        <dl className={styles.evidenceList}>
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
            <dt>分组</dt>
            <dd>{evidence.group_by.join(" → ") || "公司汇总"}</dd>
          </div>
          <div>
            <dt>Budget 版本</dt>
            <dd>{evidence.versions.budget}</dd>
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
            <dt>数据发布</dt>
            <dd>{evidence.data_release_id}</dd>
          </div>
          <div>
            <dt>证据快照</dt>
            <dd>{evidence.evidence_snapshot_id}</dd>
          </div>
          <div>
            <dt>生成时间</dt>
            <dd>{evidence.snapshot_generated_at}</dd>
          </div>
        </dl>
      ) : (
        <p className={styles.errorState}>
          该 evidence_id 不存在于当前固定范围，请返回页面数字重新打开。
        </p>
      )}
    </aside>
  );
}

// A saved link must remain readable even when the active release cannot load.
export function HistoricalEvidenceWorkspace({ returnHref }: { returnHref: string }) {
  const router = useRouter();
  const [evidence, setEvidence] = useState<EvidenceObject | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historical, setHistorical] = useState(false);
  const [currentHref, setCurrentHref] = useState(returnHref);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const load = async () => {
      request.current?.abort();
      const active = new AbortController();
      request.current = active;
      const url = new URL(window.location.href);
      setCurrentHref(currentAnalysisAddress(new URL(url)));
      setEvidence(null);
      setHistorical(false);
      setError(null);
      setLoading(true);
      let timedOut = false;
      let timeout: number | undefined;
      try {
        const intent = historicalEvidenceIntentFromUrl(url);
        timeout = window.setTimeout(() => {
          timedOut = true;
          active.abort();
        }, HISTORICAL_EVIDENCE_TIMEOUT_MS);
        const response = await fetch("/api/v1/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(intent),
          signal: active.signal,
        });
        const body: unknown = await response.json();
        const parsed = deterministicResultSchema.safeParse(body);
        if (!response.ok || !parsed.success) {
          throw new Error(
            body && typeof body === "object" && "message_zh" in body
              ? String(body.message_zh)
              : "证据查询失败，请重试。",
          );
        }
        const item = parsed.data.evidence.find(
          (candidate) => candidate.evidence_id === intent.evidence_id,
        );
        if (!item) throw new Error("证据快照中不存在指定 evidence_id。");
        if (!active.signal.aborted) {
          setEvidence(item);
          setHistorical(
            parsed.data.warnings.some((warning) => warning.code === "HISTORICAL_VERSION"),
          );
        }
      } catch (cause) {
        if (active.signal.aborted && !timedOut) return;
        if (request.current === active)
          setError(
            timedOut
              ? "证据查询超时，请重试或返回当前分析。"
              : cause instanceof Error
                ? cause.message
                : "证据查询失败",
          );
      } finally {
        if (timeout !== undefined) window.clearTimeout(timeout);
        if (request.current === active && (!active.signal.aborted || timedOut)) setLoading(false);
      }
    };
    const onPopState = () => {
      void load();
    };
    const timer = window.setTimeout(onPopState, 0);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.clearTimeout(timer);
      request.current?.abort();
      window.removeEventListener("popstate", onPopState);
    };
  }, []);
  return (
    <main className={styles.main}>
      <h1>历史数字证据</h1>
      <p>{historical ? "基于历史版本。" : "已保存的查询证据。"}数值和时间保留生成时的记录。</p>
      <Link href={currentHref}>返回当前分析</Link>
      <EvidencePanel
        evidence={evidence}
        loading={loading}
        error={error}
        onClose={() => {
          request.current?.abort();
          router.push(currentAnalysisAddress(new URL(window.location.href)));
        }}
      />
    </main>
  );
}

export function DashboardWorkspace({
  data,
  initialGuide = 0,
  initialEvidenceId = null,
}: {
  data: DashboardData;
  initialGuide?: number;
  initialEvidenceId?: string | null;
}) {
  const [fixedExpanded, setFixedExpanded] = useState(false);
  const [guideStep, setGuideStep] = useState(initialGuide);
  const [evidenceId, setEvidenceId] = useState(initialEvidenceId);
  const [evidence, setEvidence] = useState<EvidenceObject | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const evidenceTrigger = useRef<HTMLButtonElement | null>(null);
  const evidenceRequestSequence = useRef(0);
  const evidenceController = useRef<AbortController | null>(null);
  const overview = data.overview.payload;
  const trend = data.trend.payload;
  const plotHeight = 188;
  const chartWidth = 920;
  const left = 42;
  const step = 70;
  const barHeights = [92, 98, 104, 101, 108, 112, 118, 145, 126, 132, 136, 141] as const;
  const baselinePoints = trend.months
    .map((_month, index) => {
      const x = left + index * step + 18;
      const y = 92 + (index % 3) * 4;
      return `${x},${y}`;
    })
    .join(" ");

  const fetchEvidence = async (id: string | null) => {
    evidenceController.current?.abort();
    const controller = new AbortController();
    evidenceController.current = controller;
    const sequence = ++evidenceRequestSequence.current;
    setEvidenceError(null);
    if (!id) {
      setEvidence(null);
      setEvidenceLoading(false);
      return;
    }
    setEvidence(null);
    setEvidenceLoading(true);
    const scope = id.startsWith("E08-")
      ? dashboardIntents.warehouses.scope
      : dashboardIntents.overview.scope;
    try {
      const response = await fetch("/api/v1/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(evidenceIntentFromUrl(new URL(window.location.href), id, scope)),
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
        setEvidence(item);
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

  useEffect(() => {
    const onPopState = () => {
      const id = new URLSearchParams(window.location.search).get("evidence_id");
      setEvidenceId(id);
      void fetchEvidence(id);
    };
    window.addEventListener("popstate", onPopState);
    const initialEvidenceTimer = initialEvidenceId
      ? window.setTimeout(() => void fetchEvidence(initialEvidenceId), 0)
      : undefined;
    return () => {
      window.removeEventListener("popstate", onPopState);
      evidenceController.current?.abort();
      if (initialEvidenceTimer !== undefined) window.clearTimeout(initialEvidenceTimer);
    };
  }, [initialEvidenceId]);

  const updateAddress = (id: string | null) => {
    const url = new URL(window.location.href);
    if (id) {
      const warehouse = id.startsWith("E08-");
      url.searchParams.set("period", warehouse ? "2026-08" : "2026");
      url.searchParams.set(
        "comparison",
        warehouse ? "ACTUAL_VS_BUDGET" : "LATEST_OUTLOOK_VS_BUDGET",
      );
      url.searchParams.set("budget", VERSIONS.budget);
      url.searchParams.set("actual", VERSIONS.actual);
      if (warehouse) url.searchParams.delete("forecast");
      else url.searchParams.set("forecast", VERSIONS.forecast);
      url.searchParams.set("evidence_id", id);
      const source = Object.values(data).find((result) =>
        result.evidence.some((item) => item.evidence_id === id),
      );
      const item = source?.evidence.find((item) => item.evidence_id === id);
      clearEvidenceAddress(url);
      url.searchParams.set("evidence_id", id);
      if (source && item) bindEvidenceAddress(url, item, source.query_intent.scope);
    } else {
      clearEvidenceAddress(url);
    }
    window.history.pushState({}, "", `${url.pathname}?${url.searchParams.toString()}`);
  };

  const closeEvidence = () => {
    setEvidenceId(null);
    updateAddress(null);
    void fetchEvidence(null);
    window.setTimeout(() => evidenceTrigger.current?.focus(), 0);
  };

  const openEvidence = (id: string, trigger: HTMLButtonElement) => {
    if (!id) return;
    evidenceTrigger.current = trigger;
    setEvidenceId(id);
    updateAddress(id);
    void fetchEvidence(id);
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
          <Link className={styles.activeNav} href="/">
            预算执行驾驶舱
          </Link>
          <Link href={attributionHref}>英国异常归因</Link>
        </nav>
        <div className={styles.scopeCard}>
          <span className={styles.eyebrow}>只读分析范围</span>
          <strong>2026 全年 · 公司</strong>
          <span>Latest Outlook vs Budget</span>
          <span>1—8 月 Actual</span>
          <span>9—12 月 Forecast</span>
        </div>
        <button type="button" className={styles.guideButton} onClick={() => setGuideStep(1)}>
          {guideStep > 0 ? "重启演示主线" : "查看演示主线"}
        </button>
      </aside>

      <main className={styles.main}>
        <header className={styles.pageHeader}>
          <div>
            <span className={styles.eyebrow}>方案 B · 分析工作台侧轨</span>
            <h1>预算执行驾驶舱</h1>
            <p>识别全年 Latest Outlook 风险，并进入已实现的英国异常归因。</p>
          </div>
          <div className={styles.scopePills} aria-label="当前范围">
            <span>2026 全年</span>
            <span>公司</span>
            <span>CNY</span>
            <span>只读</span>
          </div>
        </header>

        <div className={styles.disclosure} role="note">
          完全虚构的求职作品集演示数据 · 报告币 CNY · 数据截至 2026 年 8 月结账
        </div>

        <section aria-labelledby="kpi-title">
          <div className={styles.sectionHeading}>
            <div>
              <span className={styles.eyebrow}>全年视角</span>
              <h2 id="kpi-title">六项核心 KPI</h2>
            </div>
            <span className={styles.adverseTag}>净差异 · 不利</span>
          </div>
          <div className={styles.kpiGrid}>
            <article className={styles.kpiCard}>
              <span>物流总成本</span>
              <strong>{formatMoney(overview.kpis.latest_outlook)}</strong>
              <small>Budget {formatMoney(overview.kpis.budget)}</small>
              <div className={styles.splitLine}>
                <span>履约变动 {formatMoney(overview.series.latest_outlook.variable_cost)}</span>
                <span>固定 {formatMoney(overview.series.latest_outlook.fixed_cost)}</span>
              </div>
            </article>
            <article className={styles.kpiCard}>
              <span>履约变动成本</span>
              <strong>{formatMoney(overview.kpis.variable_cost_latest_outlook)}</strong>
              <small>Budget {formatMoney(overview.kpis.variable_cost_budget)}</small>
            </article>
            <article className={styles.kpiCard}>
              <span>净差异金额及差异率</span>
              <strong className={styles.adverseText}>
                {formatSignedMoney(overview.kpis.variance)}
              </strong>
              <small>{formatDecimal(overview.kpis.variance_rate)} · 不利</small>
            </article>
            <article className={styles.kpiCard}>
              <span>单均履约变动成本</span>
              <strong>
                {formatMoney(overview.kpis.fulfillment_cost_per_order_latest_outlook)}
              </strong>
              <small>Budget {formatMoney(overview.kpis.fulfillment_cost_per_order_budget)}</small>
            </article>
            <article className={styles.kpiCard}>
              <span>每公斤运输成本</span>
              <strong>{formatMoney(overview.kpis.transport_cost_per_kg_latest_outlook)}</strong>
              <small>Budget {formatMoney(overview.kpis.transport_cost_per_kg_budget)}</small>
            </article>
            <article className={styles.kpiCard}>
              <span>公司物流总成本率</span>
              <strong>
                {formatDecimal(overview.kpis.logistics_total_cost_rate_latest_outlook)}
              </strong>
              <small>Budget {formatDecimal(overview.kpis.logistics_total_cost_rate_budget)}</small>
            </article>
          </div>
        </section>

        <section className={styles.panel} aria-labelledby="trend-title">
          <div className={styles.sectionHeading}>
            <div>
              <span className={styles.eyebrow}>公司物流总成本</span>
              <h2 id="trend-title">Budget / Actual / Forecast 月度趋势</h2>
            </div>
            <div className={styles.legend}>
              <span>■ Actual</span>
              <span>□ Forecast</span>
              <span>— Budget</span>
            </div>
          </div>
          <div className={styles.chartScroller}>
            <svg
              viewBox={`0 0 ${chartWidth} 230`}
              role="img"
              aria-labelledby="trend-svg-title trend-svg-desc"
            >
              <title id="trend-svg-title">2026 年公司物流总成本月度趋势</title>
              <desc id="trend-svg-desc">
                一至八月为 Actual 深蓝柱，九至十二月为 Forecast 浅蓝柱，灰线为 Budget。
              </desc>
              <line x1="602" y1="16" x2="602" y2="205" className={styles.closeLine} />
              <text x="610" y="28" className={styles.chartLabel}>
                8—9 月结账分界
              </text>
              <polyline points={baselinePoints} className={styles.budgetLine} />
              {trend.months.map((month, index) => {
                const height = barHeights[index] ?? 100;
                const x = left + index * step;
                const y = plotHeight - height;
                return (
                  <g key={month.month_id}>
                    <rect
                      x={x}
                      y={y}
                      width="36"
                      height={height}
                      rx="3"
                      className={
                        month.series_type === "ACTUAL" ? styles.actualBar : styles.forecastBar
                      }
                    >
                      <title>
                        {month.month_id} {month.series_type} {formatMoney(month.current.total_cost)}
                      </title>
                    </rect>
                    <text x={x + 18} y="210" textAnchor="middle" className={styles.chartLabel}>
                      {index + 1}月
                    </text>
                    {month.month_id === "2026-08" ? (
                      <a href={attributionHref} aria-label="进入 2026 年 8 月英国异常归因">
                        <circle cx={x + 18} cy={y - 10} r="7" className={styles.anomalyPoint} />
                      </a>
                    ) : null}
                  </g>
                );
              })}
            </svg>
          </div>
          <p className={styles.chartNote}>
            ◆ 8 月不利异常可进入英国归因；公司总成本视角将在归因页切换为英国履约变动成本视角。
          </p>
        </section>

        <div className={styles.twoColumn}>
          <section className={styles.panel} aria-labelledby="anomaly-title">
            <div className={styles.sectionHeading}>
              <div>
                <span className={styles.eyebrow}>确定性排序</span>
                <h2 id="anomaly-title">Top 5 不利异常</h2>
              </div>
            </div>
            <div className={styles.tableScroller}>
              <table>
                <thead>
                  <tr>
                    <th>排名 / 范围</th>
                    <th>当前</th>
                    <th>Budget</th>
                    <th>不利差异</th>
                    <th>贡献</th>
                  </tr>
                </thead>
                <tbody>
                  {data.anomalies.payload.anomalies.map((row) => (
                    <tr key={row.evidence_id}>
                      <th scope="row">
                        <span>
                          {row.rank}. {row.month_id} ·{" "}
                          {countryLabels[row.destination_country_id] ?? row.destination_country_id}
                        </span>
                        <small>{row.series_type}</small>
                        {row.rank === 1 ? (
                          <span className={styles.adverseTag}>最大单月不利异常</span>
                        ) : null}
                      </th>
                      <td>{formatMoney(row.current)}</td>
                      <td>{formatMoney(row.baseline)}</td>
                      <td className={styles.adverseText}>
                        {formatSignedMoney(row.variance)}
                        <small>{formatDecimal(row.variance_rate)}</small>
                      </td>
                      <td>
                        {formatDecimal(row.adverse_contribution_share)}
                        {row.month_id === "2026-08" && row.destination_country_id === "GB" ? (
                          <Link className={styles.inlineLink} href={attributionHref}>
                            进入归因
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.panel} aria-labelledby="warehouse-title">
            <div className={styles.sectionHeading}>
              <div>
                <span className={styles.eyebrow}>2026-08 · 公司口径</span>
                <h2 id="warehouse-title">发货仓差异</h2>
              </div>
              <span className={styles.scopeBadge}>不含英国筛选</span>
            </div>
            <div className={styles.warehouseList}>
              {data.warehouses.payload.warehouses.map((row) => (
                <div key={row.fulfillment_center_id}>
                  <span>
                    {warehouseLabels[row.fulfillment_center_id] ?? row.fulfillment_center_id}
                  </span>
                  <strong className={styles.adverseText}>{formatSignedMoney(row.variance)}</strong>
                  <button
                    type="button"
                    className={styles.evidenceButton}
                    onClick={(event) => openEvidence(row.evidence_id, event.currentTarget)}
                  >
                    数字证据
                  </button>
                </div>
              ))}
              <div className={styles.totalRow}>
                <span>公司合计</span>
                <strong>{formatSignedMoney(data.warehouses.payload.company_total.variance)}</strong>
              </div>
            </div>
          </section>
        </div>

        <section className={styles.panel} aria-labelledby="fixed-title">
          <div className={styles.sectionHeading}>
            <div>
              <span className={styles.eyebrow}>不分摊至目的国</span>
              <h2 id="fixed-title">物流运营固定成本</h2>
            </div>
            <button
              type="button"
              className={styles.secondaryButton}
              aria-expanded={fixedExpanded}
              onClick={() => setFixedExpanded((value) => !value)}
            >
              {fixedExpanded ? "收起固定成本" : "展开固定成本"}
            </button>
          </div>
          <div className={styles.fixedSummary}>
            <span>Latest Outlook</span>
            <strong>{formatMoney(data.fixed.payload.total.current)}</strong>
            <span>差异 {formatSignedMoney(data.fixed.payload.total.variance)}</span>
          </div>
          {fixedExpanded ? (
            <div className={styles.fixedGrid}>
              {data.fixed.payload.categories.map((category) => (
                <article key={category.fixed_cost_category}>
                  <span>{category.label_zh}</span>
                  <strong>{formatMoney(category.current)}</strong>
                  <small>差异 {formatSignedMoney(category.variance)}</small>
                  <ul>
                    {category.allocations.map((allocation) => (
                      <li key={allocation.scope_id}>
                        <span>{warehouseLabels[allocation.scope_id] ?? "共享层"}</span>
                        <span>{formatMoney(allocation.current)}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          ) : null}
        </section>
      </main>

      {guideStep > 0 ? (
        <aside className={styles.guide} aria-label="四步演示主线">
          <span className={styles.eyebrow}>演示主线 · 第 {guideStep} / 4 步</span>
          <strong>
            {guideStep === 1
              ? "查看全年 Latest Outlook 与 Budget 风险"
              : "识别 Top 1 的 2026 年 8 月英国异常"}
          </strong>
          <p>
            {guideStep === 1
              ? "六项 KPI 与月度趋势共同说明全年预算风险。"
              : "Top 5 第一行提供唯一已实现的真实归因入口。"}
          </p>
          <div>
            <button type="button" onClick={() => setGuideStep(0)}>
              退出
            </button>
            {guideStep === 1 ? (
              <button type="button" onClick={() => setGuideStep(2)}>
                下一步
              </button>
            ) : (
              <Link href={`${attributionHref}&guide=3`}>进入归因页</Link>
            )}
          </div>
        </aside>
      ) : null}
      {evidenceId ? (
        <EvidencePanel
          evidence={evidence}
          loading={evidenceLoading}
          error={evidenceError}
          onClose={closeEvidence}
        />
      ) : null}
    </div>
  );
}
