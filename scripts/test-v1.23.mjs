/**
 * v1.23.0 斷言測試：排程設定改版——區間獨立下拉（1／2／3 個月）、
 * 起始月＋區間月數展開、審查月數＝區間月數、舊排程相容。
 * 用 esbuild 打包後在 node 執行（被測函式皆零依賴／純函式）。
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";

const ROOT = "/home/hatch/workspace/repos/QAweb";

const entry = `
import {
  autoSelectMonths, resolveIntervalMonths, clampIntervalForEditor,
  parseIntervalMonths, intervalRangeLabels, scheduleReviewCalendarMonths,
} from "${ROOT}/src/lib/scheduling";
import {
  scheduleIntervals, containingInterval, intervalDisplay,
  computeIntervalProgress,
} from "${ROOT}/src/lib/reviewActive";
import { cycleMonths } from "${ROOT}/src/lib/cycle";
export {
  autoSelectMonths, resolveIntervalMonths, clampIntervalForEditor,
  parseIntervalMonths, intervalRangeLabels, scheduleReviewCalendarMonths,
  scheduleIntervals, containingInterval, intervalDisplay,
  computeIntervalProgress, cycleMonths,
};
`;
writeFileSync("/tmp/v123-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v123-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v123-test-bundle.cjs",
  logLevel: "silent",
  define: { "import.meta.env": "{}" },
});
const require2 = createRequire("/tmp/v123-test-bundle.cjs");
const L = require2("/tmp/v123-test-bundle.cjs");

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
const D = (y, m, d = 15) => new Date(y, m - 1, d);
const ymList = (arr) => arr.map(({ year, month }) => `${year}-${month}`);

/* ---------- 1. 頻次 → 起始月份（均分規則不變） ---------- */
assert(
  "年度 3次 → [1,5,9]",
  eq(L.autoSelectMonths(3, L.cycleMonths("year", "2026")), [1, 5, 9]),
);
assert(
  "學年度 3次 → [4,8,12]",
  eq(L.autoSelectMonths(3, L.cycleMonths("academic", "115")), [4, 8, 12]),
);
assert(
  "學年度 2次 → [2,8]",
  eq(L.autoSelectMonths(2, L.cycleMonths("academic", "115")), [2, 8]),
);
assert(
  "年度 4次 → [1,4,7,10]",
  eq(L.autoSelectMonths(4, L.cycleMonths("year", "2026")), [1, 4, 7, 10]),
);

/* ---------- 2. 有效區間月數解析 ---------- */
assert("已存值優先：2 個月", L.resolveIntervalMonths(4, 2) === 2);
assert("無區間＋2次 → 6（舊規則）", L.resolveIntervalMonths(2, null) === 6);
assert("無區間＋3次 → 4（舊規則）", L.resolveIntervalMonths(3, null) === 4);
assert("無區間＋4次 → 3（舊規則）", L.resolveIntervalMonths(4, null) === 3);
assert("皆無 → null", L.resolveIntervalMonths(null, null) === null);

/* ---------- 3. 區間解析與編輯器初值 ---------- */
assert("parse：1／2／3／4／6 接受", [1, 2, 3, 4, 6].every((n) => L.parseIntervalMonths(n) === n));
assert("parse：5／字串／null 拒絕", L.parseIntervalMonths(5) === null && L.parseIntervalMonths("2") === null && L.parseIntervalMonths(null) === null);
assert(
  "編輯器初值：1／2／3 照用，4／6／null → 3",
  L.clampIntervalForEditor(1) === 1 &&
    L.clampIntervalForEditor(2) === 2 &&
    L.clampIntervalForEditor(3) === 3 &&
    L.clampIntervalForEditor(4) === 3 &&
    L.clampIntervalForEditor(6) === 3 &&
    L.clampIntervalForEditor(null) === 3,
);

/* ---------- 4. 區間文字 ---------- */
assert(
  "學年度 3次＋2個月 → 8-9、12-1、4-5月",
  eq(L.intervalRangeLabels([8, 12, 4], 2), ["8-9月", "12-1月", "4-5月"]),
);
assert(
  "年度 3次＋2個月 → 1-2、5-6、9-10月",
  eq(L.intervalRangeLabels([1, 5, 9], 2), ["1-2月", "5-6月", "9-10月"]),
);
assert(
  "1 個月只顯示單月",
  eq(L.intervalRangeLabels([8, 12, 4], 1), ["8月", "12月", "4月"]),
);
assert("12月＋3個月 → 12-2月", eq(L.intervalRangeLabels([12], 3), ["12-2月"]));

/* ---------- 5. 排程 → 全部審查曆年月 ---------- */
{
  const acad = L.scheduleReviewCalendarMonths({
    category: "academic",
    period: "115",
    months: [8, 12, 4],
    frequency: 3,
    intervalMonths: 2,
  });
  assert(
    "學年度 3次＋2個月 → 2026/8、9、12、2027/1、4、5",
    eq(ymList(acad), ["2026-8", "2026-9", "2026-12", "2027-1", "2027-4", "2027-5"]),
  );
  const yr = L.scheduleReviewCalendarMonths({
    category: "year",
    period: "2026",
    months: [1, 5, 9],
    frequency: 3,
    intervalMonths: 2,
  });
  assert(
    "年度 3次＋2個月 → 2026/1、2、5、6、9、10",
    eq(ymList(yr), ["2026-1", "2026-2", "2026-5", "2026-6", "2026-9", "2026-10"]),
  );
  const wrap = L.scheduleReviewCalendarMonths({
    category: "year",
    period: "2026",
    months: [12],
    frequency: 4,
    intervalMonths: 2,
  });
  assert(
    "年度 12月＋2個月跨年 → 2026/12、2027/1",
    eq(ymList(wrap), ["2026-12", "2027-1"]),
  );
  const temp = L.scheduleReviewCalendarMonths({
    category: "temp",
    period: "1772323200000",
    months: [3, 5],
    frequency: null,
    intervalMonths: null,
  });
  assert("臨時：原月份不展開", eq(ymList(temp), ["2026-3", "2026-5"]));
  const old = L.scheduleReviewCalendarMonths({
    category: "year",
    period: "2026",
    months: [1, 4, 7, 10],
    frequency: null,
    intervalMonths: null,
  });
  assert("舊排程（無頻次區間）：原月份不展開", eq(ymList(old), ["2026-1", "2026-4", "2026-7", "2026-10"]));
  const oldFreq = L.scheduleReviewCalendarMonths({
    category: "year",
    period: "2026",
    months: [1, 5, 9],
    frequency: 3,
    intervalMonths: null,
  });
  assert(
    "舊排程（無區間＋3次）：由頻次推導 4 個月，全年 12 個月",
    oldFreq.length === 12,
  );
}

/* ---------- 6. 區間計算（審查月＝區間月數） ---------- */
const sAcad23 = {
  category: "academic",
  period: "115",
  months: [8, 12, 4],
  frequency: 3,
  intervalMonths: 2,
  refYear: null,
};
{
  const ivs = L.scheduleIntervals(sAcad23, D(2026, 11));
  assert("學年度 3次＋2個月：3 個區間", ivs.length === 3);
  assert(
    "第一區間 2026/8-9，審查月 2 個",
    eq(ivs[0].start, { year: 2026, month: 8 }) &&
      eq(ivs[0].end, { year: 2026, month: 9 }) &&
      ivs[0].reviewMonths.length === 2,
  );
  assert(
    "第二區間跨年顯示「2026/12-2027/1」",
    L.intervalDisplay(ivs[1], "academic") === "2026/12-2027/1" &&
      eq(ivs[1].reviewMonths, [
        { year: 2026, month: 12 },
        { year: 2027, month: 1 },
      ]),
  );
  assert(
    "第三區間 2027/4-5",
    L.intervalDisplay(ivs[2], "academic") === "2027/4-5",
  );
  assert(
    "包含判定：2026-09 在 8-9 區間內",
    L.containingInterval(sAcad23, D(2026, 9, 15)) !== null,
  );
  assert(
    "包含判定：2027-01 在 12-1 區間內",
    L.containingInterval(sAcad23, D(2027, 1, 10)) !== null,
  );
  assert(
    "包含判定：2026-10 空隙 → null",
    L.containingInterval(sAcad23, D(2026, 10, 15)) === null,
  );
}
{
  const oldFreq = {
    category: "year",
    period: "2026",
    months: [1, 5, 9],
    frequency: 3,
    intervalMonths: null,
    refYear: null,
  };
  const ivs = L.scheduleIntervals(oldFreq, D(2026, 11));
  assert(
    "舊排程無區間＋3次：由頻次推導 4 個月（1-4、5-8、9-12）",
    ivs.length === 3 &&
      L.intervalDisplay(ivs[0], "year") === "2026/1-4" &&
      ivs[0].reviewMonths.length === 4,
  );
}
{
  const one = {
    category: "year",
    period: "2026",
    months: [1, 4, 7, 10],
    frequency: 4,
    intervalMonths: 1,
    refYear: null,
  };
  const ivs = L.scheduleIntervals(one, D(2026, 11));
  assert(
    "區間 1 個月：每區間 1 個審查月",
    ivs.length === 4 && ivs.every((iv) => iv.reviewMonths.length === 1),
  );
}

/* ---------- 7. 進度計算（審查月數＝區間月數） ---------- */
{
  const keys = new Set(["2026-8", "2026-9"]);
  const records = [
    { unitId: "u1", year: 2026, month: 8 },
    { unitId: "u1", year: 2026, month: 9 },
    { unitId: "u2", year: 2026, month: 8 },
  ];
  const p = L.computeIntervalProgress({
    unitCount: 3,
    caseCount: 3,
    reviewMonthCount: 2,
    records,
    intervalMonthKeys: keys,
  });
  assert("總人次＝3×3×2＝18", p.totalPersons === 18);
  assert("已完成人次＝3", p.donePersons === 3);
  assert("總單位次＝3×2＝6", p.totalUnits === 6);
  assert("已完成單位次＝3（u1@8、u1@9、u2@8）", p.doneUnits === 3);
}

console.log(`\nv1.23: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
