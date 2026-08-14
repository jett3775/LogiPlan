/*
 * PROTOTYPE — throwaway UI code.
 * Three structural variants of the LogiPlan AI core desktop flow, switchable via ?variant=.
 */

const VARIANTS = {
  A: "经营驾驶舱分栏",
  B: "分析工作台侧轨",
  C: "管理简报画布",
};

const FACTOR_LABELS = {
  VOLUME: "量",
  MIX: "结构",
  EFFICIENCY: "效率",
  PRICE: "价",
  FX: "汇率",
};

const state = {
  variant: "A",
  view: "dashboard",
  fixedCostExpanded: false,
  selectedFactor: null,
  expandedRowIds: [],
  evidenceId: null,
  guideStep: 0,
};

let model = null;

function parseUrlState() {
  const params = new URLSearchParams(window.location.search);
  const variant = (params.get("variant") || "A").toUpperCase();
  state.variant = VARIANTS[variant] ? variant : "A";
  state.view = params.get("view") === "attribution" ? "attribution" : "dashboard";
}

function updateUrl({ push = false } = {}) {
  const url = new URL(window.location.href);
  url.searchParams.set("variant", state.variant);
  url.searchParams.set("view", state.view);
  window.history[push ? "pushState" : "replaceState"]({}, "", url);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function number(value) {
  return Number(value || 0);
}

function fmtMoney(value, digits = 0) {
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(number(value));
}

function fmtMoneyCompact(value) {
  const n = number(value);
  if (Math.abs(n) >= 10000000) return `${(n / 10000000).toFixed(2)} 千万`;
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1)} 万`;
  return fmtMoney(n, 0);
}

function fmtSignedMoney(value, digits = 0) {
  const n = number(value);
  return `${n >= 0 ? "+" : "−"}${fmtMoney(Math.abs(n), digits)}`;
}

function fmtPct(value, digits = 2) {
  return `${(number(value) * 100).toFixed(digits)}%`;
}

function fmtSignedPct(value, digits = 2) {
  const n = number(value) * 100;
  return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}%`;
}

function semanticClass(value) {
  return number(value) >= 0 ? "adverse" : "favourable";
}

function evidenceButton(evidenceId, label = "证据") {
  return `<button class="evidence-ref" type="button" data-action="open-evidence" data-evidence-id="${escapeHtml(evidenceId)}" aria-label="查看数字证据">[${escapeHtml(label)}]</button>`;
}

function renderScopeChips(scope, extra = []) {
  const parts = scope.split("｜").map((item) => item.trim());
  return `<div class="scope-row">${[...parts, ...extra]
    .map((item) => `<span class="scope-chip">${escapeHtml(item)}</span>`)
    .join("")}</div>`;
}

function renderDataNotice() {
  return `<div class="data-notice">
    <span><strong>完全虚构的求职作品集演示数据</strong> · 数据模型 ${escapeHtml(model.meta.cost_model_revision)} · 最近结账月 ${escapeHtml(model.meta.latest_closed_month)}</span>
    <span>来源：已审计工作簿 · 快照 ${escapeHtml(model.meta.generated_on)}</span>
  </div>`;
}

function renderTopbar() {
  return `<header class="app-topbar">
    <div class="brand-lockup">
      <div class="brand-mark" aria-hidden="true">LP</div>
      <div><strong>LogiPlan AI</strong><span>物流预算执行与归因</span></div>
    </div>
    <div class="top-actions">
      <span class="status-chip blue-chip">求职作品集演示</span>
      <button class="btn secondary" type="button" data-action="start-guide">查看演示主线</button>
    </div>
  </header>`;
}

function metricDisplay(metricId, value) {
  if (metricId === "total_cost_rate") return fmtPct(value);
  if (metricId === "unit_variable_cost") return `${fmtMoney(value, 2)} / 单`;
  if (metricId === "transport_cost_per_kg") return `${fmtMoney(value, 2)} / kg`;
  return fmtMoneyCompact(value);
}

function renderKpiCard(metricId, label, { primary = false, split = false } = {}) {
  const metric = model.dashboard.kpis[metricId];
  const splitMarkup = split
    ? `<div class="cost-split">
        <span>履约变动成本<strong>¥ ${fmtMoneyCompact(model.dashboard.kpis.variable_cost.current)}</strong></span>
        <span>运营固定成本<strong>¥ ${fmtMoneyCompact(model.dashboard.kpis.fixed_cost.current)}</strong></span>
      </div>`
    : "";
  return `<article class="kpi-card ${primary ? "primary" : ""}">
    <div class="kpi-label">${escapeHtml(label)} ${evidenceButton(metric.evidence_id)}</div>
    <div class="kpi-value num">${metricId === "total_cost_rate" ? "" : "¥ "}${metricDisplay(metricId, metric.current)}</div>
    <div class="kpi-baseline">Budget：${metricId === "total_cost_rate" ? "" : "¥ "}${metricDisplay(metricId, metric.baseline)}</div>
    <div class="variance-line"><span class="${semanticClass(metric.variance)}">不利 ${metricId === "total_cost_rate" ? fmtSignedPct(metric.variance, 2) : `¥ ${fmtSignedMoney(metric.variance)}`}</span><span>${fmtSignedPct(metric.variance_rate)}</span></div>
    ${splitMarkup}
  </article>`;
}

function renderKpiGrid() {
  return `<section class="kpi-grid" data-guide-target="annual">
    ${renderKpiCard("total_cost", "物流总成本", { primary: true, split: true })}
    ${renderKpiCard("variable_cost", "履约变动成本")}
    ${renderKpiCard("fixed_cost", "运营固定成本")}
    ${renderKpiCard("unit_variable_cost", "单均履约变动成本")}
    ${renderKpiCard("transport_cost_per_kg", "每公斤运输成本")}
    ${renderKpiCard("total_cost_rate", "公司物流总成本率")}
  </section>`;
}

function renderMetricStrip() {
  const specs = [
    ["total_cost", "物流总成本"],
    ["variable_cost", "履约变动成本"],
    ["fixed_cost", "运营固定成本"],
    ["unit_variable_cost", "单均履约变动成本"],
    ["transport_cost_per_kg", "每公斤运输成本"],
    ["total_cost_rate", "公司物流总成本率"],
  ];
  return `<section class="metric-strip" data-guide-target="annual">${specs
    .map(([id, label], index) => {
      const metric = model.dashboard.kpis[id];
      return `<article class="metric-cell">
        <div class="kpi-label">${escapeHtml(label)} ${evidenceButton(metric.evidence_id)}</div>
        <div class="kpi-value num">${id === "total_cost_rate" ? "" : "¥ "}${metricDisplay(id, metric.current)}</div>
        <div class="${semanticClass(metric.variance)} tiny">${index === 0 ? "全年不利差异 " : "vs Budget "}${id === "total_cost_rate" ? fmtSignedPct(metric.variance) : `¥ ${fmtSignedMoney(metric.variance)}`}</div>
      </article>`;
    })
    .join("")}</section>`;
}

function renderBriefKpis() {
  const specs = [
    ["variable_cost", "履约变动成本"],
    ["fixed_cost", "运营固定成本"],
    ["unit_variable_cost", "单均履约变动成本"],
    ["transport_cost_per_kg", "每公斤运输成本"],
    ["total_cost_rate", "公司物流总成本率"],
  ];
  return `<section class="brief-kpis">${specs
    .map(([id, label]) => {
      const metric = model.dashboard.kpis[id];
      return `<article class="brief-kpi">
        <div class="kpi-label">${escapeHtml(label)} ${evidenceButton(metric.evidence_id)}</div>
        <div class="kpi-value num">${id === "total_cost_rate" ? "" : "¥ "}${metricDisplay(id, metric.current)}</div>
        <div class="tiny ${semanticClass(metric.variance)}">vs Budget ${id === "total_cost_rate" ? fmtSignedPct(metric.variance) : `¥ ${fmtSignedMoney(metric.variance)}`}</div>
      </article>`;
    })
    .join("")}</section>`;
}

function renderMonthlyChart() {
  const rows = model.dashboard.monthly_trend;
  const width = 900;
  const height = 310;
  const margin = { top: 32, right: 24, bottom: 50, left: 58 };
  const innerHeight = height - margin.top - margin.bottom;
  const maxValue = Math.max(...rows.flatMap((row) => [number(row.current), number(row.baseline)])) * 1.13;
  const xStep = (width - margin.left - margin.right) / rows.length;
  const barWidth = Math.min(34, xStep * 0.52);
  const y = (value) => margin.top + innerHeight - (number(value) / maxValue) * innerHeight;
  const grid = [0, 0.5, 1]
    .map((ratio) => {
      const value = maxValue * ratio;
      const yy = y(value);
      return `<line class="chart-grid-line" x1="${margin.left}" x2="${width - margin.right}" y1="${yy}" y2="${yy}" />
        <text x="${margin.left - 9}" y="${yy + 4}" text-anchor="end" fill="#758498" font-size="10">${escapeHtml(fmtMoneyCompact(value))}</text>`;
    })
    .join("");
  const points = rows
    .map((row, index) => `${margin.left + xStep * index + xStep / 2},${y(row.baseline)}`)
    .join(" ");
  const bars = rows
    .map((row, index) => {
      const x = margin.left + xStep * index + (xStep - barWidth) / 2;
      const yy = y(row.current);
      const barHeight = margin.top + innerHeight - yy;
      const isAug = row.month_id === "2026-08";
      const cls = row.current_type === "ACTUAL" ? "actual-bar" : "forecast-bar";
      const content = `<rect class="${cls} ${isAug ? "aug-bar" : ""}" x="${x}" y="${yy}" width="${barWidth}" height="${barHeight}" rx="2">
          <title>${row.month_label} ${row.current_type}: ¥ ${fmtMoney(row.current, 2)}；Budget: ¥ ${fmtMoney(row.baseline, 2)}</title>
        </rect>
        <text x="${x + barWidth / 2}" y="${height - 25}" text-anchor="middle" fill="#65758a" font-size="10">${row.month_label}</text>`;
      if (!isAug) return `<g>${content}</g>`;
      return `<g class="chart-clickable" data-action="nav-attribution" tabindex="0" role="button" aria-label="进入 2026 年 8 月英国归因页">
        ${content}
        <circle class="aug-marker" cx="${x + barWidth / 2}" cy="${Math.max(18, yy - 12)}" r="7"><title>8 月公司总成本异常：点击进入英国归因</title></circle>
        <text x="${x + barWidth / 2}" y="${Math.max(7, yy - 24)}" text-anchor="middle" fill="#a83c28" font-size="9" font-weight="700">异常入口</text>
      </g>`;
    })
    .join("");
  const boundaryX = margin.left + xStep * 8;
  return `<div class="chart-wrap" data-guide-target="anomaly">
    <svg class="monthly-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="2026 年公司物流总成本月度趋势">
      ${grid}
      ${bars}
      <polyline class="budget-line" points="${points}" />
      ${rows.map((row, index) => `<circle class="budget-dot" cx="${margin.left + xStep * index + xStep / 2}" cy="${y(row.baseline)}" r="3" />`).join("")}
      <line class="close-boundary" x1="${boundaryX}" x2="${boundaryX}" y1="${margin.top - 4}" y2="${height - margin.bottom + 4}" />
      <text x="${boundaryX + 5}" y="${margin.top}" fill="#7c642b" font-size="9">结账分界</text>
    </svg>
  </div>`;
}

function renderChartCard({ bare = false } = {}) {
  const body = `<div class="section-head">
      <div><h2>全年物流总成本走势</h2><p>Budget 对比线；1—8 月 Actual，9—12 月 Forecast</p></div>
      <div class="chart-legend">
        <span class="legend-item"><i class="legend-swatch actual"></i>Actual</span>
        <span class="legend-item"><i class="legend-swatch forecast"></i>Forecast</span>
        <span class="legend-item"><i class="legend-swatch budget"></i>Budget</span>
      </div>
    </div>${renderMonthlyChart()}`;
  return bare ? body : `<section class="surface chart-card">${body}</section>`;
}

function renderAnomalyTable({ compact = false } = {}) {
  const rows = model.dashboard.top_anomalies;
  return `<table class="anomaly-table">
    <thead><tr><th>异常</th><th>当前</th>${compact ? "" : "<th>Budget</th>"}<th>不利差异</th><th>贡献</th></tr></thead>
    <tbody>${rows
      .map(
        (row) => `<tr class="${row.is_core_entry ? "core-row" : ""}">
          <td><div class="anomaly-name"><span class="anomaly-rank">${row.rank}</span><span>${escapeHtml(row.month_id.slice(5))} 月 · ${escapeHtml(row.country_label)}</span></div>
            <div class="anomaly-action">${row.current_type}${row.is_core_entry ? ` · <button class="link-btn" type="button" data-action="nav-attribution">进入归因</button>` : ""}</div></td>
          <td class="num">¥ ${fmtMoney(row.current, 0)}</td>
          ${compact ? "" : `<td class="num">¥ ${fmtMoney(row.baseline, 0)}</td>`}
          <td class="num adverse">¥ ${fmtSignedMoney(row.variance, 0)}<br><span class="tiny">${fmtSignedPct(row.variance_rate)}</span></td>
          <td class="num">${fmtPct(row.adverse_contribution_share, 1)}</td>
        </tr>`,
      )
      .join("")}</tbody>
  </table>`;
}

function renderAnomalyCard({ compact = false } = {}) {
  return `<section class="surface anomaly-card" data-guide-target="anomaly">
    <div class="section-head"><div><h2>Top 5 不利异常</h2><p>月份 × 目的国 · 履约变动成本</p></div><span class="status-chip adverse-chip">确定性排名</span></div>
    ${renderAnomalyTable({ compact })}
  </section>`;
}

function renderEditorialAnomalies() {
  return `<div class="editorial-anomalies" data-guide-target="anomaly">${model.dashboard.top_anomalies
    .map(
      (row) => `<article class="editorial-anomaly">
        <div class="rank">0${row.rank}</div>
        <div><strong>${escapeHtml(row.month_id.slice(5))} 月 · ${escapeHtml(row.country_label)}</strong><span class="tiny">${row.current_type} vs Budget · 贡献 ${fmtPct(row.adverse_contribution_share, 1)}</span>${row.is_core_entry ? `<br><button class="link-btn" type="button" data-action="nav-attribution">进入英国归因 →</button>` : ""}</div>
        <div class="value num">¥ ${fmtSignedMoney(row.variance)}<br><span class="tiny">${fmtSignedPct(row.variance_rate)}</span></div>
      </article>`,
    )
    .join("")}</div>`;
}

function renderFixedCostPanel({ bare = false } = {}) {
  const fixed = model.dashboard.fixed_cost_breakdown;
  const detail = state.fixedCostExpanded
    ? `<div class="fixed-detail"><table class="fixed-table">
        <thead><tr><th>类别 / 归属</th><th>Latest Outlook</th><th>Budget</th><th>差异</th></tr></thead>
        <tbody>${fixed.rows
          .map(
            (row) => `<tr class="fixed-category-row"><td>${escapeHtml(row.label)}</td><td>¥ ${fmtMoney(row.current)}</td><td>¥ ${fmtMoney(row.baseline)}</td><td class="${semanticClass(row.variance)}">¥ ${fmtSignedMoney(row.variance)}</td></tr>
              ${row.children
                .map(
                  (child) => `<tr class="fixed-scope-row"><td>↳ ${escapeHtml(child.label)}</td><td>¥ ${fmtMoney(child.current)}</td><td>¥ ${fmtMoney(child.baseline)}</td><td class="${semanticClass(child.variance)}">¥ ${fmtSignedMoney(child.variance)}</td></tr>`,
                )
                .join("")}`,
          )
          .join("")}</tbody>
      </table></div>`
    : "";
  const body = `<div class="expand-line">
      <div><h3>运营固定成本</h3><div class="tiny">类别优先；不分摊到目的国或五因素</div></div>
      <button class="btn secondary" type="button" data-action="toggle-fixed" aria-expanded="${state.fixedCostExpanded}">${state.fixedCostExpanded ? "收起明细" : "展开类别与归属"}</button>
    </div>
    <div class="warehouse-total"><span>全年 Latest Outlook</span><strong class="num">¥ ${fmtMoney(fixed.current)}</strong></div>
    <div class="tiny">Budget ¥ ${fmtMoney(fixed.baseline)} · <span class="${semanticClass(fixed.variance)}">差异 ¥ ${fmtSignedMoney(fixed.variance)}</span></div>
    ${detail}`;
  return bare ? body : `<section class="surface fixed-card">${body}</section>`;
}

function renderWarehouseContext({ bare = false } = {}) {
  const context = model.dashboard.warehouse_variance_context;
  const body = `<div class="section-head"><div><h3>8 月公司发货仓差异</h3><p>E08 专用公司口径，不等于英国归因表</p></div><span class="status-chip blue-chip">公司口径</span></div>
    <div class="warehouse-scope-callout">${escapeHtml(context.scope_label)} · 只含可归属线路的履约变动成本</div>
    <div class="warehouse-total"><span>公司不利差异</span><strong class="num adverse">¥ ${fmtMoney(context.variance, 2)}</strong></div>
    <table class="warehouse-table"><thead><tr><th>发货仓</th><th>Actual</th><th>Budget</th><th>差异</th></tr></thead><tbody>
      ${context.warehouses
        .map(
          (row) => `<tr><td>${escapeHtml(row.label)} ${evidenceButton(row.evidence_id)}</td><td>¥ ${fmtMoney(row.current)}</td><td>¥ ${fmtMoney(row.baseline)}</td><td class="adverse">¥ ${fmtSignedMoney(row.variance, 2)}</td></tr>`,
        )
        .join("")}
    </tbody></table>
    <p class="tiny" style="margin:9px 0 0">英国归因页采用独立目的国筛选，总差异为 ¥ 574,474.2232。</p>`;
  return bare ? body : `<section class="surface warehouse-card">${body}</section>`;
}

function renderEvaluationGate() {
  return `<details class="eval-details">
    <summary><span>结构化评估基线</span><span class="status-chip pass-chip">9 / 9 PASS</span></summary>
    <div class="eval-list">${model.evaluation_gate
      .map(
        (item) => `<div class="eval-item"><strong>${escapeHtml(item.question_id)} · ${escapeHtml(item.status)}</strong><br>${escapeHtml(item.page_location)}</div>`,
      )
      .join("")}</div>
  </details>`;
}

function renderAttributionSummary() {
  const summary = model.attribution.summary;
  return `<section class="summary-card-grid" data-guide-target="attribution">
    <article class="summary-card"><div class="kpi-label">Actual 履约变动成本</div><div class="value num">¥ ${fmtMoney(summary.current, 2)}</div><div class="tiny">已结账实际</div></article>
    <article class="summary-card"><div class="kpi-label">Budget 履约变动成本</div><div class="value num">¥ ${fmtMoney(summary.baseline, 2)}</div><div class="tiny">冻结年度基线</div></article>
    <article class="summary-card emphasis"><div class="kpi-label">不利差异 ${evidenceButton(summary.evidence_id)}</div><div class="value num adverse">¥ ${fmtSignedMoney(summary.variance, 2)}</div><div class="tiny adverse">${fmtSignedPct(summary.variance_rate)} · 不含固定成本</div></article>
  </section>`;
}

function diagnosticValue(item, value) {
  if (item.unit === "RATIO") return fmtPct(value, 2);
  return fmtMoney(value, 0);
}

function renderDiagnostics() {
  return `<section class="diagnostic-strip">${model.attribution.diagnostics
    .map((item) => {
      const comparison = item.baseline == null
        ? `<span class="status-chip adverse-chip">${escapeHtml(item.delta_label)}</span>`
        : `Budget ${diagnosticValue(item, item.baseline)} · <span class="${number(item.delta) >= 0 ? "adverse" : "favourable"}">${item.unit === "RATIO" ? `${number(item.delta) >= 0 ? "+" : "−"}${Math.abs(number(item.delta) * 100).toFixed(2)} 个百分点` : fmtSignedPct(item.delta_rate)}</span>`;
      return `<article class="diagnostic-item">
        <div class="diag-label">${escapeHtml(item.label)} ${evidenceButton(item.evidence_id)}</div>
        <div class="diag-value num">${diagnosticValue(item, item.current)}</div>
        <div class="diag-compare">${comparison}</div>
      </article>`;
    })
    .join("")}</section>`;
}

function renderFactorToolbar() {
  return `<div class="factor-toolbar" aria-label="归因因素选择">${model.attribution.factors
    .map(
      (factor) => `<button type="button" class="factor-button ${state.selectedFactor === factor.factor_id ? "selected" : ""}" data-action="select-factor" data-factor-id="${factor.factor_id}" aria-pressed="${state.selectedFactor === factor.factor_id}">
        <strong>${escapeHtml(factor.label)}因素</strong><span>¥ ${fmtSignedMoney(factor.amount)}</span>
      </button>`,
    )
    .join("")}
    <button type="button" class="btn secondary" data-action="clear-factor" ${state.selectedFactor ? "" : "disabled"}>清除因素</button>
  </div>`;
}

function renderWaterfall() {
  const summary = model.attribution.summary;
  const factors = model.attribution.factors;
  const width = 820;
  const height = 300;
  const top = 38;
  const bottom = 53;
  const innerHeight = height - top - bottom;
  const maxValue = number(summary.current) * 1.12;
  const y = (value) => top + innerHeight - (number(value) / maxValue) * innerHeight;
  const slots = factors.length + 2;
  const step = 730 / slots;
  const x0 = 48;
  const barWidth = Math.min(64, step * 0.58);
  const items = [];
  const budgetX = x0 + (step - barWidth) / 2;
  items.push(`<rect class="waterfall-base" x="${budgetX}" y="${y(summary.baseline)}" width="${barWidth}" height="${top + innerHeight - y(summary.baseline)}" rx="2" />
    <text x="${budgetX + barWidth / 2}" y="${height - 24}" text-anchor="middle" fill="#53657a" font-size="10">Budget</text>
    <text x="${budgetX + barWidth / 2}" y="${y(summary.baseline) - 8}" text-anchor="middle" fill="#31465d" font-size="9">¥${fmtMoneyCompact(summary.baseline)}</text>`);
  factors.forEach((factor, index) => {
    const x = x0 + step * (index + 1) + (step - barWidth) / 2;
    const startY = y(factor.start);
    const endY = y(factor.end);
    const rectY = Math.min(startY, endY);
    const rectHeight = Math.max(2, Math.abs(startY - endY));
    const connectorStartX = x0 + step * index + (step - barWidth) / 2 + barWidth;
    items.push(`<line class="waterfall-connector" x1="${connectorStartX}" x2="${x}" y1="${startY}" y2="${startY}" />
      <g data-action="select-factor" data-factor-id="${factor.factor_id}" tabindex="0" role="button" aria-label="选择${escapeHtml(factor.label)}因素">
        <rect class="waterfall-factor ${state.selectedFactor === factor.factor_id ? "selected" : ""}" x="${x}" y="${rectY}" width="${barWidth}" height="${rectHeight}" rx="2"><title>${factor.label}因素：¥ ${fmtMoney(factor.amount, 4)}</title></rect>
        <text x="${x + barWidth / 2}" y="${height - 24}" text-anchor="middle" fill="#53657a" font-size="10">${escapeHtml(factor.label)}</text>
        <text x="${x + barWidth / 2}" y="${Math.max(13, rectY - 8)}" text-anchor="middle" fill="#9f432e" font-size="9">+${fmtMoneyCompact(factor.amount)}</text>
      </g>`);
  });
  const actualX = x0 + step * (slots - 1) + (step - barWidth) / 2;
  items.push(`<line class="waterfall-connector" x1="${actualX - step + barWidth}" x2="${actualX}" y1="${y(summary.current)}" y2="${y(summary.current)}" />
    <rect class="waterfall-end" x="${actualX}" y="${y(summary.current)}" width="${barWidth}" height="${top + innerHeight - y(summary.current)}" rx="2" />
    <text x="${actualX + barWidth / 2}" y="${height - 24}" text-anchor="middle" fill="#53657a" font-size="10">Actual</text>
    <text x="${actualX + barWidth / 2}" y="${y(summary.current) - 8}" text-anchor="middle" fill="#31465d" font-size="9">¥${fmtMoneyCompact(summary.current)}</text>`);
  return `<svg class="waterfall-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="英国八月履约变动成本五因素瀑布图">
    <line class="chart-grid-line" x1="38" x2="790" y1="${top + innerHeight}" y2="${top + innerHeight}" />
    ${items.join("")}
  </svg>`;
}

function renderWaterfallCard({ bare = false } = {}) {
  const selectedLabel = state.selectedFactor ? `${FACTOR_LABELS[state.selectedFactor]}因素已同步到下钻表` : "当前显示五因素合计";
  const body = `<div class="section-head"><div><h2>五因素归因桥</h2><p>${escapeHtml(model.attribution.method_label)}</p></div><span class="status-chip blue-chip">${escapeHtml(selectedLabel)}</span></div>
    ${renderFactorToolbar()}${renderWaterfall()}`;
  return bare ? body : `<section class="surface waterfall-card" data-guide-target="attribution">${body}</section>`;
}

function renderEvidenceRefs(ids) {
  return `<div class="chip-row" style="margin-top:8px">${ids.map((id) => evidenceButton(id, id.replace("EVID_", ""))).join("")}</div>`;
}

function renderAiAnalysis({ bare = false } = {}) {
  const ai = model.attribution.ai_analysis;
  const sections = [
    ["结论", ai.conclusion],
    ["证据", ai.evidence],
    ["影响", ai.impact],
  ];
  const body = `<div class="ai-answer-state">
      <div><span class="eyebrow">AI 管理分析</span><strong>已校验固定示例</strong></div>
      <span class="status-chip blue-chip">示例回答</span>
    </div>
    ${sections
      .map(
        ([title, section]) => `<section class="ai-section"><h4>${title}</h4><p>${escapeHtml(section.text)}</p>${renderEvidenceRefs(section.evidence_ids)}</section>`,
      )
      .join("")}
    <section class="ai-section"><h4>建议</h4>${ai.recommendations
      .map(
        (item) => `<div class="recommendation-item"><p>${escapeHtml(item.text)}</p>${renderEvidenceRefs(item.evidence_ids)}<span class="recommendation-status">尚未进行情景验证 · 可行性未验证</span></div>`,
      )
      .join("")}</section>
    <section class="ai-section"><h4>限制</h4><p>${escapeHtml(ai.limitations.text)}</p>${renderEvidenceRefs(ai.limitations.evidence_ids)}<div class="recommendation-status">${escapeHtml(model.attribution.order_level_guardrail.code)}</div></section>`;
  return bare ? body : `<aside class="surface ai-card" data-guide-target="ai">${body}</aside>`;
}

function sortedTreeNodes(nodes) {
  const key = state.selectedFactor;
  return [...nodes].sort((a, b) => {
    const av = key ? number(a.factor_contributions[key]) : number(a.variance);
    const bv = key ? number(b.factor_contributions[key]) : number(b.variance);
    return bv - av || a.label.localeCompare(b.label, "zh-CN");
  });
}

function flattenTree(nodes, depth = 0, rows = []) {
  sortedTreeNodes(nodes).forEach((node) => {
    rows.push({ node, depth });
    if (state.expandedRowIds.includes(node.row_id) && node.children.length) {
      flattenTree(node.children, depth + 1, rows);
    }
  });
  return rows;
}

function renderTreeTable({ bare = false } = {}) {
  const rows = flattenTree(model.attribution.tree);
  const factorLabel = state.selectedFactor ? `${FACTOR_LABELS[state.selectedFactor]}因素贡献` : "五因素合计";
  const body = `<div class="section-head"><div><h2>多维归因下钻</h2><p>固定英国口径 · 发货仓 → 运输方式 → 承运商 → 成本类别</p></div><span class="status-chip blue-chip">${state.selectedFactor ? `按${FACTOR_LABELS[state.selectedFactor]}贡献排序` : "按总差异排序"}</span></div>
    <div class="tree-state-bar"><span>当前范围：2026 年 8 月｜英国｜Actual vs Budget</span><span>德国仓 +566,770.9315 · 法国仓 +7,703.2917 · 合计 +574,474.2232</span></div>
    <table class="tree-table"><thead><tr><th>分析项</th><th>Actual 成本</th><th>Budget 成本</th><th>总差异</th><th>${escapeHtml(factorLabel)}</th></tr></thead>
      <tbody>${rows
        .map(({ node, depth }, index) => {
          const expanded = state.expandedRowIds.includes(node.row_id);
          const contribution = state.selectedFactor ? node.factor_contributions[state.selectedFactor] : node.variance;
          return `<tr id="${escapeHtml(node.row_id)}">
            <td><div class="tree-name-cell" style="padding-left:${depth * 21}px">
              ${node.children.length ? `<button class="tree-toggle" type="button" data-action="toggle-row" data-row-id="${escapeHtml(node.row_id)}" aria-expanded="${expanded}" aria-label="${expanded ? "折叠" : "展开"}${escapeHtml(node.label)}">${expanded ? "−" : "+"}</button>` : '<span class="tree-spacer"></span>'}
              ${node.children.length ? `<button class="tree-label-button" type="button" data-action="toggle-row" data-row-id="${escapeHtml(node.row_id)}">${escapeHtml(node.label)}</button>` : `<span>${escapeHtml(node.label)}</span>`}
              ${depth === 0 && index === 0 ? '<span class="max-tag">最大不利</span>' : ""}
              <button class="evidence-icon" type="button" data-action="open-evidence" data-evidence-id="${escapeHtml(node.evidence_id)}" aria-label="查看${escapeHtml(node.label)}证据">证</button>
            </div></td>
            <td class="num">¥ ${fmtMoney(node.current, 2)}</td>
            <td class="num">¥ ${fmtMoney(node.baseline, 2)}</td>
            <td class="num ${semanticClass(node.variance)}">¥ ${fmtSignedMoney(node.variance, 2)}</td>
            <td class="num contribution-cell ${semanticClass(contribution)}">¥ ${fmtSignedMoney(contribution, 2)}</td>
          </tr>`;
        })
        .join("")}</tbody>
    </table>
    <p class="tiny" style="margin:10px 0 0">底稿使用高精度值勾稽；逐行显示值因四舍五入可能存在 0.0001 CNY 报告尾差。</p>`;
  return bare ? body : `<section class="surface tree-card">${body}</section>`;
}

function renderDashboardA() {
  return `${renderTopbar()}${renderDataNotice()}<main class="dashboard-a">
    <div class="page-title-row"><div><p class="eyebrow">BUDGET PERFORMANCE CONTROL</p><h1>2026 物流预算执行驾驶舱</h1><p>从全年最新预测识别异常，再进入可审计的目的国归因。</p>${renderScopeChips(model.dashboard.scope_label, [model.dashboard.composition_label])}</div><button class="btn" type="button" data-action="start-guide">查看演示主线</button></div>
    ${renderKpiGrid()}
    <div class="a-dashboard-main">${renderChartCard()}${renderAnomalyCard({ compact: true })}</div>
    <div class="dashboard-bottom-grid">${renderFixedCostPanel()}${renderWarehouseContext()}</div>
    ${renderEvaluationGate()}
  </main>`;
}

function renderAttributionA() {
  return `${renderTopbar()}${renderDataNotice()}<main class="attribution-a">
    <div class="page-title-row"><div><button class="link-btn" type="button" data-action="back-dashboard">← 返回预算执行驾驶舱</button><p class="eyebrow" style="margin-top:12px">COST ATTRIBUTION</p><h1>英国履约变动成本归因</h1><p>从公司 8 月异常切换到英国目的国口径；固定成本不进入本页。</p>${renderScopeChips(model.attribution.scope_label, ["CHAIN", model.meta.versions.budget, model.meta.versions.actual])}</div><span class="status-chip adverse-chip">不利差异 ¥ ${fmtMoney(model.attribution.summary.variance, 2)}</span></div>
    ${renderAttributionSummary()}${renderDiagnostics()}
    <div class="a-attribution-main">${renderWaterfallCard()}${renderAiAnalysis()}</div>
    ${renderTreeTable()}${renderEvaluationGate()}
  </main>`;
}

function renderRail() {
  return `<aside class="side-rail">
    <div class="brand-lockup"><div class="brand-mark">LP</div><div><strong>LogiPlan AI</strong><span>分析工作台</span></div></div>
    <nav class="rail-nav" aria-label="原型页面">
      <button type="button" class="${state.view === "dashboard" ? "active" : ""}" data-action="back-dashboard">01 · 预算执行</button>
      <button type="button" class="${state.view === "attribution" ? "active" : ""}" data-action="nav-attribution">02 · 英国归因</button>
    </nav>
    <dl class="rail-scope"><dt>演示范围</dt><dd>${state.view === "dashboard" ? "2026 全年 · 公司" : "2026-08 · 英国"}</dd><dt>比较</dt><dd>${state.view === "dashboard" ? "Latest Outlook vs Budget" : "Actual vs Budget"}</dd><dt>报告币种</dt><dd>CNY</dd><dt>数据状态</dt><dd>已审计 · 9/9 PASS</dd></dl>
    <button class="btn secondary" style="width:100%;margin-top:20px" type="button" data-action="start-guide">查看演示主线</button>
  </aside>`;
}

function renderWorkbenchToolbar(title) {
  return `<header class="workbench-toolbar"><div><strong>${escapeHtml(title)}</strong><span class="tiny" style="margin-left:10px">求职作品集演示 · ${escapeHtml(model.meta.cost_model_revision)}</span></div><div class="top-actions"><span class="status-chip blue-chip">已审计快照</span><span class="status-chip">最近结账 ${escapeHtml(model.meta.latest_closed_month)}</span></div></header>`;
}

function renderDashboardB() {
  return `<div class="workbench-shell">${renderRail()}<main class="workbench-main">${renderWorkbenchToolbar("预算执行工作区")}${renderDataNotice()}
    <div class="workbench-content"><div class="workbench-title"><div><p class="eyebrow">ANALYSIS WORKBENCH</p><h1>2026 全年物流成本监控</h1><p class="muted">${escapeHtml(model.dashboard.composition_label)}</p></div>${renderScopeChips(model.dashboard.scope_label)}</div>
    ${renderMetricStrip()}
    <div class="b-dashboard-grid">${renderChartCard()}${renderAnomalyCard({ compact: true })}</div>
    <div class="dashboard-bottom-grid">${renderFixedCostPanel()}${renderWarehouseContext()}</div>
    ${renderEvaluationGate()}</div>
  </main></div>`;
}

function renderAttributionB() {
  return `<div class="workbench-shell">${renderRail()}<main class="workbench-main">${renderWorkbenchToolbar("归因分析工作区")}${renderDataNotice()}
    <div class="workbench-content"><div class="workbench-title"><div><p class="eyebrow">ATTRIBUTION WORKBENCH</p><h1>英国 · 2026 年 8 月</h1><p class="muted">固定范围 · 不含运营固定成本</p></div>${renderScopeChips(model.attribution.scope_label, ["CHAIN"])}</div>
    ${renderAttributionSummary()}${renderDiagnostics()}
    <div class="b-attribution-grid" style="margin-top:12px"><div class="b-main-stack">${renderWaterfallCard()}</div><div class="sticky-ai">${renderAiAnalysis()}</div></div>
    ${renderTreeTable()}${renderEvaluationGate()}</div>
  </main></div>`;
}

function renderBriefMasthead({ attribution = false } = {}) {
  const title = attribution ? "英国 8 月成本失控主要来自履约结构突变" : "全年物流总成本预计超预算 212.97 万元";
  const subtitle = attribution
    ? "英国履约变动成本较 Budget 增加 574,474.2232 CNY；结构因素贡献最大。"
    : "Latest Outlook 为 18,327,462.9382 CNY，较年度 Budget 不利 13.15%。";
  return `<header class="brief-masthead">
    <div><p class="eyebrow">LOGIPLAN AI · MANAGEMENT BRIEF</p><h1>${title}</h1><p>${subtitle}</p>${renderScopeChips(attribution ? model.attribution.scope_label : model.dashboard.scope_label, attribution ? ["CHAIN"] : [model.dashboard.composition_label])}</div>
    <div class="brief-page-label">求职作品集演示<strong>${attribution ? "归因简报" : "年度经营简报"}</strong><button class="btn secondary" style="margin-top:18px" type="button" data-action="${attribution ? "back-dashboard" : "start-guide"}">${attribution ? "返回驾驶舱" : "查看演示主线"}</button></div>
  </header>`;
}

function renderDashboardC() {
  const total = model.dashboard.kpis.total_cost;
  return `${renderDataNotice()}<main class="brief-shell">${renderBriefMasthead()}
    <section class="brief-lede" data-guide-target="annual"><div><span class="brief-section-number">EXECUTIVE SIGNAL</span><div class="big-number adverse num">¥ ${fmtMoney(total.variance, 0)}</div><p>全年不利差异 · ${fmtSignedPct(total.variance_rate)}。8 月英国是最大的单月目的国异常。</p><button class="btn" type="button" data-action="nav-attribution">进入英国异常归因</button></div><div><span class="brief-section-number">COST OUTLOOK</span><div class="big-number num">¥ ${fmtMoneyCompact(total.current)}</div><p>Budget ¥ ${fmtMoneyCompact(total.baseline)}</p><div class="cost-split"><span>变动成本<strong>¥ ${fmtMoneyCompact(model.dashboard.kpis.variable_cost.current)}</strong></span><span>固定成本<strong>¥ ${fmtMoneyCompact(model.dashboard.kpis.fixed_cost.current)}</strong></span></div></div></section>
    ${renderBriefKpis()}
    <div class="brief-spread"><section><span class="brief-section-number">01 · YEAR VIEW</span><h2 class="brief-section-title">总成本曲线在 8 月显著偏离基线</h2>${renderChartCard({ bare: true })}</section><aside><span class="brief-section-number">02 · EXCEPTION RANKING</span><h2 class="brief-section-title">不利异常集中在英国</h2>${renderEditorialAnomalies()}</aside></div>
    <div class="brief-footer-grid"><section><span class="brief-section-number">03 · FIXED COST</span><h2 class="brief-section-title">固定成本保持独立经营视角</h2>${renderFixedCostPanel({ bare: true })}</section><section><span class="brief-section-number">04 · COMPANY WAREHOUSE</span><h2 class="brief-section-title">E08 使用公司发货仓口径</h2>${renderWarehouseContext({ bare: true })}</section></div>
    ${renderEvaluationGate()}
  </main>`;
}

function renderAttributionC() {
  const summary = model.attribution.summary;
  return `${renderDataNotice()}<main class="brief-shell">${renderBriefMasthead({ attribution: true })}
    <section class="brief-lede" data-guide-target="attribution"><div><span class="brief-section-number">EXECUTIVE SIGNAL</span><div class="big-number adverse num">¥ ${fmtMoney(summary.variance, 2)}</div><p>不利差异 · ${fmtSignedPct(summary.variance_rate)} · 不含固定成本</p></div><div><span class="brief-section-number">ACTUAL / BUDGET</span><div class="big-number num" style="font-size:29px">¥ ${fmtMoney(summary.current, 2)}</div><p>Budget ¥ ${fmtMoney(summary.baseline, 2)} ${evidenceButton(summary.evidence_id)}</p></div></section>
    <div class="brief-attribution-flow">
      <section><span class="brief-section-number">01 · DIAGNOSTIC SIGNALS</span><h2 class="brief-section-title">量、履约结构与服务成熟度</h2>${renderDiagnostics()}</section>
      <section><span class="brief-section-number">02 · CAUSAL BRIDGE & MANAGEMENT READOUT</span><h2 class="brief-section-title">结构因素解释最大成本增量</h2><div class="brief-two-column"><div>${renderWaterfallCard({ bare: true })}</div><aside class="ai-card" data-guide-target="ai">${renderAiAnalysis({ bare: true })}</aside></div></section>
      <section><span class="brief-section-number">03 · AUDITABLE DRILLDOWN</span><h2 class="brief-section-title">从发货仓逐层展开到成本类别</h2>${renderTreeTable({ bare: true })}</section>
    </div>${renderEvaluationGate()}
  </main>`;
}

function renderEvidenceDrawer() {
  if (!state.evidenceId) return "";
  const item = model.evidence[state.evidenceId];
  if (!item) return "";
  const filters = Object.entries(item.filters || {})
    .map(([key, values]) => `${key}: ${values.join(", ")}`)
    .join("；") || "公司总范围";
  const versions = Object.entries(item.versions || {})
    .map(([key, value]) => `${key}: ${value}`)
    .join("；");
  const unitLabel = item.unit === "RATIO" ? "比率" : item.unit;
  const value = item.unit === "RATIO" ? fmtPct(item.value, 4) : `${fmtMoney(item.value, 4)} ${item.unit}`;
  return `<div class="drawer-scrim" data-action="close-evidence" aria-hidden="true"></div>
    <aside class="evidence-drawer" role="dialog" aria-modal="true" aria-labelledby="evidence-title">
      <div class="drawer-head"><div><span class="eyebrow">STRUCTURED EVIDENCE</span><h2 id="evidence-title">数字证据</h2></div><button class="icon-btn" type="button" data-action="close-evidence" aria-label="关闭证据侧栏">✕</button></div>
      <div class="evidence-value"><span>${escapeHtml(item.metric)}</span><strong class="num">${escapeHtml(value)}</strong><span class="tiny mono">${escapeHtml(item.evidence_id)}</span></div>
      <dl class="evidence-dl">
        <div><dt>单位</dt><dd>${escapeHtml(unitLabel)}</dd></div>
        <div><dt>期间</dt><dd>${escapeHtml(item.period.from)} — ${escapeHtml(item.period.to)}</dd></div>
        <div><dt>比较</dt><dd>${escapeHtml(item.comparison)}</dd></div>
        <div><dt>筛选</dt><dd>${escapeHtml(filters)}</dd></div>
        <div><dt>分组</dt><dd>${escapeHtml((item.group_by || []).join(" → ") || "无")}</dd></div>
        <div><dt>版本</dt><dd>${escapeHtml(versions)}</dd></div>
        <div><dt>计算方法</dt><dd>${escapeHtml(item.calculation_method)}</dd></div>
        <div><dt>来源结果</dt><dd class="mono">${escapeHtml(item.source_result_id)}</dd></div>
        <div><dt>来源引用</dt><dd>${escapeHtml((item.source_refs || []).join("；"))}</dd></div>
        <div><dt>快照日期</dt><dd>${escapeHtml(item.snapshot_generated_at)}</dd></div>
      </dl>
      <div class="drawer-actions">${item.row_path ? '<button class="btn" type="button" data-action="locate-evidence">在表格中定位</button>' : ""}<button class="btn secondary" type="button" data-action="close-evidence">关闭</button></div>
    </aside>`;
}

function renderGuide() {
  if (!state.guideStep) return "";
  const steps = {
    1: ["全年风险", "先看全年 Latest Outlook：总成本预计较 Budget 不利 212.97 万元。"],
    2: ["识别最大异常", "Top 1 是 2026 年 8 月英国。点击“下一步”或异常入口进入固定归因范围。"],
    3: ["归因与下钻", "结构因素贡献最大。可选择“结构”，再逐层展开德国仓 → 空运 → Carrier C。"],
    4: ["AI 与数字证据", "AI 示例只引用确定性结果。点击任一证据编号，可在当前页面核对口径与版本。"],
  };
  const [title, text] = steps[state.guideStep];
  return `<aside class="guide-card" role="dialog" aria-labelledby="guide-title">
    <span class="eyebrow">演示主线 · ${state.guideStep} / 4</span>
    <div class="guide-progress">${[1, 2, 3, 4].map((step) => `<span class="${step <= state.guideStep ? "active" : ""}"></span>`).join("")}</div>
    <h2 id="guide-title">${title}</h2><p>${text}</p>
    <div class="guide-actions"><button class="btn secondary" type="button" data-action="guide-close">退出</button><button class="btn" type="button" data-action="guide-next">${state.guideStep === 4 ? "完成" : "下一步"}</button></div>
  </aside>`;
}

function renderSwitcher() {
  return `<nav class="prototype-switcher" aria-label="原型方案切换">
    <button type="button" data-action="switch-variant" data-direction="-1" aria-label="上一个方案">←</button>
    <div class="switcher-label"><strong>${state.variant} · ${VARIANTS[state.variant]}</strong><br>原型结构方案 · 可用左右方向键切换</div>
    <button type="button" data-action="switch-variant" data-direction="1" aria-label="下一个方案">→</button>
  </nav>`;
}

function render() {
  if (!model) return;
  document.body.className = `variant-${state.variant.toLowerCase()} ${state.guideStep ? `guide-step-${state.guideStep}` : ""}`;
  let content = "";
  if (state.variant === "A") content = state.view === "dashboard" ? renderDashboardA() : renderAttributionA();
  if (state.variant === "B") content = state.view === "dashboard" ? renderDashboardB() : renderAttributionB();
  if (state.variant === "C") content = state.view === "dashboard" ? renderDashboardC() : renderAttributionC();
  document.getElementById("app").innerHTML = `${content}${renderGuide()}${renderEvidenceDrawer()}${renderSwitcher()}`;
}

function navigate(view) {
  state.view = view;
  state.evidenceId = null;
  updateUrl({ push: true });
  render();
  window.scrollTo({ top: 0, behavior: "auto" });
}

function cycleVariant(direction) {
  const keys = Object.keys(VARIANTS);
  const current = keys.indexOf(state.variant);
  state.variant = keys[(current + direction + keys.length) % keys.length];
  updateUrl();
  render();
}

function toggleExpanded(rowId) {
  state.expandedRowIds = state.expandedRowIds.includes(rowId)
    ? state.expandedRowIds.filter((id) => id !== rowId)
    : [...state.expandedRowIds, rowId];
}

function handleAction(actionElement) {
  const action = actionElement.dataset.action;
  if (action === "nav-attribution") return navigate("attribution");
  if (action === "back-dashboard") return navigate("dashboard");
  if (action === "switch-variant") return cycleVariant(Number(actionElement.dataset.direction));
  if (action === "toggle-fixed") {
    state.fixedCostExpanded = !state.fixedCostExpanded;
    return render();
  }
  if (action === "select-factor") {
    const factor = actionElement.dataset.factorId;
    state.selectedFactor = state.selectedFactor === factor ? null : factor;
    return render();
  }
  if (action === "clear-factor") {
    state.selectedFactor = null;
    return render();
  }
  if (action === "toggle-row") {
    toggleExpanded(actionElement.dataset.rowId);
    return render();
  }
  if (action === "open-evidence") {
    state.evidenceId = actionElement.dataset.evidenceId;
    return render();
  }
  if (action === "close-evidence") {
    state.evidenceId = null;
    return render();
  }
  if (action === "locate-evidence") {
    const item = model.evidence[state.evidenceId];
    if (!item?.row_path) return;
    state.view = "attribution";
    state.expandedRowIds = [...new Set([...state.expandedRowIds, ...item.row_path])];
    updateUrl();
    render();
    window.setTimeout(() => document.getElementById(item.row_path.at(-1))?.scrollIntoView({ block: "center" }), 0);
    return;
  }
  if (action === "start-guide") {
    state.guideStep = 1;
    state.view = "dashboard";
    state.evidenceId = null;
    updateUrl();
    return render();
  }
  if (action === "guide-close") {
    state.guideStep = 0;
    return render();
  }
  if (action === "guide-next") {
    if (state.guideStep === 2) {
      state.view = "attribution";
      updateUrl({ push: true });
    }
    state.guideStep = state.guideStep >= 4 ? 0 : state.guideStep + 1;
    return render();
  }
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target || target.disabled) return;
  handleAction(target);
});

document.addEventListener("keydown", (event) => {
  const active = document.activeElement;
  const tag = active?.tagName?.toLowerCase();
  const isEditing = tag === "input" || tag === "textarea" || active?.isContentEditable;
  if (!isEditing && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    cycleVariant(event.key === "ArrowLeft" ? -1 : 1);
    return;
  }
  if ((event.key === "Enter" || event.key === " ") && event.target.matches('[data-action][role="button"]')) {
    event.preventDefault();
    handleAction(event.target);
  }
  if (event.key === "Escape" && state.evidenceId) {
    state.evidenceId = null;
    render();
  }
});

window.addEventListener("popstate", () => {
  parseUrlState();
  state.evidenceId = null;
  render();
});

async function init() {
  parseUrlState();
  updateUrl();
  try {
    const response = await fetch("./prototype-data.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    model = await response.json();
    render();
  } catch (error) {
    document.getElementById("app").innerHTML = `<main class="loading-shell"><p class="eyebrow">PROTOTYPE DATA ERROR</p><h1>无法载入原型数据快照</h1><p class="muted">请从项目根目录启动本地服务器后访问此页面。<br><span class="mono">${escapeHtml(error.message)}</span></p></main>`;
  }
}

init();
