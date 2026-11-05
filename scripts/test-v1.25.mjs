/**
 * v1.25.0 斷言測試：結果分析改版——
 * - 期間欄展開（季／半年／一年、年度／學年、年數往後數）
 * - 欄位標籤（同年／跨年／全年）
 * - 達閾值率（人次合併／單位平均／閾值未設定）
 * - 各選項得分狀況（是／否／不適用、得分率）
 * - 月份過濾（跨年）
 * 用 esbuild 打包後在 node 執行（被測函式皆零依賴／純函式）。
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";

const ROOT = "/home/hatch/workspace/repos/QAweb";

const entry = `
import {
  expandAnalysisColumns,
  currentQuarterSub,
  calendarYearsOf,
  rangeLabel,
} from "${ROOT}/src/lib/analysisPeriod";
import {
  isPassing,
  passRateOf,
  averageUnitPassRate,
  recordsInMonths,
  optionDetailRows,
} from "${ROOT}/src/lib/analysisRates";
export {
  expandAnalysisColumns,
  currentQuarterSub,
  calendarYearsOf,
  rangeLabel,
  isPassing,
  passRateOf,
  averageUnitPassRate,
  recordsInMonths,
  optionDetailRows,
};
`;
writeFileSync("/tmp/v125-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v125-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v125-test-bundle.cjs",
  logLevel: "silent",
  define: { "import.meta.env": "{}" },
});
const require2 = createRequire("/tmp/v125-test-bundle.cjs");
const L = require2("/tmp/v125-test-bundle.cjs");

let passed = 0;
let failed = 0;
function assert(name, cond) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("FAIL:", name);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---- 期間欄：季 ---- */
{
  const cols = L.expandAnalysisColumns({
    cycle: "year",
    startYear: 2026,
    yearCount: 2,
    interval: "quarter",
    sub: 1,
  });
  assert("年度 季 Q1 2年 → 2欄", cols.length === 2);
  assert(
    "年度 季 Q1 標籤",
    eq(
      cols.map((c) => c.label),
      ["2026/1-3", "2027/1-3"],
    ),
  );
  assert(
    "年度 季 Q1 月份",
    eq(cols[0].months, [
      { year: 2026, month: 1 },
      { year: 2026, month: 2 },
      { year: 2026, month: 3 },
    ]),
  );
  const ac = L.expandAnalysisColumns({
    cycle: "academic",
    startYear: 2026,
    yearCount: 2,
    interval: "quarter",
    sub: 1,
  });
  assert(
    "學年 季 Q1 標籤",
    eq(
      ac.map((c) => c.label),
      ["2026/8-10", "2027/8-10"],
    ),
  );
  const ac2 = L.expandAnalysisColumns({
    cycle: "academic",
    startYear: 2026,
    yearCount: 1,
    interval: "quarter",
    sub: 2,
  });
  assert("學年 季 Q2 跨年標籤", ac2[0].label === "2026/11-2027/1");
  assert(
    "學年 季 Q2 月份",
    eq(ac2[0].months, [
      { year: 2026, month: 11 },
      { year: 2026, month: 12 },
      { year: 2027, month: 1 },
    ]),
  );
  const ac3 = L.expandAnalysisColumns({
    cycle: "academic",
    startYear: 2026,
    yearCount: 1,
    interval: "quarter",
    sub: 4,
  });
  assert("學年 季 Q4 標籤", ac3[0].label === "2027/5-7");
  const yc = L.expandAnalysisColumns({
    cycle: "year",
    startYear: 2026,
    yearCount: 3,
    interval: "quarter",
    sub: 3,
  });
  assert(
    "年數往後數（2026起3年）",
    eq(
      yc.map((c) => c.label),
      ["2026/7-9", "2027/7-9", "2028/7-9"],
    ),
  );
}

/* ---- 期間欄：半年／一年 ---- */
{
  const half = L.expandAnalysisColumns({
    cycle: "year",
    startYear: 2026,
    yearCount: 2,
    interval: "year",
    sub: "half",
  });
  assert(
    "年度 半年 2年 → 4欄",
    eq(
      half.map((c) => c.label),
      ["2026/1-6", "2026/7-12", "2027/1-6", "2027/7-12"],
    ),
  );
  const halfAc = L.expandAnalysisColumns({
    cycle: "academic",
    startYear: 2026,
    yearCount: 1,
    interval: "year",
    sub: "half",
  });
  assert(
    "學年 半年 → 上半年跨年＋下半年",
    eq(
      halfAc.map((c) => c.label),
      ["2026/8-2027/1", "2027/2-7"],
    ),
  );
  const full = L.expandAnalysisColumns({
    cycle: "year",
    startYear: 2026,
    yearCount: 1,
    interval: "year",
    sub: "full",
  });
  assert("年度 全年標籤", full[0].label === "2026/1-12");
  assert("年度 全年 12 個月", full[0].months.length === 12);
  const fullAc = L.expandAnalysisColumns({
    cycle: "academic",
    startYear: 2026,
    yearCount: 1,
    interval: "year",
    sub: "full",
  });
  assert("學年 全年標籤", fullAc[0].label === "2026/8-2027/7");
  assert("學年 全年 12 個月", fullAc[0].months.length === 12);
}

/* ---- 欄位標籤與曆年 ---- */
{
  assert("單月標籤", L.rangeLabel([{ year: 2026, month: 8 }]) === "2026/8");
  assert("空標籤", L.rangeLabel([]) === "—");
  const cols = L.expandAnalysisColumns({
    cycle: "academic",
    startYear: 2026,
    yearCount: 2,
    interval: "year",
    sub: "full",
  });
  assert(
    "學年 2 年全年涵蓋曆年 2026-2028",
    eq(L.calendarYearsOf(cols), [2026, 2027, 2028]),
  );
}

/* ---- 當前季 ---- */
{
  assert("年度 2月 → Q1", L.currentQuarterSub("year", new Date(2026, 1, 10)) === 1);
  assert("年度 5月 → Q2", L.currentQuarterSub("year", new Date(2026, 4, 10)) === 2);
  assert("年度 8月 → Q3", L.currentQuarterSub("year", new Date(2026, 7, 10)) === 3);
  assert("年度 11月 → Q4", L.currentQuarterSub("year", new Date(2026, 10, 10)) === 4);
  assert("學年 9月 → Q1", L.currentQuarterSub("academic", new Date(2026, 8, 10)) === 1);
  assert("學年 1月 → Q2", L.currentQuarterSub("academic", new Date(2027, 0, 10)) === 2);
  assert("學年 3月 → Q3", L.currentQuarterSub("academic", new Date(2027, 2, 10)) === 3);
  assert("學年 6月 → Q4", L.currentQuarterSub("academic", new Date(2027, 5, 10)) === 4);
}

/* ---- 達閾值率 ---- */
const mkRec = (unitId, rate, year = 2026, month = 1) => ({
  indicatorId: "ind1",
  unitId,
  year,
  month,
  rate,
  answers: [],
});
{
  assert("rate ≥ 閾值達標", L.isPassing(80, 80) === true);
  assert("rate < 閾值未達標", L.isPassing(79.9, 80) === false);
  assert("rate null 未達標", L.isPassing(null, 80) === false);
  assert("閾值未設定視為不達標", L.isPassing(100, 0) === false);
  const pr = L.passRateOf(
    [mkRec("U1", 90), mkRec("U1", 70), mkRec("U2", null)],
    80,
  );
  assert("合併人次率 pass/total", pr.pass === 1 && pr.total === 3);
  assert("合併人次率 33.3%", pr.rate === 33.3);
  const empty = L.passRateOf([], 80);
  assert("無資料 rate null", empty.rate === null && empty.total === 0);
  const avg = L.averageUnitPassRate(
    [mkRec("U1", 90), mkRec("U1", 70), mkRec("U2", 100)],
    80,
  );
  assert("單位平均率 75%（50% 與 100% 平均）", avg.rate === 75);
  assert("單位平均計入 2 單位", avg.unitCount === 2);
  assert("單位平均總人次 3", avg.total === 3);
  const avgEmpty = L.averageUnitPassRate([], 80);
  assert("單位平均無資料", avgEmpty.rate === null && avgEmpty.unitCount === 0);
}

/* ---- 月份過濾 ---- */
{
  const recs = [
    mkRec("U1", 90, 2026, 12),
    mkRec("U1", 90, 2027, 1),
    mkRec("U1", 90, 2027, 2),
  ];
  const got = L.recordsInMonths(recs, [
    { year: 2026, month: 12 },
    { year: 2027, month: 1 },
  ]);
  assert("跨年月過濾取 2 筆", got.length === 2);
}

/* ---- 各選項得分狀況 ---- */
{
  const qs = [
    { id: "q1", itemText: "題一", order: 2 },
    { id: "q2", itemText: "題二", order: 1 },
  ];
  const recs = [
    {
      ...mkRec("U1", 100),
      answers: [
        { questionId: "q1", itemText: "題一", optionLabel: "是", score: 1 },
        { questionId: "q2", itemText: "題二", optionLabel: "否", score: 0 },
      ],
    },
    {
      ...mkRec("U2", 50),
      answers: [
        { questionId: "q1", itemText: "題一", optionLabel: "是", score: 1 },
        { questionId: "q2", itemText: "題二", optionLabel: "不適用", score: 0, excluded: true },
      ],
    },
    {
      ...mkRec("U1", 0),
      answers: [
        { questionId: "q1", itemText: "題一", optionLabel: "否", score: 0 },
        { questionId: "q2", itemText: "題二", optionLabel: "", score: 0, excluded: true },
      ],
    },
  ];
  const rows = L.optionDetailRows(recs, qs);
  assert("題目依 order 排序", rows[0].questionId === "q2" && rows[1].questionId === "q1");
  const q1 = rows[1];
  assert("題一 是2／否1／不適用0", q1.yes === 2 && q1.no === 1 && q1.na === 0);
  assert("題一 是率 66.7%", q1.yesRate === 66.7);
  assert("題一 得分率 66.7%", q1.scoreRate === 66.7);
  const q2 = rows[0];
  assert("題二 否1／不適用2（含未填）", q2.no === 1 && q2.na === 2);
  assert("題二 得分率 0%", q2.scoreRate === 0);
  const none = L.optionDetailRows([], qs);
  assert("無紀錄得分率 null", none.every((r) => r.scoreRate === null));
  assert("無紀錄是率 null", none.every((r) => r.yesRate === null));
}

console.log(`pass ${passed}, fail ${failed}`);
if (failed) process.exit(1);
