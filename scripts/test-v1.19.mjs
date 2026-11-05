/**
 * v1.19.0 斷言測試：品管審查區間計算與進度計算純函式
 * （scheduleIntervals／currentInterval／intervalDisplay／
 *  computeIntervalProgress／isProgressComplete／recordYearMonth）。
 * 用 esbuild 打包後在 node 執行（本檔函式皆零依賴）。
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";

const ROOT = "/home/hatch/workspace/repos/QAweb";

const entry = `
import {
  ymKey, cmpYM, addMonths,
  scheduleIntervals, currentInterval, scheduleLastEnd,
  intervalDisplay, recordYearMonth,
  computeIntervalProgress, isProgressComplete,
} from "${ROOT}/src/lib/reviewActive";
export {
  ymKey, cmpYM, addMonths,
  scheduleIntervals, currentInterval, scheduleLastEnd,
  intervalDisplay, recordYearMonth,
  computeIntervalProgress, isProgressComplete,
};
`;
writeFileSync("/tmp/v119-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v119-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v119-test-bundle.cjs",
  logLevel: "silent",
  define: { "import.meta.env": "{}" },
});
const require2 = createRequire("/tmp/v119-test-bundle.cjs");
const L = require2("/tmp/v119-test-bundle.cjs");

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

/* ---------- 1. 年度 4次/年＋3個月 ---------- */
const sYear = {
  category: "year",
  period: "2026",
  months: [1, 4, 7, 10],
  frequency: 4,
  intervalMonths: 3,
  refYear: null,
};
{
  const ivs = L.scheduleIntervals(sYear, D(2026, 11));
  assert("年度4+3：4 個區間", ivs.length === 4);
  assert(
    "年度4+3：第一區間 2026/1–2026/3",
    eq(ivs[0].start, { year: 2026, month: 1 }) &&
      eq(ivs[0].end, { year: 2026, month: 3 }),
  );
  assert(
    "年度4+3：最後區間 2026/10–2026/12",
    eq(ivs[3].start, { year: 2026, month: 10 }) &&
      eq(ivs[3].end, { year: 2026, month: 12 }),
  );
  assert(
    "年度4+3：審查月為區間內全部月份（v1.23：不再只有起始月）",
    eq(ivs[3].reviewMonths, [
      { year: 2026, month: 10 },
      { year: 2026, month: 11 },
      { year: 2026, month: 12 },
    ]),
  );
  assert(
    "年度4+3：顯示「2026/1-3」",
    L.intervalDisplay(ivs[0], "year") === "2026/1-3",
  );
}

/* ---------- 2. 學年度 4次/年＋3個月（跨年） ---------- */
const sAcad = {
  category: "academic",
  period: "115",
  months: [8, 11, 2, 5],
  frequency: 4,
  intervalMonths: 3,
  refYear: null,
};
{
  const ivs = L.scheduleIntervals(sAcad, D(2026, 11));
  assert("學年度4+3：4 個區間", ivs.length === 4);
  assert(
    "學年度4+3：第一區間 2026/8–2026/10",
    eq(ivs[0].start, { year: 2026, month: 8 }) &&
      eq(ivs[0].end, { year: 2026, month: 10 }),
  );
  assert(
    "學年度4+3：第二區間跨年 2026/11–2027/1",
    eq(ivs[1].start, { year: 2026, month: 11 }) &&
      eq(ivs[1].end, { year: 2027, month: 1 }),
  );
  assert(
    "學年度4+3：跨年顯示「2026/11-2027/1」",
    L.intervalDisplay(ivs[1], "academic") === "2026/11-2027/1",
  );
}

/* ---------- 3. 臨時 ---------- */
const sTemp = {
  category: "temp",
  period: "1760000000000",
  months: [3, 5],
  frequency: null,
  intervalMonths: null,
  refYear: 2026,
};
{
  const ivs = L.scheduleIntervals(sTemp, D(2026, 11));
  assert("臨時：1 個區間", ivs.length === 1);
  assert(
    "臨時：顯示「2026/3、5」",
    L.intervalDisplay(ivs[0], "temp") === "2026/3、5",
  );
}

/* ---------- 4. 舊排程（無頻次／區間） ---------- */
const sOld = {
  category: "year",
  period: "2026",
  months: [1, 4, 7, 10],
  frequency: null,
  intervalMonths: null,
  refYear: null,
};
{
  const ivs = L.scheduleIntervals(sOld, D(2026, 11));
  assert("舊排程：整期為一區", ivs.length === 1);
  assert(
    "舊排程：顯示「2026/1-10」",
    L.intervalDisplay(ivs[0], "year") === "2026/1-10",
  );
  assert(
    "舊排程：審查月＝全部月份",
    ivs[0].reviewMonths.length === 4,
  );
}

/* ---------- 5. 現階段選擇 ---------- */
{
  const cur = L.currentInterval(sYear, D(2026, 11, 5));
  assert(
    "2026-11-05 的現階段＝2026/10-12",
    cur != null &&
      eq(cur.start, { year: 2026, month: 10 }) &&
      eq(cur.end, { year: 2026, month: 12 }),
  );
  const early = L.currentInterval(sYear, D(2025, 12, 20));
  assert(
    "早於第一區間→用第一區間",
    early != null && eq(early.start, { year: 2026, month: 1 }),
  );
  const late = L.currentInterval(sYear, D(2027, 2, 1));
  assert("晚於最後區間→null（已結束）", late === null);
  const tcur = L.currentInterval(sTemp, D(2026, 4, 1));
  assert("臨時 2026-04 在區間內", tcur != null);
  const tlate = L.currentInterval(sTemp, D(2026, 6, 1));
  assert("臨時 2026-06 已結束→null", tlate === null);
  const gapSched = {
    category: "year",
    period: "2026",
    months: [1, 7],
    frequency: 2,
    intervalMonths: 3,
    refYear: null,
  };
  const gap = L.currentInterval(gapSched, D(2026, 5, 10));
  assert(
    "區間空隙→取下一個尚未結束的區間（2026/7-9）",
    gap != null && L.intervalDisplay(gap, "year") === "2026/7-9",
  );
}

/* ---------- 6. 最後結束月 ---------- */
{
  const end = L.scheduleLastEnd(sYear, D(2026, 1));
  assert("年度最後結束月 2026-12", eq(end, { year: 2026, month: 12 }));
  const aend = L.scheduleLastEnd(sAcad, D(2026, 1));
  assert("學年度最後結束月 2027-7", eq(aend, { year: 2027, month: 7 }));
}

/* ---------- 7. 進度計算 ---------- */
{
  const keys = new Set(["2026-10", "2026-11", "2026-12"]);
  const records = [
    { unitId: "u1", year: 2026, month: 10 },
    { unitId: "u1", year: 2026, month: 10 },
    { unitId: "u2", year: 2026, month: 11 },
    { unitId: "u9", year: 2026, month: 9 }, // 區間外，不計
  ];
  const p = L.computeIntervalProgress({
    unitCount: 3,
    caseCount: 5,
    reviewMonthCount: 1,
    records,
    intervalMonthKeys: keys,
  });
  assert("總人次＝3×5×1＝15", p.totalPersons === 15);
  assert("已完成人次＝3", p.donePersons === 3);
  assert("人次百分比 20%", p.personPct === 20);
  assert("總單位次＝3×1＝3", p.totalUnits === 3);
  assert("已完成單位次＝2（u1@10、u2@11）", p.doneUnits === 2);
  assert("未達 100%→未完成", L.isProgressComplete(p) === false);

  const p2 = L.computeIntervalProgress({
    unitCount: 3,
    caseCount: null,
    reviewMonthCount: 1,
    records,
    intervalMonthKeys: keys,
  });
  assert("件數未設定→totalPersons null", p2.totalPersons === null);
  assert("件數未設定→personPct null", p2.personPct === null);
  assert("件數未設定→看單位次，未完成", L.isProgressComplete(p2) === false);

  const p3 = L.computeIntervalProgress({
    unitCount: 0,
    caseCount: 5,
    reviewMonthCount: 0,
    records: [],
    intervalMonthKeys: new Set(),
  });
  assert("total=0 視為完成", L.isProgressComplete(p3) === true);
}

/* ---------- 8. 紀錄年月歸屬 ---------- */
{
  assert(
    "有 year/month 直接用",
    eq(L.recordYearMonth({ year: 2026, month: 4 }), {
      year: 2026,
      month: 4,
    }),
  );
  assert(
    "無 year/month 用 submittedAt",
    eq(
      L.recordYearMonth({
        submittedAt: { toDate: () => new Date(2026, 4, 20) },
      }),
      { year: 2026, month: 5 },
    ),
  );
  assert("都沒有→null", L.recordYearMonth({}) === null);
}

/* ---------- 9. YM 工具 ---------- */
{
  assert("ymKey", L.ymKey({ year: 2026, month: 3 }) === "2026-3");
  assert(
    "addMonths 跨年",
    eq(L.addMonths({ year: 2026, month: 11 }, 2), {
      year: 2027,
      month: 1,
    }),
  );
  assert("cmpYM", L.cmpYM({ year: 2026, month: 1 }, { year: 2026, month: 2 }) < 0);
}

console.log(`\nv1.19: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
