/**
 * v1.53.0 斷言測試：結果分析每組曲線圖及各選項得分（函式驗證＋靜態守衛，無需 emulator）。
 *
 * 驗證重點（計分口徑不動）：
 * 1. 分組曲線數列＝矩陣分組子列：人次模式 sectionPassRateOf 逐欄
 *    ＝ personScoringBreakdownRows 該欄分組列；單位模式
 *    unitScoringBreakdownRows 單欄分組列（B 法）。
 * 2. 分組選項明細＝整表按分組題目過濾：resolveDrillSection 題目 id
 *    過濾後的 optionDetailRows，與只傳該組題目算出的列完全一致。
 * 3. 靜態守衛：三頁籤皆接線分組圖示；groupScoring 閘門未動；
 *    TrendChart 未改；版號 1.53.0。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const ROOT = "/tmp/qaweb-153";
const resultsPage = readFileSync(`${ROOT}/src/features/ResultsPage.tsx`, "utf8");
const stylesCss = readFileSync(`${ROOT}/src/styles.css`, "utf8");
const versionTs = readFileSync(`${ROOT}/src/version.ts`, "utf8");
const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));

let pass = 0;
function check(name, fn) {
  fn();
  pass++;
  console.log(`ok - ${name}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const require = createRequire(`${ROOT}/package.json`);
const esbuild = require("esbuild");
writeFileSync(
  "/tmp/v1-53-0-test.ts",
  `export { sectionPassRateOf, personScoringBreakdownRows, unitScoringBreakdownRows, optionDetailRows, resolveDrillSection } from "${ROOT}/src/lib/analysisRates";`,
);
await esbuild.build({
  entryPoints: ["/tmp/v1-53-0-test.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v1-53-0-test.cjs",
  logLevel: "silent",
});
const lib = require("/tmp/v1-53-0-test.cjs");

// ---- 假資料：q1,q2＝分組A；q3＝分組B；閾值 80 ----
const questions = [
  { id: "q1", itemText: "題一", optionSet: "yesNo", guidance: "", commonErrors: [], groupId: "gA", groupName: "分組A", order: 1 },
  { id: "q2", itemText: "題二", optionSet: "yesNo", guidance: "", commonErrors: [], groupId: "gA", groupName: "分組A", order: 2 },
  { id: "q3", itemText: "題三", optionSet: "yesNo", guidance: "", commonErrors: [], groupId: "gB", groupName: "分組B", order: 3 },
];
const ans = (qid, label) => ({
  questionId: qid,
  itemText: `題${qid.slice(1)}`,
  optionLabel: label,
  score: label === "是" ? 100 : 0,
  excluded: label === "不適用",
});
const rec = (person, unit, year, month, map, th) => {
  const answers = Object.entries(map).map(([qid, label]) => ans(qid, label));
  const valid = answers.filter((a) => !a.excluded);
  const yes = valid.filter((a) => a.optionLabel === "是").length;
  return {
    indicatorId: "ind1",
    unitId: unit,
    year,
    month,
    rate: valid.length ? Math.round((yes / valid.length) * 1000) / 10 : null,
    ...(th !== undefined ? { thresholdAtSchedule: th } : {}),
    answers,
    personEmpNo: person,
    personName: person,
  };
};
// 2026-08：U1 p1(A過B過) p2(A50 B過) p3(A0 B過)；U2 p4(全過) p5(A50@閾值60 B0)
const col1 = [
  rec("p1", "U1", 2026, 8, { q1: "是", q2: "是", q3: "是" }),
  rec("p2", "U1", 2026, 8, { q1: "是", q2: "否", q3: "是" }),
  rec("p3", "U1", 2026, 8, { q1: "否", q2: "否", q3: "是" }),
  rec("p4", "U2", 2026, 8, { q1: "是", q2: "是", q3: "是" }),
  rec("p5", "U2", 2026, 8, { q1: "是", q2: "否", q3: "否" }, 60),
];
// 2026-09：U1 p1(全過)；U2 p4(A50 B0)
const col2 = [
  rec("p1", "U1", 2026, 9, { q1: "是", q2: "是", q3: "是" }),
  rec("p4", "U2", 2026, 9, { q1: "否", q2: "是", q3: "否" }),
];
const all = [...col1, ...col2];
const col1Def = { months: [{ year: 2026, month: 8 }] };
const col2Def = { months: [{ year: 2026, month: 9 }] };

// ---- 1. 人次模式：分組曲線口徑＝矩陣分組子列 ----
check("人次模式 8月 分組A 曲線值＝矩陣子列 (2/5, 40%)", () => {
  const curve = lib.sectionPassRateOf(col1, ["q1", "q2"], "group", 80);
  assert(eq(curve, { pass: 2, total: 5, rate: 40 }), JSON.stringify(curve));
  const row = lib.personScoringBreakdownRows(col1, questions, 80).find((r) => r.key === "group-gA");
  assert(eq({ pass: row.yes, total: row.valid, rate: row.rate }, curve), JSON.stringify(row));
});
check("人次模式 8月 分組B 曲線值＝矩陣子列 (4/5, 80%)", () => {
  const curve = lib.sectionPassRateOf(col1, ["q3"], "group", 80);
  assert(eq(curve, { pass: 4, total: 5, rate: 80 }), JSON.stringify(curve));
  const row = lib.personScoringBreakdownRows(col1, questions, 80).find((r) => r.key === "group-gB");
  assert(eq({ pass: row.yes, total: row.valid, rate: row.rate }, curve), JSON.stringify(row));
});
check("人次模式 9月 分組A／B 皆 (1/2, 50%)，與矩陣子列一致", () => {
  for (const key of ["group-gA", "group-gB"]) {
    const ids = key === "group-gA" ? ["q1", "q2"] : ["q3"];
    const curve = lib.sectionPassRateOf(col2, ids, "group", 80);
    assert(eq(curve, { pass: 1, total: 2, rate: 50 }), `${key} ${JSON.stringify(curve)}`);
    const row = lib.personScoringBreakdownRows(col2, questions, 80).find((r) => r.key === key);
    assert(eq({ pass: row.yes, total: row.valid, rate: row.rate }, curve), JSON.stringify(row));
  }
});
check("逐筆閾值快照優先：p5 分組A 50% 在閾值60下仍不達標", () => {
  // p5 若用指標閾值80同樣不達標；改設快照40則應達標，驗證 thresholdOf 有讀快照
  const p5low = rec("p5", "U2", 2026, 8, { q1: "是", q2: "否", q3: "否" }, 40);
  const curve = lib.sectionPassRateOf([p5low], ["q1", "q2"], "group", 80);
  assert(eq(curve, { pass: 1, total: 1, rate: 100 }), JSON.stringify(curve));
});

// ---- 2. 單位模式 B 法：單欄分組列 ----
check("單位模式 8月 分組A (0/2, 0%)：兩單位皆未達閾值", () => {
  const row = lib.unitScoringBreakdownRows(col1, questions, [col1Def], 80).find((r) => r.key === "group-gA");
  assert(eq({ pass: row.yes, total: row.valid, rate: row.rate }, { pass: 0, total: 2, rate: 0 }), JSON.stringify(row));
});
check("單位模式 8月 分組B (1/2, 50%)：U1 3/3 達標、U2 1/2 未達標", () => {
  const row = lib.unitScoringBreakdownRows(col1, questions, [col1Def], 80).find((r) => r.key === "group-gB");
  assert(eq({ pass: row.yes, total: row.valid, rate: row.rate }, { pass: 1, total: 2, rate: 50 }), JSON.stringify(row));
});
check("單位模式 9月 分組A／B 皆 (1/2, 50%)", () => {
  for (const key of ["group-gA", "group-gB"]) {
    const row = lib.unitScoringBreakdownRows(col2, questions, [col2Def], 80).find((r) => r.key === key);
    assert(eq({ pass: row.yes, total: row.valid, rate: row.rate }, { pass: 1, total: 2, rate: 50 }), `${key} ${JSON.stringify(row)}`);
  }
});

// ---- 3. 分組選項明細：只列該組題目、同一口徑 ----
check("resolveDrillSection(group-gA) 回 q1,q2、kind group", () => {
  const s = lib.resolveDrillSection(questions, "group-gA");
  assert(eq(s, { ids: ["q1", "q2"], kind: "group" }), JSON.stringify(s));
});
check("分組A 明細只列 q1,q2，數值＝只傳該組題目算出的列", () => {
  const full = lib.optionDetailRows(all, questions);
  const section = lib.resolveDrillSection(questions, "group-gA");
  const filtered = full.filter((r) => new Set(section.ids).has(r.questionId));
  const direct = lib.optionDetailRows(all, questions.filter((q) => section.ids.includes(q.id)));
  assert(eq(filtered, direct), JSON.stringify(filtered));
  assert(eq(filtered.map((r) => r.questionId), ["q1", "q2"]), JSON.stringify(filtered.map((r) => r.questionId)));
});
check("分組A q1：是5／否2／得分率71.4；q2：是4／否3／得分率57.1", () => {
  const full = lib.optionDetailRows(all, questions);
  const q1 = full.find((r) => r.questionId === "q1");
  const q2 = full.find((r) => r.questionId === "q2");
  assert(q1.yes === 5 && q1.no === 2 && q1.scoreRate === 71.4, JSON.stringify(q1));
  assert(q2.yes === 4 && q2.no === 3 && q2.scoreRate === 57.1, JSON.stringify(q2));
});
check("分組B 明細只列 q3", () => {
  const full = lib.optionDetailRows(all, questions);
  const section = lib.resolveDrillSection(questions, "group-gB");
  const filtered = full.filter((r) => new Set(section.ids).has(r.questionId));
  assert(eq(filtered.map((r) => r.questionId), ["q3"]), JSON.stringify(filtered.map((r) => r.questionId)));
});

// ---- 4. 靜態守衛：接線與閘門 ----
check("ChartModalData／DocModalData 帶 sectionKey／sectionLabel", () => {
  assert(resultsPage.includes("sectionKey?: string;"), "缺 sectionKey");
  assert(resultsPage.includes("sectionLabel?: string;"), "缺 sectionLabel");
});
check("sectionChartSeries／sectionCellValue／sectionOptionRows 存在且同一口徑", () => {
  assert(resultsPage.includes("function sectionChartSeries("), "缺 sectionChartSeries");
  assert(resultsPage.includes("function sectionCellValue("), "缺 sectionCellValue");
  assert(resultsPage.includes("function sectionOptionRows("), "缺 sectionOptionRows");
  assert(resultsPage.includes("sectionPassRateOf(periodRecords, section.ids, section.kind, indicator.threshold)"), "人次口徑未用 sectionPassRateOf");
  assert(resultsPage.includes("unitScoringBreakdownRows(periodRecords, indicator.questions, [column], indicator.threshold)"), "單位口徑未用 unitScoringBreakdownRows 單欄");
});
check("組別頁籤分組子列接 openChart／openDoc（帶 section）", () => {
  assert(resultsPage.includes("onDetailChart={(id, detailKey, detailLabel) =>\n                  openChart(id, undefined, groupUnit, \"全部單位\", {"), "組別曲線未接");
  assert(resultsPage.includes("onDetailDoc={(id, detailKey, detailLabel) =>\n                  openDoc(id, undefined, \"全部單位\", groupUnit, {"), "組別文件未接");
});
check("單位頁籤分組子列切換下方展開面板（帶 sectionKey）", () => {
  assert(resultsPage.includes("sectionKey: detailKey,"), "單位面板未帶 sectionKey");
  assert(resultsPage.includes("sectionChartSeries("), "單位面板未用 sectionChartSeries");
  assert(resultsPage.includes("sectionOptionRows("), "單位面板未用 sectionOptionRows");
});
check("指標頁籤分組明細列接 openChart／openDoc（帶 row.key）", () => {
  assert(resultsPage.includes("openChart(selIndicator, undefined, indUnit,"), "指標曲線未接");
  assert(resultsPage.includes("openDoc(selIndicator, undefined,"), "指標文件未接");
});
check("曲線彈窗點下探帶 sectionKey（分組下探）", () => {
  assert(resultsPage.includes("cm.sectionKey\n                    ? { sectionKey: cm.sectionKey }"), "彈窗下探未帶 sectionKey");
});
check("groupScoring 閘門未動：矩陣與指標摘要皆只在開啟時顯示分組", () => {
  assert(resultsPage.includes("if (!indicator.groupScoring) return [];"), "矩陣閘門消失");
  assert(resultsPage.includes("scoringRows: !indSel.groupScoring"), "指標摘要閘門消失");
});
check("歷史分組不顯示文件圖示（無現行題目）", () => {
  assert(resultsPage.includes('!detail.key.startsWith("historical-")'), "矩陣歷史列未擋文件圖示");
  assert(resultsPage.includes('!row.key.startsWith("historical-")'), "指標歷史列未擋文件圖示");
});
check("TrendChart 未改", () => {
  const changed = execSync(`git -C ${ROOT} diff --name-only`, { encoding: "utf8" });
  assert(!changed.split("\n").includes("src/components/TrendChart.tsx"), "TrendChart 被改動");
});
check("樣式：分組子列 flex 排版、指標分組列圖示靠右", () => {
  assert(stylesCss.includes(".analysis-matrix-subrow {\n  display: flex;"), "子列未改 flex");
  assert(stylesCss.includes(".score-breakdown-row .analysis-indicator-actions {\n  margin-left: auto;"), "指標列圖示未靠右");
});
check("版號 1.53.0（version.ts＝package.json，BUILD_DATE 2026-11-12）", () => {
  assert(versionTs.includes('VERSION = "1.53.0"'), "version.ts 非 1.53.0");
  assert(pkg.version === "1.53.0", `package.json 為 ${pkg.version}`);
  assert(versionTs.includes('BUILD_DATE = "2026-11-12"'), "BUILD_DATE 非 2026-11-12");
});

console.log(`\n${pass} checks passed`);
