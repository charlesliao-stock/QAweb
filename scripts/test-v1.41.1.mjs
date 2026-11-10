/**
 * v1.41.1 斷言測試：查詢畫面顯示補充說明（審查員備註未通過原因）。
 *
 * 背景：補充說明（ReviewAnswer.note）早已在審查執行頁逐題輸入並存進
 * reviewRecords（v1.15.0 起），檢視元件 ReviewQuestionList 也已顯示，
 * 但三個查詢畫面都看不到：審查結果管理只列摘要、結果分析下探 L2 矩陣
 * 只顯示 是／否、指標分析選項明細只顯示彙總件數。
 *
 * 本版修正（只改顯示，不改 capture；匯入仍不支援備註欄）：
 * - AnalysisAnswer 帶 note；兩處查詢對映（主查詢、下探補抓）皆帶入 note。
 * - PersonOptionRow 帶 notes map；轉置矩陣每列帶平行 notes 陣列。
 * - 新增純函式 collectRecordNotes：只收 note 非空者（無備註不列入、不佔位），
 *   依指標題目順序、再依人員職編／年月排序。
 * - 審查結果管理：每筆加「明細」展開，只列有備註或常見錯誤的題目；
 *   無備註無錯誤的紀錄不顯示明細按鈕。
 * - 下探 L2：矩陣下方加補充說明區，依欄位（每欄＝一筆紀錄）分組列出。
 * - 指標分析：錯誤分析下方加補充說明區（即時明細才有；預存摘要模式無
 *   原始明細時整區不顯示）。
 * - CSS：備註儲存格可換行（.data-table td 預設 nowrap），手機不破版；
 *   不動 v1.40.7 的捲動固定標頭。
 * 覆蓋：
 * 1. personOptionRows 帶出 notes（去空白；缺 note 為 ""）
 * 2. 轉置矩陣 rows.notes 與 values 一一對應
 * 3. collectRecordNotes 只收非空備註
 * 4. collectRecordNotes 依題目順序排序
 * 5. collectRecordNotes 空輸入回 []
 * 6. collectRecordNotes 帶出人員／結果資訊
 * 7. ResultsPage 兩處查詢對映皆帶入 note
 * 8. 審查結果管理有明細展開（只在有備註或常見錯誤時顯示按鈕）
 * 9. 下探 L2 有補充說明區
 * 10. 指標分析有補充說明區（只在有備註時顯示）
 * 11. CSS 有備註換行規則
 * 12. 版號一致：src/version.ts 與 package.json 皆為 1.41.1
 */
import { build } from "esbuild";
import { writeFileSync, readFileSync } from "node:fs";

const ROOT = "/home/hatch/workspace/repos/QAweb";

const entry = `
import {
  personOptionRows,
  transposePersonOptionRows,
  collectRecordNotes,
} from "${ROOT}/src/lib/analysisRates";
export { personOptionRows, transposePersonOptionRows, collectRecordNotes };
`;
writeFileSync("/tmp/v1411-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v1411-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v1411-test-bundle.cjs",
  logLevel: "silent",
  define: { "import.meta.env": "{}" },
});
import { createRequire } from "node:module";
const require2 = createRequire("/tmp/v1411-test-bundle.cjs");
const L = require2("/tmp/v1411-test-bundle.cjs");

const read = (p) => readFileSync(`${ROOT}/${p}`, "utf8");
const resultsPage = read("src/features/ResultsPage.tsx");
const css = read("src/styles.css");
const versionTs = read("src/version.ts");
const pkg = JSON.parse(read("package.json"));

let passed = 0;
let failed = 0;
function assert(name, cond) {
  if (cond) {
    passed++;
    console.log(`ok - ${name}`);
  } else {
    failed++;
    console.error(`FAIL: ${name}`);
  }
}
function expectContains(haystack, needle, message) {
  if (!haystack.includes(needle))
    throw new Error(message ?? `缺少：${needle}`);
}

/* ---- 純函式 ---- */
const questions = [
  { id: "q1", itemText: "題一" },
  { id: "q2", itemText: "題二" },
];
const mkRec = (emp, name, year, month, rate, answers) => ({
  indicatorId: "ind1",
  unitId: "U1",
  year,
  month,
  rate,
  answers,
  personEmpNo: emp,
  personName: name,
});

{
  const recs = [
    mkRec("E001", "王小明", 2026, 1, 50, [
      { questionId: "q1", itemText: "題一", optionLabel: "否", score: 0, note: "  未確實洗手  " },
      { questionId: "q2", itemText: "題二", optionLabel: "是", score: 1 },
    ]),
    mkRec("E002", "李大華", 2026, 1, 100, [
      { questionId: "q1", itemText: "題一", optionLabel: "是", score: 1, note: "   " },
      { questionId: "q2", itemText: "題二", optionLabel: "否", score: 0, note: "紀錄不完整" },
    ]),
  ];
  const rows = L.personOptionRows(recs, 80);
  assert(
    "personOptionRows 帶出 notes（去空白；缺 note 為空字串）",
    rows.length === 2 &&
      rows[0].notes.get("q1") === "未確實洗手" &&
      rows[0].notes.get("q2") === "" &&
      rows[1].notes.get("q1") === "" &&
      rows[1].notes.get("q2") === "紀錄不完整",
  );
  const m = L.transposePersonOptionRows(rows, questions);
  assert(
    "轉置矩陣 rows.notes 與 values 一一對應",
    JSON.stringify(m.rows[0].notes) === JSON.stringify(["未確實洗手", ""]) &&
      JSON.stringify(m.rows[1].notes) === JSON.stringify(["", "紀錄不完整"]) &&
      JSON.stringify(m.rows[0].values) === JSON.stringify(["否", "是"]),
  );
}

{
  const recs = [
    mkRec("E002", "李大華", 2026, 2, 100, [
      { questionId: "q2", itemText: "題二", optionLabel: "否", score: 0, note: "第二題備註" },
      { questionId: "q1", itemText: "題一", optionLabel: "是", score: 1 },
    ]),
    mkRec("E001", "王小明", 2026, 1, 50, [
      { questionId: "q2", itemText: "題二", optionLabel: "否", score: 0, note: "  " },
      { questionId: "q1", itemText: "題一", optionLabel: "否", score: 0, note: "第一題備註" },
    ]),
    mkRec("E003", "陳小芬", 2026, 1, 100, [
      { questionId: "q1", itemText: "題一", optionLabel: "是", score: 1 },
    ]),
  ];
  const notes = L.collectRecordNotes(recs, questions);
  assert(
    "collectRecordNotes 只收非空備註（空白與缺值皆跳過）",
    notes.length === 2 &&
      notes.every((n) => n.note.trim() !== ""),
  );
  assert(
    "collectRecordNotes 依題目順序排序（題一在前）",
    notes[0].questionId === "q1" &&
      notes[0].note === "第一題備註" &&
      notes[1].questionId === "q2" &&
      notes[1].note === "第二題備註",
  );
  assert(
    "collectRecordNotes 帶出人員／結果資訊",
    notes[0].personEmpNo === "E001" &&
      notes[0].personName === "王小明" &&
      notes[0].optionLabel === "否" &&
      notes[0].year === 2026 &&
      notes[0].month === 1,
  );
  assert(
    "collectRecordNotes 空輸入回 []",
    L.collectRecordNotes([], questions).length === 0 &&
      L.collectRecordNotes(recs, []).length === 2,
  );
}

/* ---- 靜態守衛 ---- */
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}: ${err.message}`);
  }
}

check("ResultsPage 兩處查詢對映皆帶入 note", () => {
  const hits = resultsPage.split('note: typeof r.note === "string" ? r.note : ""').length - 1;
  const hits2 = resultsPage.split('note: typeof answer.note === "string" ? answer.note : ""').length - 1;
  if (hits < 1 || hits2 < 1) throw new Error(`主查詢對映 ${hits} 處、下探補抓 ${hits2} 處`);
});
check("審查結果管理有明細展開（只在有備註或常見錯誤時顯示按鈕）", () => {
  expectContains(resultsPage, "const noted = row.answers.filter(");
  expectContains(resultsPage, "明細（${noted.length}）");
  expectContains(resultsPage, "supp-note-table");
});
check("下探 L2 有補充說明區", () => {
  expectContains(resultsPage, "l2NoteGroups");
  expectContains(resultsPage, 'title="補充說明"');
});
check("指標分析有補充說明區（只在有備註時顯示）", () => {
  expectContains(resultsPage, "const indNotes = useMemo");
  expectContains(resultsPage, "indNotes.length > 0 && (");
  expectContains(resultsPage, "collectRecordNotes(source, indSel.questions)");
});
check("CSS 有備註換行規則", () => {
  expectContains(css, "/* v1.41.1：查詢畫面顯示補充說明");
  expectContains(css, ".supp-note-cell");
  expectContains(css, ".supp-notes-list");
});
check("版號一致：src/version.ts 與 package.json 皆為 1.41.1", () => {
  if (!versionTs.includes('"1.41.1"')) throw new Error("version.ts 不是 1.41.1");
  if (pkg.version !== "1.41.1") throw new Error(`package.json 是 ${pkg.version}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
