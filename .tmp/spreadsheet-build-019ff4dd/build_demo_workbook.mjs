import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const workspace = "C:\\Users\\Jett\\Documents\\LogiAI";
const dataPath = path.join(workspace, "data", "generated", "logiplan-2026-demo-data.json");
const evaluationPath = path.join(workspace, "data", "generated", "ai-evaluation-baseline.json");
const outputDir = path.join(workspace, "outputs", "2026-demo-data-current-labor-split");
const previewDir = path.join(workspace, ".tmp", "spreadsheet-build-019ff4dd", "previews-labor-split");
const outputPath = path.join(outputDir, "LogiPlan-AI-2026-Demo-Data.xlsx");

if (process.argv[2] === "--inspect-existing") {
  const inputPath = process.argv[3];
  const imported = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
  const checkRange = imported.worksheets.getItem("Checks").getRange("A5:E19");
  console.log(JSON.stringify({ values: checkRange.values, formulas: checkRange.formulas }, null, 2));
  const preview = await imported.render({ sheetName: "Checks", range: "A1:E19", format: "png", scale: 1 });
  await fs.writeFile(path.join(path.dirname(inputPath), "Checks-imported.png"), new Uint8Array(await preview.arrayBuffer()));
  process.exit(0);
}

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(previewDir, { recursive: true });

const data = JSON.parse(await fs.readFile(dataPath, "utf8"));
const evaluation = JSON.parse(await fs.readFile(evaluationPath, "utf8"));

const COLORS = {
  navy: "#102A43",
  blue: "#1F4E78",
  teal: "#0F766E",
  tealLight: "#DDF4EE",
  orange: "#D97706",
  orangeLight: "#FFF1D6",
  red: "#B42318",
  redLight: "#FDE8E7",
  green: "#15803D",
  greenLight: "#E5F4EA",
  sky: "#EAF2F8",
  gray: "#667085",
  lightGray: "#F2F4F7",
  border: "#D0D5DD",
  white: "#FFFFFF",
  black: "#101828",
};

const workbook = Workbook.create();
const sheetNames = [
  "Summary", "Assumptions", "Route_Master", "Model_Calc", "Cost_Facts", "Fixed_Costs",
  "GMV_Facts", "Service_Facts", "Monthly_Summary", "Country_Summary", "Attribution",
  "Scenarios", "Evaluation", "Checks", "Sources",
];
const sheets = Object.fromEntries(sheetNames.map((name) => [name, workbook.worksheets.add(name)]));

function colName(index) {
  let n = index;
  let result = "";
  while (n > 0) {
    n -= 1;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

function writeMatrix(sheet, startRow, startCol, matrix) {
  if (!matrix.length || !matrix[0].length) return;
  const endRow = startRow + matrix.length - 1;
  const endCol = startCol + matrix[0].length - 1;
  sheet.getRange(`${colName(startCol)}${startRow}:${colName(endCol)}${endRow}`).values = matrix;
}

function setFormulaColumn(sheet, col, startRow, formulas) {
  if (!formulas.length) return;
  sheet.getRange(`${col}${startRow}:${col}${startRow + formulas.length - 1}`).formulas = formulas.map((formula) => [formula]);
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Math.abs(numeric) < 1e-9 ? 0 : numeric;
}

function monthDate(monthId) {
  const [year, month] = monthId.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}

function titleBand(sheet, title, subtitle, lastCol) {
  sheet.mergeCells(`A1:${lastCol}1`);
  sheet.getRange("A1").values = [[title]];
  sheet.getRange(`A1:${lastCol}1`).format = {
    fill: COLORS.navy,
    font: { bold: true, color: COLORS.white, size: 18, name: "Aptos Display" },
    verticalAlignment: "center",
  };
  sheet.getRange(`A1:${lastCol}1`).format.rowHeight = 32;
  sheet.mergeCells(`A2:${lastCol}2`);
  sheet.getRange("A2").values = [[subtitle]];
  sheet.getRange(`A2:${lastCol}2`).format = {
    fill: COLORS.sky,
    font: { color: COLORS.gray, italic: true, size: 9, name: "Aptos" },
    verticalAlignment: "center",
    wrapText: true,
  };
  sheet.getRange(`A2:${lastCol}2`).format.rowHeight = 28;
}

function styleHeader(sheet, range) {
  sheet.getRange(range).format = {
    fill: COLORS.blue,
    font: { bold: true, color: COLORS.white, size: 9, name: "Aptos" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "outside", style: "thin", color: COLORS.border },
  };
  sheet.getRange(range).format.rowHeight = 30;
}

function styleBody(sheet, range) {
  sheet.getRange(range).format = {
    font: { color: COLORS.black, size: 9, name: "Aptos" },
    verticalAlignment: "center",
    borders: { insideHorizontal: { style: "thin", color: "#E6EAF0" } },
  };
}

function addTable(sheet, range, name) {
  const table = sheet.tables.add(range, true, name);
  table.style = "TableStyleMedium2";
  table.showBandedRows = true;
  table.showFilterButton = true;
  return table;
}

function formatNumber(sheet, range, format) {
  sheet.getRange(range).format.numberFormat = format;
}

function sourceRowMap(rows, keyFn, startRow = 5) {
  return new Map(rows.map((row, index) => [keyFn(row), startRow + index]));
}

// Summary
{
  const sheet = sheets.Summary;
  sheet.showGridLines = false;
  titleBand(sheet, "LogiPlan AI｜2026 物流财务演示数据", "虚构求职作品集数据｜Budget 2026 V1｜Actual 截至 2026-08｜Forecast 2026-08 V1｜报告币种 CNY", "S");

  const cards = [
    { label: "年度 Budget 物流总成本", labelRange: "A4:D4", valueRange: "A5:D7", formula: "=SUMIF('Monthly_Summary'!$A$5:$A$52,\"BUDGET\",'Monthly_Summary'!$I$5:$I$52)", fill: COLORS.sky, color: COLORS.blue },
    { label: "Latest Outlook 物流总成本", labelRange: "F4:I4", valueRange: "F5:I7", formula: "=SUMIF('Monthly_Summary'!$A$5:$A$52,\"LATEST_OUTLOOK\",'Monthly_Summary'!$I$5:$I$52)", fill: COLORS.sky, color: COLORS.blue },
    { label: "全年不利差异", labelRange: "K4:N4", valueRange: "K5:N7", formula: "=F5-A5", fill: COLORS.redLight, color: COLORS.red },
    { label: "Cost Saving 9—12 月节省", labelRange: "P4:S4", valueRange: "P5:S7", formula: "=SUMIF('Monthly_Summary'!$A$5:$A$52,\"FORECAST\",'Monthly_Summary'!$I$5:$I$52)-SUMIF('Monthly_Summary'!$A$5:$A$52,\"SCENARIO_COST_SAVING\",'Monthly_Summary'!$I$5:$I$52)", fill: COLORS.greenLight, color: COLORS.green },
  ];
  for (const card of cards) {
    sheet.mergeCells(card.labelRange);
    sheet.getRange(card.labelRange.split(":")[0]).values = [[card.label]];
    sheet.getRange(card.labelRange).format = { fill: card.fill, font: { bold: true, color: COLORS.gray, size: 9 }, horizontalAlignment: "center", verticalAlignment: "center", borders: { preset: "outside", style: "thin", color: COLORS.border } };
    sheet.mergeCells(card.valueRange);
    sheet.getRange(card.valueRange.split(":")[0]).formulas = [[card.formula]];
    sheet.getRange(card.valueRange).format = { fill: card.fill, font: { bold: true, color: card.color, size: 17, name: "Aptos Display" }, horizontalAlignment: "center", verticalAlignment: "center", borders: { preset: "outside", style: "thin", color: COLORS.border }, numberFormat: "#,##0;[Red](#,##0);-" };
  }
  sheet.mergeCells("A9:S10");
  sheet.getRange("A9").values = [["核心结论：2026 年 8 月英国为最大单月不利异常。促销拉动订单量，同时德国仓至英国的空运和 Carrier C 份额上升；五因素中结构影响最大、量影响其次。Cost Saving 仅在现有线路内调整，准时率约下降 0.19 个百分点并触发软提示，承运能力仍未验证。"]];
  sheet.getRange("A9:S10").format = { fill: COLORS.orangeLight, font: { color: COLORS.black, size: 10 }, wrapText: true, verticalAlignment: "center", borders: { preset: "outside", style: "thin", color: COLORS.orange } };

  sheet.getRange("A30:C30").values = [["月份", "Budget", "Latest Outlook"]];
  styleHeader(sheet, "A30:C30");
  const monthlyRows = sourceRowMap(data.monthly_summary, (row) => `${row.series_id}|${row.month_id}`);
  const trendValues = [];
  const trendFormulasBudget = [];
  const trendFormulasLatest = [];
  for (let month = 1; month <= 12; month += 1) {
    const monthId = `2026-${String(month).padStart(2, "0")}`;
    trendValues.push([`${month}月`, null, null]);
    trendFormulasBudget.push([`='Monthly_Summary'!I${monthlyRows.get(`BUDGET|${monthId}`)}`]);
    trendFormulasLatest.push([`='Monthly_Summary'!I${monthlyRows.get(`LATEST_OUTLOOK|${monthId}`)}`]);
  }
  writeMatrix(sheet, 31, 1, trendValues);
  sheet.getRange("B31:B42").formulas = trendFormulasBudget;
  sheet.getRange("C31:C42").formulas = trendFormulasLatest;
  styleBody(sheet, "A31:C42");
  formatNumber(sheet, "B31:C42", "#,##0;[Red](#,##0);-");

  sheet.getRange("E30:F30").values = [["因素", "8 月英国差异"]];
  styleHeader(sheet, "E30:F30");
  const factors = [["量", "VOLUME"], ["结构", "MIX"], ["效率", "EFFICIENCY"], ["价", "PRICE"], ["汇率", "FX"]];
  writeMatrix(sheet, 31, 5, factors.map(([label]) => [label, null]));
  for (let index = 0; index < factors.length; index += 1) {
    const factor = factors[index][1];
    sheet.getRange(`F${31 + index}`).formulas = [[`=SUMIFS('Attribution'!$G$5:$G$804,'Attribution'!$A$5:$A$804,\"ACTUAL_VS_BUDGET\",'Attribution'!$B$5:$B$804,DATE(2026,8,1),'Attribution'!$C$5:$C$804,\"CHAIN\",'Attribution'!$D$5:$D$804,\"${factor}\",'Attribution'!$E$5:$E$804,\"GB\")`]];
  }
  styleBody(sheet, "E31:F35");
  formatNumber(sheet, "F31:F35", "#,##0;[Red](#,##0);-");

  sheet.getRange("H30:K30").values = [["月份", "Forecast", "Cost Saving", "差异"]];
  styleHeader(sheet, "H30:K30");
  const scenarioRows = [];
  for (let month = 9; month <= 12; month += 1) {
    const monthId = `2026-${String(month).padStart(2, "0")}`;
    scenarioRows.push([`${month}月`, null, null, null]);
  }
  writeMatrix(sheet, 31, 8, scenarioRows);
  for (let month = 9; month <= 12; month += 1) {
    const monthId = `2026-${String(month).padStart(2, "0")}`;
    const row = 31 + month - 9;
    sheet.getRange(`I${row}`).formulas = [[`='Monthly_Summary'!I${monthlyRows.get(`FORECAST|${monthId}`)}`]];
    sheet.getRange(`J${row}`).formulas = [[`='Monthly_Summary'!I${monthlyRows.get(`SCENARIO_COST_SAVING|${monthId}`)}`]];
    sheet.getRange(`K${row}`).formulas = [[`=J${row}-I${row}`]];
  }
  styleBody(sheet, "H31:K34");
  formatNumber(sheet, "I31:K34", "#,##0;[Red](#,##0);-");

  const trendChart = sheet.charts.add("line", sheet.getRange("A30:C42"));
  trendChart.title = "月度物流总成本：Budget vs Latest Outlook（CNY）";
  trendChart.hasLegend = true;
  trendChart.xAxis = { axisType: "textAxis", textStyle: { fontSize: 9 } };
  trendChart.yAxis = { numberFormatCode: "#,##0", textStyle: { fontSize: 9 } };
  trendChart.setPosition("A12", "I27");

  const factorChart = sheet.charts.add("bar", sheet.getRange("E30:F35"));
  factorChart.title = "2026 年 8 月英国不利差异驱动（CNY）";
  factorChart.hasLegend = false;
  factorChart.xAxis = { axisType: "textAxis", textStyle: { fontSize: 9 } };
  factorChart.yAxis = { numberFormatCode: "#,##0", textStyle: { fontSize: 9 } };
  factorChart.setPosition("K12", "S27");

  sheet.getRange("A:S").format.columnWidth = 11;
  sheet.getRange("A:A").format.columnWidth = 12;
  sheet.getRange("E:E").format.columnWidth = 12;
  sheet.getRange("H:H").format.columnWidth = 12;
  sheet.freezePanes.freezeRows(2);
}

// Assumptions
{
  const sheet = sheets.Assumptions;
  titleBand(sheet, "模型假设与版本边界", "蓝色为冻结规则；黄色为本次虚构数据的演示参数。任何新业务定义应先进入 decisions.md。", "D");
  const rows = [
    ["类别", "项目", "取值", "说明"],
    ["冻结规则", "事实粒度", data.metadata.fact_grain, "月 × 目的国 × 发货仓 × 承运商 × 运输方式"],
    ["冻结规则", "报告币种", data.metadata.reporting_currency, "保留原币、币种和汇率字段"],
    ["冻结规则", "最新结账月", data.metadata.latest_closed_month, "1—8 月 Actual；9—12 月 Forecast"],
    ["冻结规则", "归因顺序", data.metadata.attribution_sequence.join(" → "), "Shapley 32 个组合仅作后台参考"],
    ["冻结规则", "变动成本范围", "6 类", "基础运费、燃油附加费、一线作业弹性人工、包装、退货物流、异常配送"],
    ["冻结规则", "固定成本范围", "4 类", "仓租、一线作业基础人工、仓库管理人工、系统费用单独展示"],
    ["冻结规则", "人工成本口径", data.metadata.cost_model_revision, "计件、加班和临时用工为变动成本；一线底薪及管理人工为固定成本"],
    ["冻结规则", "订单—仓库关系", "单订单单发货仓", "仓内允许拆包并分配不同线路"],
    ["冻结规则", "情景服务约束", "软提示", "允许用户保留极端情景；不作为硬阻断"],
    ["冻结规则", "承运能力", "MVP 未验证", "数学计算暂按无限容量，不代表供应商确认"],
    ["演示参数", "Growth Case", "英国 9—12 月 +10%", "各月相对自身 Forecast 独立调整，不复利"],
    ["演示参数", "Cost Saving 节奏", "9 月准备；10 月部分；11—12 月完全", "仅在现有承运商与有效线路内调整"],
    ["演示参数", "8 月英国背景", "UK promotion", "管理动作注释：提高德国仓至英国空运和 Carrier C 份额"],
    ["演示参数", "税费", "不含 VAT/销售税", "正常清关在基础运费，异常清关在异常配送费"],
    ["技术规则", "高精度权威数据", "Decimal / numeric(50,24)", "工作簿公式用于审阅；JSON 保留高精度计算结果"],
  ];
  writeMatrix(sheet, 4, 1, rows);
  styleHeader(sheet, "A4:D4");
  styleBody(sheet, `A5:D${3 + rows.length}`);
  sheet.getRange(`A5:A${3 + rows.length}`).format.font = { bold: true, color: COLORS.blue };
  sheet.getRange(`C5:C${3 + rows.length}`).format.fill = COLORS.orangeLight;
  sheet.getRange(`A4:D${3 + rows.length}`).format.wrapText = true;
  sheet.getRange("A4:A19").format.columnWidth = 14;
  sheet.getRange("B4:B19").format.columnWidth = 24;
  sheet.getRange("C4:C19").format.columnWidth = 30;
  sheet.getRange("D4:D19").format.columnWidth = 58;
  sheet.freezePanes.freezeRows(4);
  addTable(sheet, `A4:D${3 + rows.length}`, "AssumptionsTable");
}

// Route master
{
  const sheet = sheets.Route_Master;
  titleBand(sheet, "有效履约线路主数据", "只允许白名单线路；承运能力状态为 MVP 未验证。", "J");
  const headers = ["Route ID", "目的国", "发货仓", "承运商", "运输方式", "启用日期", "停用日期", "容量状态", "目的国名称", "线路说明"];
  const rows = data.dimensions.routes.map((row) => [
    row.route_id, row.destination_country_id, row.fulfillment_center_id, row.carrier_id, row.transport_mode_id,
    new Date(`${row.active_from}T00:00:00Z`), row.active_to ? new Date(`${row.active_to}T00:00:00Z`) : null,
    row.capacity_status, { DE: "德国", FR: "法国", GB: "英国" }[row.destination_country_id],
    `${row.fulfillment_center_id} → ${row.destination_country_id}｜${row.carrier_id}｜${row.transport_mode_id}`,
  ]);
  writeMatrix(sheet, 4, 1, [headers, ...rows]);
  styleHeader(sheet, "A4:J4");
  styleBody(sheet, `A5:J${4 + rows.length}`);
  formatNumber(sheet, `F5:G${4 + rows.length}`, "yyyy-mm-dd");
  sheet.getRange(`A4:J${4 + rows.length}`).format.wrapText = true;
  sheet.getRange("A4:A14").format.columnWidth = 24;
  sheet.getRange("B4:I14").format.columnWidth = 15;
  sheet.getRange("H4:H14").format.columnWidth = 24;
  sheet.getRange("I4:I14").format.columnWidth = 14;
  sheet.getRange("J4:J14").format.columnWidth = 44;
  sheet.freezePanes.freezeRows(4);
  sheet.freezePanes.freezeColumns(1);
  addTable(sheet, `A4:J${4 + rows.length}`, "RouteMasterTable");
}

// Model calculation audit sheet
const modelCalcRows = data.driver_facts;
const modelCalcStart = 5;
const modelCalcEnd = modelCalcStart + modelCalcRows.length - 1;
const serviceRateMap = new Map(data.service_facts.map((row) => [`${row.version_id}|${row.month_id}|${row.route_id}`, asNumber(row.on_time_rate)]));
const modelRowMap = new Map();
{
  const sheet = sheets.Model_Calc;
  titleBand(sheet, "线路驱动与公式计算", "浅黄色列为输入；浅蓝色列为公式结果。工作簿公式用于审阅，权威高精度结果保存在生成 JSON。", "BG");
  const headers = [
    "Version", "Type", "Scenario", "Month", "Route", "Destination", "FC", "Carrier", "Mode",
    "Total Orders", "Destination Share", "Warehouse Share", "Route Package Share", "Equivalent Orders", "Avg Packages/Order", "Packages",
    "Avg Chargeable Weight kg", "Chargeable Weight kg", "Return Rate", "Return Packages", "Events/Package", "Billable Events",
    "Transport Currency", "Base Rate/kg", "Fuel Basis", "Fuel Rate/Unit", "EUR/CNY", "GBP/CNY", "Transport FX",
    "Base Freight Original", "Fuel Original", "Base Freight CNY", "Fuel CNY", "Variable Labor Currency", "Variable Labor Unit Price", "Variable Labor FX", "Variable Labor Original", "Variable Labor CNY",
    "Packaging Currency", "Packaging Unit Price", "Packaging FX", "Packaging Original", "Packaging CNY", "Return Currency", "Return Unit Price", "Return FX", "Return Original", "Return CNY",
    "Exception Currency", "Exception Unit Price", "Exception FX", "Exception Original", "Exception CNY", "Variable Cost CNY", "Expected On-time Rate",
    "Event Note", "Management Action Note", "Scenario Note", "Capacity Assumption",
  ];
  const rows = modelCalcRows.map((row, index) => {
    const excelRow = modelCalcStart + index;
    modelRowMap.set(`${row.version_id}|${row.month_id}|${row.route_id}`, excelRow);
    return [
      row.version_id, row.data_type, row.scenario_id, monthDate(row.month_id), row.route_id, row.destination_country_id,
      row.fulfillment_center_id, row.carrier_id, row.transport_mode_id, asNumber(row.total_company_orders), asNumber(row.destination_order_share),
      asNumber(row.warehouse_order_share), asNumber(row.route_package_share), null, asNumber(row.average_packages_per_order), null,
      asNumber(row.average_chargeable_weight_per_package_kg), null, asNumber(row.return_rate), null, asNumber(row.billable_events_per_package), null,
      row.transport_currency, asNumber(row.effective_base_rate_per_kg), row.fuel_charge_basis, asNumber(row.fuel_rate_or_unit_price),
      asNumber(row.eur_cny_rate), asNumber(row.gbp_cny_rate), null, null, null, null, null,
      row.frontline_variable_labor_currency, asNumber(row.frontline_variable_labor_unit_price), null, null, null,
      row.packaging_currency, asNumber(row.packaging_unit_price), null, null, null,
      row.return_currency, asNumber(row.return_unit_price), null, null, null,
      row.exception_currency, asNumber(row.exception_unit_price), null, null, null, null,
      serviceRateMap.get(`${row.version_id}|${row.month_id}|${row.route_id}`), row.event_note, row.management_action_note, row.scenario_note, row.capacity_assumption,
    ];
  });
  writeMatrix(sheet, 4, 1, [headers, ...rows]);
  const formulaRows = Array.from({ length: rows.length }, (_, index) => modelCalcStart + index);
  setFormulaColumn(sheet, "N", modelCalcStart, formulaRows.map((r) => `=J${r}*K${r}*L${r}*M${r}`));
  setFormulaColumn(sheet, "P", modelCalcStart, formulaRows.map((r) => `=N${r}*O${r}`));
  setFormulaColumn(sheet, "R", modelCalcStart, formulaRows.map((r) => `=P${r}*Q${r}`));
  setFormulaColumn(sheet, "T", modelCalcStart, formulaRows.map((r) => `=N${r}*S${r}`));
  setFormulaColumn(sheet, "V", modelCalcStart, formulaRows.map((r) => `=P${r}*U${r}`));
  setFormulaColumn(sheet, "AC", modelCalcStart, formulaRows.map((r) => `=IF(W${r}=\"EUR\",AA${r},IF(W${r}=\"GBP\",AB${r},1))`));
  setFormulaColumn(sheet, "AD", modelCalcStart, formulaRows.map((r) => `=R${r}*X${r}`));
  setFormulaColumn(sheet, "AE", modelCalcStart, formulaRows.map((r) => `=IF(Y${r}=\"PERCENTAGE_OF_BASE_FREIGHT\",AD${r}*Z${r},IF(Y${r}=\"PER_CHARGEABLE_KG\",R${r}*Z${r},P${r}*Z${r}))`));
  setFormulaColumn(sheet, "AF", modelCalcStart, formulaRows.map((r) => `=AD${r}*AC${r}`));
  setFormulaColumn(sheet, "AG", modelCalcStart, formulaRows.map((r) => `=AE${r}*AC${r}`));
  setFormulaColumn(sheet, "AJ", modelCalcStart, formulaRows.map((r) => `=IF(AH${r}=\"EUR\",AA${r},IF(AH${r}=\"GBP\",AB${r},1))`));
  setFormulaColumn(sheet, "AK", modelCalcStart, formulaRows.map((r) => `=N${r}*AI${r}`));
  setFormulaColumn(sheet, "AL", modelCalcStart, formulaRows.map((r) => `=AK${r}*AJ${r}`));
  setFormulaColumn(sheet, "AO", modelCalcStart, formulaRows.map((r) => `=IF(AM${r}=\"EUR\",AA${r},IF(AM${r}=\"GBP\",AB${r},1))`));
  setFormulaColumn(sheet, "AP", modelCalcStart, formulaRows.map((r) => `=P${r}*AN${r}`));
  setFormulaColumn(sheet, "AQ", modelCalcStart, formulaRows.map((r) => `=AP${r}*AO${r}`));
  setFormulaColumn(sheet, "AT", modelCalcStart, formulaRows.map((r) => `=IF(AR${r}=\"EUR\",AA${r},IF(AR${r}=\"GBP\",AB${r},1))`));
  setFormulaColumn(sheet, "AU", modelCalcStart, formulaRows.map((r) => `=T${r}*AS${r}`));
  setFormulaColumn(sheet, "AV", modelCalcStart, formulaRows.map((r) => `=AU${r}*AT${r}`));
  setFormulaColumn(sheet, "AY", modelCalcStart, formulaRows.map((r) => `=IF(AW${r}=\"EUR\",AA${r},IF(AW${r}=\"GBP\",AB${r},1))`));
  setFormulaColumn(sheet, "AZ", modelCalcStart, formulaRows.map((r) => `=V${r}*AX${r}`));
  setFormulaColumn(sheet, "BA", modelCalcStart, formulaRows.map((r) => `=AZ${r}*AY${r}`));
  setFormulaColumn(sheet, "BB", modelCalcStart, formulaRows.map((r) => `=AF${r}+AG${r}+AL${r}+AQ${r}+AV${r}+BA${r}`));

  styleHeader(sheet, "A4:BG4");
  styleBody(sheet, `A5:BG${modelCalcEnd}`);
  sheet.getRange(`J5:M${modelCalcEnd}`).format.fill = COLORS.orangeLight;
  sheet.getRange(`O5:Q${modelCalcEnd}`).format.fill = COLORS.orangeLight;
  sheet.getRange(`S5:AB${modelCalcEnd}`).format.fill = COLORS.orangeLight;
  sheet.getRange(`N5:N${modelCalcEnd}`).format.fill = COLORS.sky;
  sheet.getRange(`P5:P${modelCalcEnd}`).format.fill = COLORS.sky;
  sheet.getRange(`R5:R${modelCalcEnd}`).format.fill = COLORS.sky;
  sheet.getRange(`T5:V${modelCalcEnd}`).format.fill = COLORS.sky;
  sheet.getRange(`AC5:BB${modelCalcEnd}`).format.fill = COLORS.sky;
  formatNumber(sheet, `D5:D${modelCalcEnd}`, "yyyy-mm");
  formatNumber(sheet, `J5:J${modelCalcEnd}`, "#,##0.0000");
  formatNumber(sheet, `K5:M${modelCalcEnd}`, "0.0000%");
  formatNumber(sheet, `N5:V${modelCalcEnd}`, "#,##0.0000");
  formatNumber(sheet, `X5:X${modelCalcEnd}`, "#,##0.0000");
  formatNumber(sheet, `Z5:BB${modelCalcEnd}`, "#,##0.0000");
  formatNumber(sheet, `BC5:BC${modelCalcEnd}`, "0.00%");
  sheet.getRange(`A4:I${modelCalcEnd}`).format.columnWidth = 16;
  sheet.getRange(`J4:BC${modelCalcEnd}`).format.columnWidth = 13;
  sheet.getRange(`BD4:BG${modelCalcEnd}`).format.columnWidth = 30;
  sheet.getRange(`BD5:BG${modelCalcEnd}`).format.wrapText = true;
  sheet.freezePanes.freezeRows(4);
  sheet.freezePanes.freezeColumns(5);
  addTable(sheet, `A4:BG${modelCalcEnd}`, "ModelCalcTable");
}

// Cost facts and formula tie-out
const costStart = 5;
const costEnd = costStart + data.cost_facts.length - 1;
{
  const sheet = sheets.Cost_Facts;
  titleBand(sheet, "履约变动成本事实", "每条成本事实与 Model_Calc 的线路公式列直接勾稽；Actual 权威金额差异必须为零。", "T");
  const headers = ["Version", "Type", "Scenario", "Month", "Route", "Destination", "FC", "Carrier", "Mode", "Cost Component", "Currency", "Original Amount", "FX", "High Precision CNY (text)", "Report CNY", "Authority CNY", "Authority Delta", "Posting Basis", "Model Recalc CNY", "Recalc Delta"];
  const componentColumn = { BASE_FREIGHT: "AF", FUEL_SURCHARGE: "AG", FRONTLINE_VARIABLE_LABOR: "AL", PACKAGING: "AQ", RETURN_LOGISTICS: "AV", BILLABLE_EXCEPTION: "BA" };
  const rows = data.cost_facts.map((row) => [
    row.version_id, row.data_type, row.scenario_id, monthDate(row.month_id), row.route_id, row.destination_country_id,
    row.fulfillment_center_id, row.carrier_id, row.transport_mode_id, row.cost_component_id, row.currency,
    asNumber(row.original_amount), asNumber(row.fx_rate), row.model_cost_cny_high_precision, asNumber(row.model_cost_cny_report),
    asNumber(row.authority_cost_cny_report), asNumber(row.authority_model_delta_cny), row.posting_basis, null, null,
  ]);
  writeMatrix(sheet, 4, 1, [headers, ...rows]);
  const recalcFormulas = data.cost_facts.map((row) => {
    const modelRow = modelRowMap.get(`${row.version_id}|${row.month_id}|${row.route_id}`);
    return `='Model_Calc'!${componentColumn[row.cost_component_id]}${modelRow}`;
  });
  setFormulaColumn(sheet, "S", costStart, recalcFormulas);
  setFormulaColumn(sheet, "T", costStart, Array.from({ length: rows.length }, (_, index) => `=ROUND(S${costStart + index}-O${costStart + index},4)`));
  styleHeader(sheet, "A4:T4");
  styleBody(sheet, `A5:T${costEnd}`);
  formatNumber(sheet, `D5:D${costEnd}`, "yyyy-mm");
  formatNumber(sheet, `L5:M${costEnd}`, "#,##0.0000");
  formatNumber(sheet, `O5:T${costEnd}`, "#,##0.0000;[Red](#,##0.0000);-");
  sheet.getRange(`S5:T${costEnd}`).format.fill = COLORS.sky;
  sheet.getRange(`A4:T${costEnd}`).format.columnWidth = 15;
  sheet.getRange(`J4:J${costEnd}`).format.columnWidth = 30;
  sheet.getRange(`N4:N${costEnd}`).format.columnWidth = 26;
  sheet.freezePanes.freezeRows(4);
  sheet.freezePanes.freezeColumns(5);
  addTable(sheet, `A4:T${costEnd}`, "CostFactsTable");
}

// Fixed costs
const fixedStart = 5;
const fixedEnd = fixedStart + data.fixed_cost_facts.length - 1;
{
  const sheet = sheets.Fixed_Costs;
  titleBand(sheet, "固定成本事实", "仓租、一线作业基础人工、仓库管理人工和系统费用按发货仓或共享范围单独展示，不分摊到目的国或线路。", "M");
  const headers = ["Version", "Type", "Scenario", "Month", "Scope", "Category", "Currency", "Original Amount", "FX", "High Precision CNY (text)", "Report CNY", "Recalc CNY", "Delta"];
  const rows = data.fixed_cost_facts.map((row) => [row.version_id, row.data_type, row.scenario_id, monthDate(row.month_id), row.scope_id, row.fixed_cost_category_id, row.currency, asNumber(row.original_amount), asNumber(row.fx_rate), row.cost_cny_high_precision, asNumber(row.cost_cny_report), null, null]);
  writeMatrix(sheet, 4, 1, [headers, ...rows]);
  setFormulaColumn(sheet, "L", fixedStart, Array.from({ length: rows.length }, (_, i) => `=H${fixedStart + i}*I${fixedStart + i}`));
  setFormulaColumn(sheet, "M", fixedStart, Array.from({ length: rows.length }, (_, i) => `=L${fixedStart + i}-K${fixedStart + i}`));
  styleHeader(sheet, "A4:M4"); styleBody(sheet, `A5:M${fixedEnd}`);
  formatNumber(sheet, `D5:D${fixedEnd}`, "yyyy-mm");
  formatNumber(sheet, `H5:M${fixedEnd}`, "#,##0.0000;[Red](#,##0.0000);-");
  sheet.getRange(`L5:M${fixedEnd}`).format.fill = COLORS.sky;
  sheet.getRange(`A4:M${fixedEnd}`).format.columnWidth = 16;
  sheet.getRange(`F4:F${fixedEnd}`).format.columnWidth = 34;
  sheet.getRange(`J4:J${fixedEnd}`).format.columnWidth = 26;
  sheet.freezePanes.freezeRows(4); sheet.freezePanes.freezeColumns(4);
  addTable(sheet, `A4:M${fixedEnd}`, "FixedCostFactsTable");
}

// GMV facts
const gmvStart = 5;
const gmvEnd = gmvStart + data.gmv_facts.length - 1;
{
  const sheet = sheets.GMV_Facts;
  titleBand(sheet, "履约 GMV 事实", "GMV 粒度为月份 × 目的国 × 版本，不复制或分摊到线路。", "N");
  const headers = ["Version", "Type", "Scenario", "Month", "Destination", "Currency", "Original Amount", "FX", "High Precision CNY (text)", "Report CNY", "Recalc CNY", "Delta", "Source Class", "Note"];
  const rows = data.gmv_facts.map((row) => [row.version_id, row.data_type, row.scenario_id, monthDate(row.month_id), row.destination_country_id, row.currency, asNumber(row.original_amount), asNumber(row.fx_rate), row.gmv_cny_high_precision, asNumber(row.gmv_cny_report), null, null, "SYNTHETIC_DEMO_DATA", "履约 GMV，不含取消订单"]);
  writeMatrix(sheet, 4, 1, [headers, ...rows]);
  setFormulaColumn(sheet, "K", gmvStart, Array.from({ length: rows.length }, (_, i) => `=G${gmvStart + i}*H${gmvStart + i}`));
  setFormulaColumn(sheet, "L", gmvStart, Array.from({ length: rows.length }, (_, i) => `=K${gmvStart + i}-J${gmvStart + i}`));
  styleHeader(sheet, "A4:N4"); styleBody(sheet, `A5:N${gmvEnd}`);
  formatNumber(sheet, `D5:D${gmvEnd}`, "yyyy-mm");
  formatNumber(sheet, `G5:L${gmvEnd}`, "#,##0.0000;[Red](#,##0.0000);-");
  sheet.getRange(`K5:L${gmvEnd}`).format.fill = COLORS.sky;
  sheet.getRange(`A4:N${gmvEnd}`).format.columnWidth = 16;
  sheet.getRange(`I4:I${gmvEnd}`).format.columnWidth = 26;
  sheet.getRange(`M4:M${gmvEnd}`).format.columnWidth = 24;
  sheet.getRange(`N4:N${gmvEnd}`).format.columnWidth = 30;
  sheet.freezePanes.freezeRows(4); sheet.freezePanes.freezeColumns(4);
  addTable(sheet, `A4:N${gmvEnd}`, "GMVFactsTable");
}

// Service facts
const serviceStart = 5;
const serviceEnd = serviceStart + data.service_facts.length - 1;
{
  const sheet = sheets.Service_Facts;
  titleBand(sheet, "服务事实与成熟度", "Actual 准时率 = 按时妥投包裹 ÷ 已到承诺截止日期包裹；Forecast/情景使用版本化线路预计准时率。", "P");
  const headers = ["Version", "Type", "Scenario", "Month", "Route", "Destination", "FC", "Carrier", "Mode", "Cohort Packages", "Due Packages", "On-time Packages", "On-time Rate", "Maturity Rate", "Recalc Rate", "Delta"];
  const rows = data.service_facts.map((row) => [row.version_id, row.data_type, row.scenario_id, monthDate(row.month_id), row.route_id, row.destination_country_id, row.fulfillment_center_id, row.carrier_id, row.transport_mode_id, asNumber(row.cohort_package_count), asNumber(row.due_package_count), asNumber(row.on_time_package_count), asNumber(row.on_time_rate), asNumber(row.service_maturity_rate), null, null]);
  writeMatrix(sheet, 4, 1, [headers, ...rows]);
  setFormulaColumn(sheet, "O", serviceStart, Array.from({ length: rows.length }, (_, i) => `=IF(K${serviceStart + i}=\"\",M${serviceStart + i},L${serviceStart + i}/K${serviceStart + i})`));
  setFormulaColumn(sheet, "P", serviceStart, Array.from({ length: rows.length }, (_, i) => `=O${serviceStart + i}-M${serviceStart + i}`));
  styleHeader(sheet, "A4:P4"); styleBody(sheet, `A5:P${serviceEnd}`);
  formatNumber(sheet, `D5:D${serviceEnd}`, "yyyy-mm");
  formatNumber(sheet, `J5:L${serviceEnd}`, "#,##0.0000");
  formatNumber(sheet, `M5:P${serviceEnd}`, "0.0000%");
  sheet.getRange(`O5:P${serviceEnd}`).format.fill = COLORS.sky;
  sheet.getRange(`A4:P${serviceEnd}`).format.columnWidth = 15;
  sheet.getRange(`E4:E${serviceEnd}`).format.columnWidth = 24;
  sheet.freezePanes.freezeRows(4); sheet.freezePanes.freezeColumns(5);
  addTable(sheet, `A4:P${serviceEnd}`, "ServiceFactsTable");
}

// Monthly summary
const monthlyStart = 5;
const monthlyEnd = monthlyStart + data.monthly_summary.length - 1;
const monthlyRowMap = sourceRowMap(data.monthly_summary, (row) => `${row.series_id}|${row.month_id}`, monthlyStart);
{
  const sheet = sheets.Monthly_Summary;
  titleBand(sheet, "月度管理汇总", "统一时间轴；Actual、Budget、Forecast、Latest Outlook 与三类情景使用同一指标口径。", "P");
  const headers = ["Series", "Month", "Orders", "Packages", "Chargeable Weight kg", "Variable Cost CNY", "Fixed Cost CNY", "Source Total Cost CNY", "Recalc Total Cost CNY", "Delta", "GMV CNY", "Company Total Cost Rate", "Unit Variable/Order", "Transport Cost/kg", "On-time Rate", "Maturity Rate"];
  const rows = data.monthly_summary.map((row) => [row.series_id, monthDate(row.month_id), asNumber(row.orders), asNumber(row.packages), asNumber(row.chargeable_weight_kg), asNumber(row.variable_cost_cny_report), asNumber(row.fixed_cost_cny_report), asNumber(row.total_cost_cny_report), null, null, asNumber(row.gmv_cny_report), null, null, asNumber(row.transport_cost_per_kg_cny), asNumber(row.on_time_rate), asNumber(row.service_maturity_rate)]);
  writeMatrix(sheet, 4, 1, [headers, ...rows]);
  setFormulaColumn(sheet, "I", monthlyStart, Array.from({ length: rows.length }, (_, i) => `=F${monthlyStart + i}+G${monthlyStart + i}`));
  setFormulaColumn(sheet, "J", monthlyStart, Array.from({ length: rows.length }, (_, i) => `=ROUND(I${monthlyStart + i}-H${monthlyStart + i},4)`));
  setFormulaColumn(sheet, "L", monthlyStart, Array.from({ length: rows.length }, (_, i) => `=I${monthlyStart + i}/K${monthlyStart + i}`));
  setFormulaColumn(sheet, "M", monthlyStart, Array.from({ length: rows.length }, (_, i) => `=F${monthlyStart + i}/C${monthlyStart + i}`));
  styleHeader(sheet, "A4:P4"); styleBody(sheet, `A5:P${monthlyEnd}`);
  formatNumber(sheet, `B5:B${monthlyEnd}`, "yyyy-mm");
  formatNumber(sheet, `C5:E${monthlyEnd}`, "#,##0.0000");
  formatNumber(sheet, `F5:K${monthlyEnd}`, "#,##0.0000;[Red](#,##0.0000);-");
  formatNumber(sheet, `L5:L${monthlyEnd}`, "0.00%");
  formatNumber(sheet, `M5:N${monthlyEnd}`, "#,##0.0000");
  formatNumber(sheet, `O5:P${monthlyEnd}`, "0.00%");
  sheet.getRange(`I5:J${monthlyEnd}`).format.fill = COLORS.sky;
  sheet.getRange(`L5:M${monthlyEnd}`).format.fill = COLORS.sky;
  sheet.getRange(`A4:P${monthlyEnd}`).format.columnWidth = 17;
  sheet.freezePanes.freezeRows(4); sheet.freezePanes.freezeColumns(2);
  addTable(sheet, `A4:P${monthlyEnd}`, "MonthlySummaryTable");
}

// Country summary
const countryStart = 5;
const countryEnd = countryStart + data.country_summary.length - 1;
{
  const sheet = sheets.Country_Summary;
  titleBand(sheet, "目的国管理汇总", "目的国层只展示履约变动成本率；固定成本不分摊到目的国。", "N");
  const headers = ["Series", "Month", "Destination", "Orders", "Packages", "Variable Cost CNY", "GMV CNY", "Variable Cost Rate", "Air Package Share", "Carrier C Share", "On-time Rate", "Maturity Rate", "Variable Cost/Order", "Note"];
  const rows = data.country_summary.map((row) => [row.series_id, monthDate(row.month_id), row.destination_country_id, asNumber(row.orders), asNumber(row.packages), asNumber(row.variable_cost_cny_report), asNumber(row.gmv_cny_report), asNumber(row.destination_variable_cost_rate), asNumber(row.air_package_share), asNumber(row.carrier_c_package_share), asNumber(row.on_time_rate), asNumber(row.service_maturity_rate), null, row.destination_country_id === "GB" && row.month_id === "2026-08" ? "核心异常范围" : null]);
  writeMatrix(sheet, 4, 1, [headers, ...rows]);
  setFormulaColumn(sheet, "M", countryStart, Array.from({ length: rows.length }, (_, i) => `=F${countryStart + i}/D${countryStart + i}`));
  styleHeader(sheet, "A4:N4"); styleBody(sheet, `A5:N${countryEnd}`);
  formatNumber(sheet, `B5:B${countryEnd}`, "yyyy-mm");
  formatNumber(sheet, `D5:G${countryEnd}`, "#,##0.0000");
  formatNumber(sheet, `H5:L${countryEnd}`, "0.00%");
  formatNumber(sheet, `M5:M${countryEnd}`, "#,##0.0000");
  sheet.getRange(`M5:M${countryEnd}`).format.fill = COLORS.sky;
  sheet.getRange(`A4:N${countryEnd}`).format.columnWidth = 17;
  sheet.getRange(`N4:N${countryEnd}`).format.columnWidth = 25;
  sheet.freezePanes.freezeRows(4); sheet.freezePanes.freezeColumns(3);
  addTable(sheet, `A4:N${countryEnd}`, "CountrySummaryTable");
}

// Attribution and reconciliation
const attributionRows = [
  ...data.attribution_summary.map((row) => ({ ...row, destination_country_id: "ALL" })),
  ...data.attribution_country_summary,
];
attributionRows.sort((a, b) => `${a.comparison_id}|${a.month_id}|${a.method_id}|${a.factor_id}|${a.destination_country_id}`.localeCompare(`${b.comparison_id}|${b.month_id}|${b.method_id}|${b.factor_id}|${b.destination_country_id}`));
const attributionStart = 5;
const attributionEnd = attributionStart + attributionRows.length - 1;
{
  const sheet = sheets.Attribution;
  titleBand(sheet, "五因素归因与 Shapley 参考", "正式口径为量→结构→效率→价→汇率连环替代；ALL 为公司层，国家行由同一原子归因向上汇总。", "S");
  const headers = ["Comparison", "Month", "Method", "Factor", "Destination", "High Precision CNY (text)", "Report CNY", "Shapley Difference", "Normalized Sensitivity", "Order Sensitive"];
  const rows = attributionRows.map((row) => [row.comparison_id, monthDate(row.month_id), row.method_id, row.factor_id, row.destination_country_id, row.amount_cny_high_precision, asNumber(row.amount_cny_report), asNumber(row.shapley_difference_cny), asNumber(row.normalized_order_sensitivity), row.is_order_sensitive ?? null]);
  writeMatrix(sheet, 4, 1, [headers, ...rows]);
  styleHeader(sheet, "A4:J4"); styleBody(sheet, `A5:J${attributionEnd}`);
  formatNumber(sheet, `B5:B${attributionEnd}`, "yyyy-mm");
  formatNumber(sheet, `G5:H${attributionEnd}`, "#,##0.0000;[Red](#,##0.0000);-");
  formatNumber(sheet, `I5:I${attributionEnd}`, "0.00%");
  sheet.getRange(`A4:J${attributionEnd}`).format.columnWidth = 18;
  sheet.getRange(`F4:F${attributionEnd}`).format.columnWidth = 26;
  addTable(sheet, `A4:J${attributionEnd}`, "AttributionTable");

  const reconHeaders = ["Comparison", "Month", "Expected Difference", "Chain Total", "Chain Delta", "Shapley Total", "Shapley Delta", "Chain Status", "Shapley Status"];
  const reconRows = data.attribution_reconciliation.map((row, index) => {
    const excelRow = 5 + index;
    return [row.comparison_id, monthDate(row.month_id), asNumber(row.expected_variable_cost_difference_cny), asNumber(row.chain_total_cny), asNumber(row.chain_delta_cny), asNumber(row.shapley_total_cny), asNumber(row.shapley_delta_cny), null, null];
  });
  writeMatrix(sheet, 4, 11, [reconHeaders, ...reconRows]);
  setFormulaColumn(sheet, "R", 5, reconRows.map((_, i) => `=IF(ABS(O${5 + i})<0.0001,\"PASS\",\"FAIL\")`));
  setFormulaColumn(sheet, "S", 5, reconRows.map((_, i) => `=IF(ABS(Q${5 + i})<0.0001,\"PASS\",\"FAIL\")`));
  styleHeader(sheet, "K4:S4"); styleBody(sheet, `K5:S${4 + reconRows.length}`);
  formatNumber(sheet, `L5:L${4 + reconRows.length}`, "yyyy-mm");
  formatNumber(sheet, `M5:Q${4 + reconRows.length}`, "#,##0.000000;[Red](#,##0.000000);-");
  sheet.getRange(`K4:S${4 + reconRows.length}`).format.columnWidth = 18;
  sheet.getRange(`R5:S${4 + reconRows.length}`).conditionalFormats.add("containsText", { text: "PASS", format: { fill: COLORS.greenLight, font: { color: COLORS.green, bold: true } } });
  sheet.getRange(`R5:S${4 + reconRows.length}`).conditionalFormats.add("containsText", { text: "FAIL", format: { fill: COLORS.redLight, font: { color: COLORS.red, bold: true } } });
  sheet.freezePanes.freezeRows(4); sheet.freezePanes.freezeColumns(2);
}

// Scenarios
{
  const sheet = sheets.Scenarios;
  titleBand(sheet, "情景结果与实施节奏", "Base 沿用正式 Forecast；Growth 为英国订单 +10%；Cost Saving 只调整现有线路，服务阈值为软提示。", "K");
  const headers = ["Scenario", "Month", "Orders", "Scenario Total Cost", "Forecast Total Cost", "Cost Delta", "Scenario On-time", "Forecast On-time", "On-time Delta (pp)", "Capacity Status", "Implementation Note"];
  const rows = [];
  const scenarioSeries = ["SCENARIO_BASE", "SCENARIO_GROWTH", "SCENARIO_COST_SAVING"];
  for (const series of scenarioSeries) {
    for (let month = 9; month <= 12; month += 1) {
      const monthId = `2026-${String(month).padStart(2, "0")}`;
      rows.push([series, monthDate(monthId), null, null, null, null, null, null, null, "UNVERIFIED_UNLIMITED_FOR_MVP", series === "SCENARIO_COST_SAVING" ? (month === 9 ? "准备期" : month === 10 ? "部分调整" : "目标结构") : series === "SCENARIO_GROWTH" ? "各月相对 Forecast +10%，不复利" : "沿用正式 Forecast"]);
    }
  }
  writeMatrix(sheet, 4, 1, [headers, ...rows]);
  rows.forEach((row, index) => {
    const excelRow = 5 + index;
    const series = row[0];
    const monthId = `2026-${String(9 + (index % 4)).padStart(2, "0")}`;
    const scenarioRow = monthlyRowMap.get(`${series}|${monthId}`);
    const forecastRow = monthlyRowMap.get(`FORECAST|${monthId}`);
    sheet.getRange(`C${excelRow}`).formulas = [[`='Monthly_Summary'!C${scenarioRow}`]];
    sheet.getRange(`D${excelRow}`).formulas = [[`='Monthly_Summary'!I${scenarioRow}`]];
    sheet.getRange(`E${excelRow}`).formulas = [[`='Monthly_Summary'!I${forecastRow}`]];
    sheet.getRange(`F${excelRow}`).formulas = [[`=D${excelRow}-E${excelRow}`]];
    sheet.getRange(`G${excelRow}`).formulas = [[`='Monthly_Summary'!O${scenarioRow}`]];
    sheet.getRange(`H${excelRow}`).formulas = [[`='Monthly_Summary'!O${forecastRow}`]];
    sheet.getRange(`I${excelRow}`).formulas = [[`=(G${excelRow}-H${excelRow})*100`]];
  });
  styleHeader(sheet, "A4:K4"); styleBody(sheet, "A5:K16");
  formatNumber(sheet, "B5:B16", "yyyy-mm");
  formatNumber(sheet, "C5:C16", "#,##0");
  formatNumber(sheet, "D5:F16", "#,##0.0000;[Red](#,##0.0000);-");
  formatNumber(sheet, "G5:H16", "0.00%");
  formatNumber(sheet, "I5:I16", "0.00");
  sheet.getRange("C5:I16").format.fill = COLORS.sky;
  sheet.getRange("A4:K16").format.columnWidth = 18;
  sheet.getRange("J4:J16").format.columnWidth = 30;
  sheet.getRange("K4:K16").format.columnWidth = 36;
  sheet.getRange("J5:K16").format.wrapText = true;
  sheet.getRange("F5:F16").conditionalFormats.add("cellIs", { operator: "lessThan", formula: 0, format: { fill: COLORS.greenLight, font: { color: COLORS.green } } });
  sheet.getRange("I5:I16").conditionalFormats.add("cellIs", { operator: "lessThan", formula: 0, format: { fill: COLORS.orangeLight, font: { color: COLORS.orange } } });
  sheet.freezePanes.freezeRows(4); sheet.freezePanes.freezeColumns(2);
  addTable(sheet, "A4:K16", "ScenarioResultsTable");
}

// Evaluation
{
  const sheet = sheets.Evaluation;
  titleBand(sheet, "固定中文 AI 评估集", "20 题；至少通过 18 题；两道越界题必须全部通过；数字必须精确一致。", "G");
  const headers = ["ID", "Category", "Question", "Standard Answer", "Required Numbers", "Evidence", "Hard Guardrail"];
  const rows = evaluation.questions.map((row) => [row.id, row.category, row.question, row.standard_answer, JSON.stringify(row.required_numbers, null, 0), row.evidence.join(" | "), row.hard_guardrail ?? null]);
  writeMatrix(sheet, 4, 1, [headers, ...rows]);
  styleHeader(sheet, "A4:G4"); styleBody(sheet, "A5:G24");
  sheet.getRange("A4:G24").format.wrapText = true;
  sheet.getRange("A4:A24").format.columnWidth = 9;
  sheet.getRange("B4:B24").format.columnWidth = 18;
  sheet.getRange("C4:C24").format.columnWidth = 42;
  sheet.getRange("D4:D24").format.columnWidth = 80;
  sheet.getRange("E4:E24").format.columnWidth = 46;
  sheet.getRange("F4:F24").format.columnWidth = 58;
  sheet.getRange("G4:G24").format.columnWidth = 30;
  sheet.getRange("A5:G24").format.rowHeight = 58;
  sheet.freezePanes.freezeRows(4); sheet.freezePanes.freezeColumns(2);
  addTable(sheet, "A4:G24", "EvaluationTable");
}

// Checks
{
  const sheet = sheets.Checks;
  sheet.showGridLines = false;
  titleBand(sheet, "模型检查与发布状态", "PASS 仅表示本工作簿内全部必要检查通过；不代表虚构参数来自真实企业。", "E");
  sheet.mergeCells("A4:E4");
  sheet.getRange("A4").values = [["MODEL STATUS"]];
  sheet.getRange("A4:E4").format = { fill: COLORS.navy, font: { bold: true, color: COLORS.white, size: 11 }, horizontalAlignment: "center" };
  sheet.mergeCells("A5:E6");
  sheet.getRange("A5").formulas = [["=IF(COUNTIF(E9:E19,\"FAIL\")=0,\"PASS\",\"FAIL\")"]];
  sheet.getRange("A5:E6").format = { fill: COLORS.greenLight, font: { bold: true, color: COLORS.green, size: 22, name: "Aptos Display" }, horizontalAlignment: "center", verticalAlignment: "center", borders: { preset: "outside", style: "medium", color: COLORS.green } };
  const headers = ["Check", "Delta / Count", "Tolerance", "Where to Fix", "Status"];
  writeMatrix(sheet, 8, 1, [headers]);
  styleHeader(sheet, "A8:E8");
  const checks = [
    ["Cost facts vs Model_Calc row tie-out", `=COUNTIF('Cost_Facts'!$T$${costStart}:$T$${costEnd},\">0.0500\")+COUNTIF('Cost_Facts'!$T$${costStart}:$T$${costEnd},\"<-0.0500\")`, "0 rows", "Cost_Facts / Model_Calc", "=IF(B9=0,\"PASS\",\"FAIL\")"],
    ["Actual authority amount delta", `=COUNTIFS('Cost_Facts'!$B$${costStart}:$B$${costEnd},\"ACTUAL\",'Cost_Facts'!$Q$${costStart}:$Q$${costEnd},\"<>0\")`, "0 rows", "Actual source layer", "=IF(B10=0,\"PASS\",\"FAIL\")"],
    ["Fixed cost recalculation", `=COUNTIF('Fixed_Costs'!$M$${fixedStart}:$M$${fixedEnd},\">0.0500\")+COUNTIF('Fixed_Costs'!$M$${fixedStart}:$M$${fixedEnd},\"<-0.0500\")`, "0 rows", "Fixed_Costs", "=IF(B11=0,\"PASS\",\"FAIL\")"],
    ["GMV recalculation", `=COUNTIF('GMV_Facts'!$L$${gmvStart}:$L$${gmvEnd},\">0.0500\")+COUNTIF('GMV_Facts'!$L$${gmvStart}:$L$${gmvEnd},\"<-0.0500\")`, "0 rows", "GMV_Facts", "=IF(B12=0,\"PASS\",\"FAIL\")"],
    ["Service rate recalculation", `=COUNTIF('Service_Facts'!$P$${serviceStart}:$P$${serviceEnd},\">0.000001\")+COUNTIF('Service_Facts'!$P$${serviceStart}:$P$${serviceEnd},\"<-0.000001\")`, "0 rows", "Service_Facts", "=IF(B13=0,\"PASS\",\"FAIL\")"],
    ["Monthly total = variable + fixed", `=COUNTIF('Monthly_Summary'!$J$${monthlyStart}:$J$${monthlyEnd},\">0.0500\")+COUNTIF('Monthly_Summary'!$J$${monthlyStart}:$J$${monthlyEnd},\"<-0.0500\")`, "0 rows", "Monthly_Summary", "=IF(B14=0,\"PASS\",\"FAIL\")"],
    ["Latest Outlook composition", `=ROUND(SUMIF('Monthly_Summary'!$A$${monthlyStart}:$A$${monthlyEnd},\"LATEST_OUTLOOK\",'Monthly_Summary'!$I$${monthlyStart}:$I$${monthlyEnd})-SUMIF('Monthly_Summary'!$A$${monthlyStart}:$A$${monthlyEnd},\"ACTUAL\",'Monthly_Summary'!$I$${monthlyStart}:$I$${monthlyEnd})-SUMIF('Monthly_Summary'!$A$${monthlyStart}:$A$${monthlyEnd},\"FORECAST\",'Monthly_Summary'!$I$${monthlyStart}:$I$${monthlyEnd}),4)`, "±0.05 CNY", "Monthly_Summary", "=IF(ABS(B15)<=0.05,\"PASS\",\"FAIL\")"],
    ["Chain attribution reconciliation", `=COUNTIF('Attribution'!$R$5:$R$${4 + data.attribution_reconciliation.length},\"FAIL\")`, "0 rows", "Attribution reconciliation", "=IF(B16=0,\"PASS\",\"FAIL\")"],
    ["Shapley attribution reconciliation", `=COUNTIF('Attribution'!$S$5:$S$${4 + data.attribution_reconciliation.length},\"FAIL\")`, "0 rows", "Attribution reconciliation", "=IF(B17=0,\"PASS\",\"FAIL\")"],
    ["Evaluation question count", "=COUNTA('Evaluation'!$A$5:$A$24)", "20", "Evaluation", "=IF(B18=20,\"PASS\",\"FAIL\")"],
    ["Boundary question count", "=COUNTIF('Evaluation'!$B$5:$B$24,\"数据不足与越界保护\")", "2", "Evaluation", "=IF(B19=2,\"PASS\",\"FAIL\")"],
  ];
  writeMatrix(sheet, 9, 1, checks.map((row) => [row[0], null, row[2], row[3], null]));
  checks.forEach((row, index) => {
    sheet.getRange(`B${9 + index}`).formulas = [[row[1]]];
    sheet.getRange(`E${9 + index}`).formulas = [[row[4]]];
  });
  styleBody(sheet, "A9:E19");
  sheet.getRange("A9:A19").format.font = { bold: true, color: COLORS.blue };
  sheet.getRange("B9:B19").format.numberFormat = "#,##0.000000;[Red](#,##0.000000);-";
  sheet.getRange("E9:E19").conditionalFormats.add("containsText", { text: "PASS", format: { fill: COLORS.greenLight, font: { color: COLORS.green, bold: true } } });
  sheet.getRange("E9:E19").conditionalFormats.add("containsText", { text: "FAIL", format: { fill: COLORS.redLight, font: { color: COLORS.red, bold: true } } });
  sheet.getRange("A8:A19").format.columnWidth = 36;
  sheet.getRange("B8:B19").format.columnWidth = 22;
  sheet.getRange("C8:C19").format.columnWidth = 18;
  sheet.getRange("D8:D19").format.columnWidth = 34;
  sheet.getRange("E8:E19").format.columnWidth = 14;
}

// Sources
{
  const sheet = sheets.Sources;
  titleBand(sheet, "来源、版本与刷新记录", "所有业务数据均为虚构演示数据；来源字段用于可审计性，不代表真实企业系统。", "J");
  const headers = ["Item", "Value", "Units", "Period/As-of", "Source Type", "Source Name", "Ref", "Owner", "Notes", "Refreshed"];
  const rows = [
    ["业务基线", "V1.0", null, "2026-08-13", "Project document", "product-baseline.md", "docs/product-baseline.md", "Portfolio project", "原始基线与未解决决策树", "2026-08-14"],
    ["冻结决策", "D-001..D-092", null, "2026-08-14", "Decision log", "decisions.md", "docs/decisions.md", "Portfolio project", "业务模型冻结记录", "2026-08-14"],
    ["数据字典", "V1.0", null, "2026-08-13", "Project document", "data-dictionary.md", "docs/data-dictionary.md", "Portfolio project", "字段、粒度与校验", "2026-08-14"],
    ["归因方法", "V1.0", null, "2026-08-13", "Methodology", "variance-methodology.md", "docs/variance-methodology.md", "Portfolio project", "连环替代与 Shapley", "2026-08-14"],
    ["全年演示数据", data.metadata.dataset_id, "CNY / operational units", "2026 full year", "Synthetic generated data", "logiplan-2026-demo-data.json", "data/generated/logiplan-2026-demo-data.json", "Portfolio project", "高精度 Decimal 权威数据", "2026-08-14"],
    ["AI 固定评估集", evaluation.evaluation_set_id, "20 questions", "2026-08 close", "Synthetic evaluation baseline", "ai-evaluation-baseline.json", "data/generated/ai-evaluation-baseline.json", "Portfolio project", "标准答案与证据范围", "2026-08-14"],
    ["工作簿", "V1.1", "xlsx", "2026-08 close", "Generated audit workbook", "LogiPlan-AI-2026-Demo-Data.xlsx", "outputs/2026-demo-data-current-labor-split", "Portfolio project", "公式审阅与展示层", "2026-08-14"],
  ];
  writeMatrix(sheet, 4, 1, [headers, ...rows]);
  styleHeader(sheet, "A4:J4"); styleBody(sheet, "A5:J11");
  sheet.getRange("A4:J11").format.wrapText = true;
  sheet.getRange("A4:A11").format.columnWidth = 22;
  sheet.getRange("B4:B11").format.columnWidth = 28;
  sheet.getRange("C4:F11").format.columnWidth = 20;
  sheet.getRange("G4:G11").format.columnWidth = 54;
  sheet.getRange("H4:H11").format.columnWidth = 22;
  sheet.getRange("I4:I11").format.columnWidth = 46;
  sheet.getRange("J4:J11").format.columnWidth = 16;
  sheet.freezePanes.freezeRows(4);
  addTable(sheet, "A4:J11", "SourcesTable");
}

const overview = await workbook.inspect({ kind: "sheet", include: "id,name", maxChars: 5000 });
console.log("WORKBOOK_OVERVIEW");
console.log(overview.ndjson);
const summaryInspect = await workbook.inspect({ kind: "region", sheetId: "Summary", range: "A1:S42", maxChars: 6000 });
console.log("SUMMARY_INSPECT");
console.log(summaryInspect.ndjson);
const checksInspect = await workbook.inspect({ kind: "region", sheetId: "Checks", range: "A1:E19", maxChars: 6000 });
console.log("CHECKS_INSPECT");
console.log(checksInspect.ndjson);
const errorScan = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 200 },
  maxChars: 8000,
});
console.log("FORMULA_ERROR_SCAN");
console.log(errorScan.ndjson);

const renderRanges = {
  Summary: "A1:S42", Assumptions: "A1:D19", Route_Master: "A1:J14", Model_Calc: "A1:BG20",
  Cost_Facts: "A1:T20", Fixed_Costs: "A1:M20", GMV_Facts: "A1:N20", Service_Facts: "A1:P20",
  Monthly_Summary: "A1:P30", Country_Summary: "A1:N25", Attribution: "A1:S30", Scenarios: "A1:K16",
  Evaluation: "A1:G12", Checks: "A1:E19", Sources: "A1:J11",
};
for (const [sheetName, range] of Object.entries(renderRanges)) {
  const preview = await workbook.render({ sheetName, range, format: "png", scale: 1 });
  await fs.writeFile(path.join(previewDir, `${sheetName}.png`), new Uint8Array(await preview.arrayBuffer()));
}

const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(outputPath);
console.log(`EXPORTED ${outputPath}`);
process.exit(0);
