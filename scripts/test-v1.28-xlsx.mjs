/**
 * v1.28 階段 5 斷言：xlsx 改動態 import（A2）＋ B4 剩餘去重收尾。
 * 執行：node scripts/test-v1.28-xlsx.mjs（專案根目錄，需先跑過 vite build）
 */
import { build } from "esbuild";
import { createRequire } from "module";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { resolve } from "path";
const ROOT = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
let f = 0;
const a = (n, c) => { if (!c) { f++; console.error("FAIL:", n); } };
const src = (p) => readFileSync(resolve(ROOT, p), "utf8");

// ---------- A2-1：原始碼層面：無靜態 xlsx import，只有動態 import ----------
const sheet = src("src/lib/sheetFile.ts");
a("原始碼：無靜態 import xlsx", !/^import\s+.*\sfrom\s+["']xlsx["']/m.test(sheet) && !/from ["']xlsx["']/.test(sheet));
a("原始碼：有動態 import(\"xlsx\")", sheet.includes('import("xlsx")'));
a("原始碼：動態載入有 Promise 快取", /xlsxPromise/.test(sheet));
a("原始碼：載入失敗可重試（清除快取）", /xlsxPromise = null/.test(sheet));

// ---------- A2-2：產物層面：首屏 JS 不含 xlsx，獨立 chunk 存在 ----------
const assets = readdirSync(resolve(ROOT, "dist/assets"));
const mainJs = assets.find((n) => /^index-.*\.js$/.test(n));
const xlsxChunk = assets.find((n) => /^xlsx-.*\.js$/.test(n));
a("產物：主 chunk 存在", !!mainJs);
a("產物：xlsx 獨立 chunk 存在", !!xlsxChunk);
const mainSize = mainJs ? statSync(resolve(ROOT, "dist/assets", mainJs)).size : Infinity;
const xlsxSize = xlsxChunk ? statSync(resolve(ROOT, "dist/assets", xlsxChunk)).size : 0;
a(`產物：首屏 JS ${mainSize} < 1,200,000（改前 1,493,698）`, mainSize < 1200000);
a(`產物：xlsx chunk 約 430KB（${xlsxSize}）`, xlsxSize > 400000 && xlsxSize < 460000);
const mainText = mainJs ? readFileSync(resolve(ROOT, "dist/assets", mainJs), "utf8") : "";
a("產物：首屏 JS 不含 SheetJS 標記", !mainText.includes("SheetJS"));
const xlsxText = xlsxChunk ? readFileSync(resolve(ROOT, "dist/assets", xlsxChunk), "utf8") : "";
a("產物：xlsx chunk 含 SheetJS 實作", xlsxText.includes("SheetJS"));
const indexHtml = readFileSync(resolve(ROOT, "dist/index.html"), "utf8");
a("產物：index.html 不直接引用 xlsx chunk（懶載入）", !indexHtml.includes("xlsx-"));
a("產物：index.html 引用的主 JS 存在", [...indexHtml.matchAll(/\/assets\/(index-[^"']+\.js)/g)].every((m) => existsSync(resolve(ROOT, "dist/assets", m[1]))));

// ---------- A2-3：功能：動態載入路徑真的能讀 .xlsx 與 .csv ----------
// 用 esbuild 把 sheetFile 打包成 node 可跑的 CJS（動態 import 轉為 require）
import { writeFileSync } from "fs";
writeFileSync("/tmp/t128x.ts", `export { readSheetFile, downloadTemplate, downloadCsvFile } from "${ROOT}/src/lib/sheetFile";`);
await build({ entryPoints: ["/tmp/t128x.ts"], bundle: true, format: "cjs", platform: "node", outfile: "/tmp/t128x.cjs", logLevel: "silent" });
const L = require("/tmp/t128x.cjs");
const XLSX = require("xlsx");
// 現場造一個 .xlsx 檔（標題列＋2 筆），走 readSheetFile 動態載入路徑
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["姓名", "職編"], ["王小明", "A001"], ["陳大華", "A002"]]), "工作表1");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const rows = await L.readSheetFile(new File([buf], "test.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  a("功能：動態載入讀 .xlsx 標題＋2 筆", JSON.stringify(rows) === JSON.stringify([["姓名", "職編"], ["王小明", "A001"], ["陳大華", "A002"]]));
}
// CSV 路徑不經 xlsx，仍正常
{
  const rows = await L.readSheetFile(new File(["a,b\n1,2\n"], "test.csv", { type: "text/csv" }));
  a("功能：CSV 路徑不受影響", JSON.stringify(rows) === JSON.stringify([["a", "b"], ["1", "2"]]));
}
// downloadTemplate 走動態載入寫出 .xlsx（node 下 XLSX.writeFile 寫檔；跑完清除）
{
  const cwd = process.cwd();
  process.chdir("/tmp");
  try {
    const fmt = await L.downloadTemplate([["欄位1", "欄位2"], ["x", "y"]], "範本", "t128x_範本");
    a("功能：downloadTemplate 回傳 xlsx", fmt === "xlsx");
    a("功能：downloadTemplate 寫出 .xlsx 檔", existsSync("/tmp/t128x_範本.xlsx"));
  } finally {
    rmSync("/tmp/t128x_範本.xlsx", { force: true });
    process.chdir(cwd);
  }
}

// ---------- B4 收尾：四項原清單＋唯一剩餘項皆走 refCache ----------
const groups = src("src/features/GroupsPage.tsx");
a("B4：GroupsPage users 三處全走快取", (groups.match(/getCachedRefCollection\("users"/g) || []).length >= 3);
const admin = src("src/features/AdminPage.tsx");
a("B4：AdminPage systemParams/config 三處全走同一快取鍵", (admin.match(/getCachedRef\(SYSTEM_CONFIG_KEY/g) || []).length >= 3);
const results = src("src/features/ResultsPage.tsx");
a("B4：ResultsPage 匯入頁籤 groups/units/users 走快取", results.includes('getCachedRefCollection("groups"') && results.includes('getCachedRefCollection("units"') && results.includes('getCachedRefCollection("users"'));
const overview = src("src/features/ReviewOverviewPage.tsx");
const execute = src("src/features/ReviewExecutePage.tsx");
a("B4：ReviewOverviewPage users 查姓名走快取", overview.includes('getCachedRefCollection("users"'));
a("B4：ReviewExecutePage users 查姓名走快取", execute.includes('getCachedRefCollection("users"'));
const dash = src("src/features/DashboardPage.tsx");
a("B4：DashboardPage systemParams/config 改走共用快取（本階段唯一修補）", dash.includes("getCachedRef(SYSTEM_CONFIG_KEY"));
a("B4：DashboardPage 不再直接 getDoc 讀 config", !/await getDoc\(\s*doc\(getFirebaseDb\(\), "systemParams", "config"\)/.test(dash));

// ---------- B4：三頁匯入皆有載入中狀態＋範本失敗提示 ----------
a("載入狀態：GroupsPage 讀檔有 readingFile", groups.includes("readingFile") && groups.includes("讀取檔案中…"));
const indicators = src("src/features/IndicatorsPage.tsx");
a("載入狀態：IndicatorsPage 匯入有 importing", indicators.includes("setImporting(true)") && indicators.includes("讀取檔案中…"));
a("載入狀態：ResultsPage 匯入本就有 busy", results.includes("setBusy(true)"));
a("失敗提示：三頁範本退回 CSV 時皆有 onAction 提示", groups.includes("已改下載 CSV 範例檔") && indicators.includes("已改下載 CSV 範本") && results.includes("已改下載 CSV 範本"));

if (f > 0) { console.error(`\n${f} 項失敗`); process.exit(1); }
console.log("test-v1.28-xlsx：全部通過");
