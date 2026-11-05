/**
 * v1.13.0 測試：用 esbuild 把純函式 lib 打包後在 node 跑斷言。
 * 涵蓋：平均正確率、RAG 燈號、月趨勢聚合、資料範圍過濾、
 *       單位列（完成/應審、達標）、指標達標統計＋靜態檢查（ResultsPage 接線）。
 * 執行：node scripts/test-v1.13.mjs
 */
import { buildSync } from "esbuild";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

const cacheBase = join("node_modules", ".cache", "qatest");
if (!existsSync(cacheBase)) mkdirSync(cacheBase, { recursive: true });
const dir = mkdtempSync(join(cacheBase, "run-"));
void tmpdir;
for (const [src, out] of [
  ["src/lib/resultAnalysis.ts", "ra.mjs"],
  ["src/lib/reviewProgress.ts", "rp.mjs"],
]) {
  buildSync({
    entryPoints: [src],
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["firebase/firestore"],
    outfile: join(dir, out),
    logLevel: "silent",
  });
}
const ra = await import(pathToFileURL(join(dir, "ra.mjs")).href);
const rp = await import(pathToFileURL(join(dir, "rp.mjs")).href);

let pass = 0;
const fails = [];
function t(name, cond) {
  if (cond) pass++;
  else fails.push(name);
}

/* ---- 平均正確率 ---- */
t("avg 80,90 → 85", ra.avgRateOf([80, 90]) === 85);
t("avg 忽略 null", ra.avgRateOf([80, null, 90]) === 85);
t("avg 全 null → null", ra.avgRateOf([null, null]) === null);
t("avg 空陣列 → null", ra.avgRateOf([]) === null);
t("avg 四捨五入到小數1位", ra.avgRateOf([83, 83, 84]) === 83.3);

/* ---- RAG 燈號 ---- */
t("達標→green", ra.ragStatus(85, 80) === "green");
t("等於閾值→green", ra.ragStatus(80, 80) === "green");
t("未達標→red", ra.ragStatus(79.9, 80) === "red");
t("無資料→gray", ra.ragStatus(null, 80) === "gray");
t("無閾值(0)→gray 不判燈", ra.ragStatus(95, 0) === "gray");

/* ---- 月趨勢 ---- */
{
  const recs = [
    { taskId: "t1", indicatorId: "i1", unitId: "9A", year: 2026, month: 3, rate: 80 },
    { taskId: "t1", indicatorId: "i1", unitId: "9A", year: 2026, month: 3, rate: 90 },
    { taskId: "t2", indicatorId: "i1", unitId: "9B", year: 2026, month: 1, rate: 70 },
    { taskId: "t3", indicatorId: "i2", unitId: "9A", year: 2026, month: 1, rate: 100 },
    { taskId: "t4", indicatorId: "i1", unitId: "9C", year: 2026, month: 2, rate: null },
  ];
  const tr = ra.monthlyTrend(recs, "i1");
  t("趨勢只取該指標", tr.length === 2);
  t("趨勢依月份排序", tr[0].month === 1 && tr[1].month === 3);
  t("趨勢1月平均 70", tr[0].rate === 70);
  t("趨勢3月平均 85", tr[1].rate === 85);
  t("趨勢排除全null月份", !tr.some((x) => x.month === 2));
}

/* ---- 資料範圍過濾 ---- */
{
  const tasks = [
    { id: "t1", indicatorId: "i1", unitId: "9A", reviewerId: "s1", year: 2026, month: 11, caseCount: 3 },
    { id: "t2", indicatorId: "i1", unitId: "9B", reviewerId: "s2", year: 2026, month: 11, caseCount: 3 },
  ];
  const recs = [
    { taskId: "t1", indicatorId: "i1", unitId: "9A", year: 2026, month: 11, rate: 80 },
    { taskId: "t2", indicatorId: "i1", unitId: "9B", year: 2026, month: 11, rate: 90 },
    { taskId: "tx", indicatorId: "i1", unitId: "9Z", year: 2026, month: 11, rate: 100 },
  ];
  const a = ra.filterByScope(tasks, recs, { kind: "admin" });
  t("admin 看全部任務", a.tasks.length === 2);
  t("admin 看全部紀錄", a.records.length === 3);
  const r = ra.filterByScope(tasks, recs, { kind: "reviewer", staffId: "s1" });
  t("審查員只看自己任務", r.tasks.length === 1 && r.tasks[0].id === "t1");
  t("審查員紀錄經 taskId 歸屬", r.records.length === 1 && r.records[0].taskId === "t1");
  const s = ra.filterByScope(tasks, recs, { kind: "staff", unitCode: "9B" });
  t("一般人員只看自己單位", s.tasks.length === 1 && s.tasks[0].unitId === "9B");
  t("一般人員紀錄只看自己單位", s.records.length === 1 && s.records[0].unitId === "9B");
}

/* ---- 單位列 ---- */
{
  const tasks = [
    { id: "t1", indicatorId: "i1", unitId: "9A", reviewerId: "s1", year: 2026, month: 11, caseCount: 3 },
    { id: "t2", indicatorId: "i1", unitId: "9B", reviewerId: "s1", year: 2026, month: 11, caseCount: 3 },
    { id: "t3", indicatorId: "i1", unitId: "9C", reviewerId: "s1", year: 2026, month: 11, caseCount: null },
  ];
  const recs = [
    { taskId: "t1", indicatorId: "i1", unitId: "9A", year: 2026, month: 11, rate: 80 },
    { taskId: "t2", indicatorId: "i1", unitId: "9B", year: 2026, month: 11, rate: 90 },
    { taskId: "t2", indicatorId: "i1", unitId: "9B", year: 2026, month: 11, rate: 95 },
    { taskId: "t2", indicatorId: "i1", unitId: "9B", year: 2026, month: 11, rate: 100 },
  ];
  const rows = ra.unitMonthRows(tasks, recs, "i1", 2026, 11, 80);
  t("單位列依代號排序", rows.map((r) => r.unitId).join(",") === "9A,9B,9C");
  const r9a = rows.find((r) => r.unitId === "9A");
  t("9A 完成1/3 未完成", r9a.doneCount === 1 && r9a.required === 3 && r9a.complete === false);
  t("9A 平均80 達標green", r9a.avgRate === 80 && r9a.rag === "green");
  const r9b = rows.find((r) => r.unitId === "9B");
  t("9B 完成3/3 完成", r9b.doneCount === 3 && r9b.complete === true);
  t("9B 平均95 達標", r9b.avgRate === 95 && r9b.rag === "green");
  const r9c = rows.find((r) => r.unitId === "9C");
  t("9C caseCount null 視為應審1件", r9c.required === 1);
  t("9C 無紀錄 avg null", r9c.avgRate === null && r9c.rag === "gray");
  t("9C 有查看 taskId", r9c.taskId === "t3");
  const rowsNoTh = ra.unitMonthRows(tasks, recs, "i1", 2026, 11, 0);
  t("無閾值只顯示正確率不判燈", rowsNoTh.find((r) => r.unitId === "9B").rag === "gray");
}

/* ---- 指標達標統計 ---- */
{
  const tasks = [
    { id: "t1", indicatorId: "i1", unitId: "9A", reviewerId: "s1", year: 2026, month: 11, caseCount: 2 },
    { id: "t2", indicatorId: "i1", unitId: "9B", reviewerId: "s1", year: 2026, month: 11, caseCount: 2 },
    { id: "t3", indicatorId: "i2", unitId: "9A", reviewerId: "s1", year: 2026, month: 11, caseCount: 1 },
  ];
  const recs = [
    { taskId: "t1", indicatorId: "i1", unitId: "9A", year: 2026, month: 11, rate: 85 },
    { taskId: "t1", indicatorId: "i1", unitId: "9A", year: 2026, month: 11, rate: 85 },
    { taskId: "t2", indicatorId: "i1", unitId: "9B", year: 2026, month: 11, rate: 70 },
    { taskId: "t3", indicatorId: "i2", unitId: "9A", year: 2026, month: 11, rate: 90 },
  ];
  const th = new Map([["i1", 80], ["i2", 0]]);
  const stats = ra.indicatorMonthStats(tasks, recs, 2026, 11, th);
  t("統計含兩個指標", stats.length === 2);
  const s1 = stats.find((s) => s.indicatorId === "i1");
  t("i1 應審2單位", s1.totalUnits === 2);
  t("i1 已完成1單位(9A 2/2；9B 1/2)", s1.doneUnits === 1);
  t("i1 達標1單位", s1.passUnits === 1);
  t("i1 達標率100%", s1.passRate === 100);
  t("i1 全數達標green", s1.rag === "green");
  const s2 = stats.find((s) => s.indicatorId === "i2");
  t("i2 無閾值不計達標率、燈號灰", s2.passUnits === 0 && s2.passRate === null && s2.rag === "gray");
}

/* ---- 靜態檢查：頁面接線 ---- */
{
  const page = readFileSync("src/features/ResultsPage.tsx", "utf8");
  t("ResultsPage 用 resultQuery gating", page.includes('can("resultQuery")'));
  t(
    "ResultsPage 有期間篩選（v1.25.0）",
    page.includes("startYear") &&
      page.includes("yearCount") &&
      page.includes("expandAnalysisColumns"),
  );
  t("ResultsPage 渲染 TrendChart", page.includes("<TrendChart"));
  t(
    "ResultsPage 有曲線／明細 modal（v1.25.0）",
    page.includes("chartModal") && page.includes("docModal"),
  );
  t("ResultsPage 矩陣橫向捲動（v1.25.0）", page.includes("analysis-table-wrap"));
  const css = readFileSync("src/styles.css", "utf8");
  t("rag-gray 樣式存在", css.includes(".rag-badge.rag-gray"));
  t("results-page 手機版 CSS 存在", css.includes(".results-page .task-cards"));
  const chart = readFileSync("src/components/TrendChart.tsx", "utf8");
  t("TrendChart 支援 labels", chart.includes("labels"));
}

/* ---- reviewProgress 沿用 ---- */
t("requiredCases 沿用", rp.requiredCases(null) === 1 && rp.requiredCases(3) === 3);

console.log(`pass: ${pass}, fail: ${fails.length}`);
if (fails.length > 0) {
  console.log("FAILED:");
  for (const f of fails) console.log(" -", f);
  process.exit(1);
}
