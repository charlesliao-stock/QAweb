/**
 * v1.26.0 斷言測試：結果分析篩選器調整——
 * - 區間加「月」（月＋全部：每年 12 個單月欄；學年按 8 月起算）
 * - 期間加「全部」（季＋全部：每年 4 欄；年＋全部：每年 3 欄，上半年→下半年→全年）
 * - 舊組合回歸（季＋第 N 季、年＋半年、年＋一年）
 * 用 esbuild 打包後在 node 執行（被測函式皆零依賴／純函式）。
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";

const ROOT = "/home/hatch/workspace/repos/QAweb";

const entry = `
import {
  expandAnalysisColumns,
  calendarYearsOf,
  rangeLabel,
} from "${ROOT}/src/lib/analysisPeriod";
export { expandAnalysisColumns, calendarYearsOf, rangeLabel };
`;
writeFileSync("/tmp/v126-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v126-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v126-test-bundle.cjs",
  logLevel: "silent",
  define: { "import.meta.env": "{}" },
});
const require2 = createRequire("/tmp/v126-test-bundle.cjs");
const L = require2("/tmp/v126-test-bundle.cjs");

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

/* ---- 月＋全部 ---- */
{
  const cols = L.expandAnalysisColumns({
    cycle: "year",
    startYear: 2026,
    yearCount: 1,
    interval: "month",
    sub: "all",
  });
  assert("年度 月＋全部 1年 → 12欄", cols.length === 12);
  assert(
    "年度 月＋全部 標籤",
    eq(
      cols.map((c) => c.label),
      [
        "2026/1",
        "2026/2",
        "2026/3",
        "2026/4",
        "2026/5",
        "2026/6",
        "2026/7",
        "2026/8",
        "2026/9",
        "2026/10",
        "2026/11",
        "2026/12",
      ],
    ),
  );
  assert(
    "年度 月＋全部 每欄 1 個月",
    cols.every((c) => c.months.length === 1),
  );
  assert(
    "年度 月＋全部 key 唯一",
    new Set(cols.map((c) => c.key)).size === 12,
  );
  assert(
    "年度 月＋全部 涵蓋曆年",
    eq(L.calendarYearsOf(cols), [2026]),
  );

  const ac = L.expandAnalysisColumns({
    cycle: "academic",
    startYear: 2026,
    yearCount: 1,
    interval: "month",
    sub: "all",
  });
  assert("學年 月＋全部 1年 → 12欄", ac.length === 12);
  assert(
    "學年 月＋全部 標籤（8 月起算）",
    eq(
      ac.map((c) => c.label),
      [
        "2026/8",
        "2026/9",
        "2026/10",
        "2026/11",
        "2026/12",
        "2027/1",
        "2027/2",
        "2027/3",
        "2027/4",
        "2027/5",
        "2027/6",
        "2027/7",
      ],
    ),
  );
  assert(
    "學年 月＋全部 涵蓋曆年",
    eq(L.calendarYearsOf(ac), [2026, 2027]),
  );

  const two = L.expandAnalysisColumns({
    cycle: "year",
    startYear: 2026,
    yearCount: 2,
    interval: "month",
    sub: "all",
  });
  assert("年度 月＋全部 2年 → 24欄", two.length === 24);
  assert("年度 月＋全部 2年 首欄", two[0].label === "2026/1");
  assert("年度 月＋全部 2年 末欄", two[23].label === "2027/12");
}

/* ---- 季＋全部 ---- */
{
  const cols = L.expandAnalysisColumns({
    cycle: "year",
    startYear: 2026,
    yearCount: 1,
    interval: "quarter",
    sub: "all",
  });
  assert("年度 季＋全部 1年 → 4欄", cols.length === 4);
  assert(
    "年度 季＋全部 標籤",
    eq(
      cols.map((c) => c.label),
      ["2026/1-3", "2026/4-6", "2026/7-9", "2026/10-12"],
    ),
  );

  const ac = L.expandAnalysisColumns({
    cycle: "academic",
    startYear: 2026,
    yearCount: 1,
    interval: "quarter",
    sub: "all",
  });
  assert(
    "學年 季＋全部 標籤",
    eq(
      ac.map((c) => c.label),
      ["2026/8-10", "2026/11-2027/1", "2027/2-4", "2027/5-7"],
    ),
  );

  const two = L.expandAnalysisColumns({
    cycle: "year",
    startYear: 2026,
    yearCount: 2,
    interval: "quarter",
    sub: "all",
  });
  assert("年度 季＋全部 2年 → 8欄", two.length === 8);
  assert("年度 季＋全部 2年 第 5 欄", two[4].label === "2027/1-3");
}

/* ---- 年＋全部 ---- */
{
  const cols = L.expandAnalysisColumns({
    cycle: "year",
    startYear: 2026,
    yearCount: 1,
    interval: "year",
    sub: "all",
  });
  assert("年度 年＋全部 1年 → 3欄", cols.length === 3);
  assert(
    "年度 年＋全部 標籤（上半年→下半年→全年）",
    eq(
      cols.map((c) => c.label),
      ["2026/1-6", "2026/7-12", "2026/1-12"],
    ),
  );
  assert(
    "年度 年＋全部 月數 6／6／12",
    eq(
      cols.map((c) => c.months.length),
      [6, 6, 12],
    ),
  );

  const ac = L.expandAnalysisColumns({
    cycle: "academic",
    startYear: 2026,
    yearCount: 1,
    interval: "year",
    sub: "all",
  });
  assert(
    "學年 年＋全部 標籤",
    eq(
      ac.map((c) => c.label),
      ["2026/8-2027/1", "2027/2-7", "2026/8-2027/7"],
    ),
  );

  const two = L.expandAnalysisColumns({
    cycle: "year",
    startYear: 2026,
    yearCount: 2,
    interval: "year",
    sub: "all",
  });
  assert("年度 年＋全部 2年 → 6欄", two.length === 6);
  assert(
    "年度 年＋全部 2年 順序",
    eq(
      two.map((c) => c.label),
      [
        "2026/1-6",
        "2026/7-12",
        "2026/1-12",
        "2027/1-6",
        "2027/7-12",
        "2027/1-12",
      ],
    ),
  );
}

/* ---- 舊組合回歸 ---- */
{
  const q1 = L.expandAnalysisColumns({
    cycle: "year",
    startYear: 2026,
    yearCount: 2,
    interval: "quarter",
    sub: 1,
  });
  assert(
    "回歸 年度 季 Q1 2年 → 2欄",
    q1.length === 2 && eq(q1.map((c) => c.label), ["2026/1-3", "2027/1-3"]),
  );
  const half = L.expandAnalysisColumns({
    cycle: "year",
    startYear: 2026,
    yearCount: 1,
    interval: "year",
    sub: "half",
  });
  assert(
    "回歸 年度 年＋半年 → 2欄",
    half.length === 2 && eq(half.map((c) => c.label), ["2026/1-6", "2026/7-12"]),
  );
  const full = L.expandAnalysisColumns({
    cycle: "year",
    startYear: 2026,
    yearCount: 1,
    interval: "year",
    sub: "full",
  });
  assert(
    "回歸 年度 年＋一年 → 1欄",
    full.length === 1 && full[0].label === "2026/1-12",
  );
  assert("rangeLabel 單月", L.rangeLabel([{ year: 2026, month: 1 }]) === "2026/1");
}

console.log(`pass ${passed}, fail ${failed}`);
if (failed) process.exit(1);
