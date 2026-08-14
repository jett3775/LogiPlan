import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const workspace = "C:\\Users\\Jett\\Documents\\LogiAI";
const sourcePath = path.join(workspace, "outputs", "2026-demo-data-current-labor-split", "LogiPlan-AI-2026-Demo-Data.xlsx");
const workDir = path.join(workspace, ".tmp", "workbook-extract-current-labor-split");
const previewDir = path.join(workDir, "previews");
const extractPath = path.join(workDir, "workbook-extract.json");

await fs.mkdir(previewDir, { recursive: true });
const input = await FileBlob.load(sourcePath);
const workbook = await SpreadsheetFile.importXlsx(input);

const overview = await workbook.inspect({
  kind: "workbook,sheet,table,drawing",
  maxChars: 12000,
  tableMaxRows: 3,
  tableMaxCols: 5,
  tableMaxCellChars: 80,
});
console.log("OVERVIEW");
console.log(overview.ndjson);

const formulaErrors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  maxChars: 10000,
});
console.log("FORMULA_ERRORS");
console.log(formulaErrors.ndjson);

const output = {
  source_path: sourcePath,
  extracted_at: "2026-08-14",
  sheets: {},
};

const renderRanges = {
  Summary: "A1:S42",
  Assumptions: "A1:D22",
  Route_Master: "A1:J20",
  Model_Calc: "A1:BG22",
  Cost_Facts: "A1:T22",
  Fixed_Costs: "A1:M24",
  GMV_Facts: "A1:N22",
  Service_Facts: "A1:P22",
  Monthly_Summary: "A1:P32",
  Country_Summary: "A1:N28",
  Attribution: "A1:S32",
  Scenarios: "A1:K20",
  Evaluation: "A1:G14",
  Checks: "A1:E24",
  Sources: "A1:J14",
};

for (const name of Object.keys(renderRanges)) {
  const sheet = workbook.worksheets.getItem(name);
  const used = sheet.getUsedRange();
  output.sheets[name] = {
    address: used.address,
    values: used.values,
    formulas: used.formulas,
    display_formulas: used.displayFormulas,
  };
  const preview = await workbook.render({ sheetName: name, range: renderRanges[name], format: "png", scale: 1 });
  await fs.writeFile(path.join(previewDir, `${name}.png`), new Uint8Array(await preview.arrayBuffer()));
}

await fs.writeFile(extractPath, JSON.stringify(output, null, 2), "utf8");

const summary = await workbook.inspect({ kind: "region", sheetId: "Summary", range: "A1:S42", maxChars: 7000 });
const fixed = await workbook.inspect({ kind: "region", sheetId: "Fixed_Costs", range: "A1:M30", maxChars: 7000 });
const checks = await workbook.inspect({ kind: "region", sheetId: "Checks", range: "A1:E24", maxChars: 7000 });
console.log("SUMMARY");
console.log(summary.ndjson);
console.log("FIXED_COSTS");
console.log(fixed.ndjson);
console.log("CHECKS");
console.log(checks.ndjson);
console.log(`EXTRACTED ${extractPath}`);
process.exit(0);
