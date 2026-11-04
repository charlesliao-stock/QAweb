/**
 * v1.16.0 lib 斷言測試：週期純函式（cycle.ts）＋排程新模型（scheduling.ts）
 * ＋系統參數 statsCycle（seed.ts）＋召集人權限（permissions.ts）。
 * 用 esbuild 打包後在 jsdom 全域環境下執行（證明 jsdom 可測）。
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";

const ROOT = "/home/hatch/workspace/repos/QAweb";

// 先建立 jsdom 全域環境，再載入被測 bundle
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.sessionStorage = dom.window.sessionStorage;

const entry = `
import { academicYearOf, toCycleKey, currentCycleKey, cycleMonths, monthToCalendarYear, periodLabel, categoryLabel, rocYear } from "${ROOT}/src/lib/cycle";
import { scheduleDocId, parseIndicatorSchedule, legacyYearScheduleToIndicatorSchedule, previousPeriodKey, parseScheduleCategory, parseScheduleMonths } from "${ROOT}/src/lib/scheduling";
import { DEFAULT_SYSTEM_PARAMS, SYSTEM_PARAM_LABELS, SYSTEM_PARAM_SELECT_OPTIONS } from "${ROOT}/src/lib/seed";
import { DEFAULT_ROLE_PERMS } from "${ROOT}/src/lib/permissions";
export { academicYearOf, toCycleKey, currentCycleKey, cycleMonths, monthToCalendarYear, periodLabel, categoryLabel, rocYear, scheduleDocId, parseIndicatorSchedule, legacyYearScheduleToIndicatorSchedule, previousPeriodKey, parseScheduleCategory, parseScheduleMonths, DEFAULT_SYSTEM_PARAMS, SYSTEM_PARAM_LABELS, SYSTEM_PARAM_SELECT_OPTIONS, DEFAULT_ROLE_PERMS };
`;
writeFileSync("/tmp/v116-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v116-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v116-test-bundle.cjs",
  logLevel: "silent",
});
const require2 = createRequire("/tmp/v116-test-bundle.cjs");
const L = require2("/tmp/v116-test-bundle.cjs");

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
const D = (y, m, d) => new Date(y, m - 1, d); // 月份用 1–12

// ── 0. jsdom 環境 ──
assert("jsdom 全域可用", typeof document !== "undefined" && typeof window !== "undefined");

// ── 1. 學年度邊界（8 月制） ──
assert("2026-11→115學年度", L.academicYearOf(D(2026, 11, 5)) === 115);
assert("2027-03→115學年度", L.academicYearOf(D(2027, 3, 20)) === 115);
assert("2027-08→116學年度", L.academicYearOf(D(2027, 8, 1)) === 116);
assert("7月→前一學年度（2026-07→114）", L.academicYearOf(D(2026, 7, 31)) === 114);
assert("8月→新學年度（2026-08→115）", L.academicYearOf(D(2026, 8, 1)) === 115);
assert("1月→前一學年度（2026-01→114）", L.academicYearOf(D(2026, 1, 15)) === 114);
assert("rocYear(2026)＝115", L.rocYear(2026) === 115);

// ── 2. toCycleKey／currentCycleKey ──
assert("toCycleKey academic 11月→115", L.toCycleKey(2026, 11, "academic") === "115");
assert("toCycleKey academic 3月→115", L.toCycleKey(2027, 3, "academic") === "115");
assert("toCycleKey academic 8月→116", L.toCycleKey(2027, 8, "academic") === "116");
assert("toCycleKey academic 7月→114", L.toCycleKey(2026, 7, "academic") === "114");
assert("toCycleKey year→西元年字串", L.toCycleKey(2026, 1, "year") === "2026");
assert("currentCycleKey year", L.currentCycleKey("year", D(2026, 11, 5)) === "2026");
assert("currentCycleKey academic", L.currentCycleKey("academic", D(2026, 11, 5)) === "115");

// ── 3. cycleMonths 順序 ──
assert("年度月份 1..12", eq(L.cycleMonths("year", "2026"), [1,2,3,4,5,6,7,8,9,10,11,12]));
assert("學年度月份順序", eq(L.cycleMonths("academic", "115"), [8,9,10,11,12,1,2,3,4,5,6,7]));
assert("臨時月份 1..12", eq(L.cycleMonths("temp", "1720000000000"), [1,2,3,4,5,6,7,8,9,10,11,12]));

// ── 4. monthToCalendarYear ──
assert("學年度115・8月→2026", L.monthToCalendarYear("academic", "115", 8) === 2026);
assert("學年度115・12月→2026", L.monthToCalendarYear("academic", "115", 12) === 2026);
assert("學年度115・1月→2027", L.monthToCalendarYear("academic", "115", 1) === 2027);
assert("學年度115・7月→2027", L.monthToCalendarYear("academic", "115", 7) === 2027);
assert("年度2026・5月→2026", L.monthToCalendarYear("year", "2026", 5) === 2026);
assert("臨時・時間戳取年份", L.monthToCalendarYear("temp", String(Date.UTC(2026, 5, 1)), 3) === 2026);

// ── 5. periodLabel／categoryLabel ──
assert("periodLabel 年度", L.periodLabel("year", "2026") === "2026年度");
assert("periodLabel 學年度", L.periodLabel("academic", "115") === "115學年度");
assert("periodLabel 臨時", L.periodLabel("temp", "1720000000000") === "臨時");
assert("categoryLabel 年度", L.categoryLabel("year") === "年度");
assert("categoryLabel 學年度", L.categoryLabel("academic") === "學年度");
assert("categoryLabel 臨時", L.categoryLabel("temp") === "臨時");

// ── 6. scheduleDocId ──
assert("scheduleDocId 年度", L.scheduleDocId("QI-001", "year", "2026") === "QI-001__year__2026");
assert("scheduleDocId 學年度", L.scheduleDocId("QI-001", "academic", "115") === "QI-001__academic__115");
assert("scheduleDocId 臨時", L.scheduleDocId("QI-001", "temp", "1720000000000") === "QI-001__temp__1720000000000");

// ── 7. previousPeriodKey ──
assert("previousPeriod 年度", L.previousPeriodKey("year", "2026") === "2025");
assert("previousPeriod 學年度", L.previousPeriodKey("academic", "115") === "114");
assert("previousPeriod 臨時回 null", L.previousPeriodKey("temp", "1720000000000") === null);
assert("previousPeriod 非數字回 null", L.previousPeriodKey("year", "abc") === null);

// ── 8. 舊集合相容映射 ──
{
  const s = L.legacyYearScheduleToIndicatorSchedule({
    indicatorId: "QI-001",
    year: 2026,
    months: [1, 7],
    caseCount: 5,
    notes: "n",
    updatedAt: null,
  });
  assert("舊映射 category='year'", s.category === "year");
  assert("舊映射 period='2026'", s.period === "2026");
  assert("舊映射 periodLabel", s.periodLabel === "2026年度");
  assert("舊映射 months", eq(s.months, [1, 7]));
  assert("舊映射 caseCount", s.caseCount === 5);
  assert("舊映射 unitIds 空陣列", eq(s.unitIds, []));
  assert("舊映射 selfReview=false", s.selfReview === false);
  assert("舊映射 updatedBy 空", s.updatedBy === "" && s.updatedByName === "");
  assert("舊映射缺 year→null", L.legacyYearScheduleToIndicatorSchedule({ indicatorId: "QI-001" }) === null);
}

// ── 9. parseIndicatorSchedule／parse 輔助 ──
{
  const s = L.parseIndicatorSchedule({
    indicatorId: "QI-002",
    category: "academic",
    period: "115",
    months: [8, 13, 0, 8, "x"],
    caseCount: 3,
    unitIds: ["U1", 42],
    notes: "memo",
    selfReview: true,
    updatedBy: "A01",
    updatedByName: "王小明",
    updatedAt: null,
  });
  assert("parse 保留欄位", s.indicatorId === "QI-002" && s.category === "academic" && s.period === "115");
  assert("parse 過濾非法月份並排序去重", eq(s.months, [8]));
  assert("parse unitIds 過濾非字串", eq(s.unitIds, ["U1"]));
  assert("parse 缺 periodLabel 自動補", s.periodLabel === "115學年度");
  assert("parse 非法 category→null", L.parseIndicatorSchedule({ indicatorId: "X", category: "nope", period: "2026" }) === null);
  assert("parse 缺 indicatorId→null", L.parseIndicatorSchedule({ category: "year", period: "2026" }) === null);
  assert("parseScheduleCategory 合法", L.parseScheduleCategory("temp") === "temp");
  assert("parseScheduleCategory 非法→null", L.parseScheduleCategory("year2") === null);
}

// ── 10. statsCycle 系統參數 ──
assert("statsCycle 預設 'year'", L.DEFAULT_SYSTEM_PARAMS.statsCycle === "year");
assert("statsCycle 標籤", L.SYSTEM_PARAM_LABELS.statsCycle === "統計週期");
{
  const opts = L.SYSTEM_PARAM_SELECT_OPTIONS.statsCycle;
  assert("statsCycle 下拉有兩選項", Array.isArray(opts) && opts.length === 2);
  assert("statsCycle 選項值", eq(opts.map((o) => o.value), ["year", "academic"]));
  assert("statsCycle 選項標籤", eq(opts.map((o) => o.label), ["年度", "學年度"]));
}

// ── 11. 召集人權限 ──
assert("召集人 manageSchedule=true", L.DEFAULT_ROLE_PERMS["召集人"]?.manageSchedule === true);
assert("召集人 resultQuery=true", L.DEFAULT_ROLE_PERMS["召集人"]?.resultQuery === true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
