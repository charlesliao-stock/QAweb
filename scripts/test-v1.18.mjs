/**
 * v1.18.0 斷言測試：排程改版純函式（年份選項／週期鍵／頻次區間自動預選月份／
 * 設定完成判定／分工表合併）＋排程 pill 嚴格化。
 * 用 esbuild 打包後在 jsdom 全域環境下執行。
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
import {
  YEAR_FILTER_OPTIONS, yearOptionLabel, periodForFilter,
  autoSelectMonths, parseFrequency, parseIntervalMonths,
  frequencyLabel, intervalLabel, scheduleSetupComplete,
  FREQUENCY_OPTIONS, INTERVAL_OPTIONS,
} from "${ROOT}/src/lib/scheduling";
import { schedulePillState, mergeItemsWithUnits } from "${ROOT}/src/features/SchedulePage";
export {
  YEAR_FILTER_OPTIONS, yearOptionLabel, periodForFilter,
  autoSelectMonths, parseFrequency, parseIntervalMonths,
  frequencyLabel, intervalLabel, scheduleSetupComplete,
  FREQUENCY_OPTIONS, INTERVAL_OPTIONS,
  schedulePillState, mergeItemsWithUnits,
};
`;
writeFileSync("/tmp/v118-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v118-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v118-test-bundle.cjs",
  logLevel: "silent",
  define: { "import.meta.env": "{}" },
});
const require2 = createRequire("/tmp/v118-test-bundle.cjs");
const L = require2("/tmp/v118-test-bundle.cjs");

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
const YEAR_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const ACAD_ORDER = [8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7];

/* ---------- 1. 年份篩選 ---------- */
assert("年份選項共 10 年", L.YEAR_FILTER_OPTIONS.length === 10);
assert(
  "年份選項 2024～2033",
  L.YEAR_FILTER_OPTIONS[0] === 2024 &&
    L.YEAR_FILTER_OPTIONS[9] === 2033,
);
assert("年份標籤 2024→「2024 (113)」", L.yearOptionLabel(2024) === "2024 (113)");
assert("年份標籤 2033→「2033 (122)」", L.yearOptionLabel(2033) === "2033 (122)");

/* ---------- 2. 週期鍵 ---------- */
assert("年度 2026→「2026」", L.periodForFilter("year", 2026) === "2026");
assert("學年度 2026→「115」", L.periodForFilter("academic", 2026) === "115");
assert("學年度 2033→「122」", L.periodForFilter("academic", 2033) === "122");

/* ---------- 3. 頻次／區間自動預選月份 ---------- */
assert(
  "4次/年＋3個月＋年度→[1,4,7,10]",
  eq(L.autoSelectMonths(4, 3, YEAR_ORDER), [1, 4, 7, 10]),
);
assert(
  "3次/年＋4個月＋年度→[1,5,9]",
  eq(L.autoSelectMonths(3, 4, YEAR_ORDER), [1, 5, 9]),
);
assert(
  "2次/年＋2個月＋年度→[1,3]",
  eq(L.autoSelectMonths(2, 2, YEAR_ORDER), [1, 3]),
);
assert(
  "4次/年＋3個月＋學年度→[2,5,8,11]",
  eq(L.autoSelectMonths(4, 3, ACAD_ORDER), [2, 5, 8, 11]),
);
assert(
  "3次/年＋2個月＋學年度→[8,10,12]",
  eq(L.autoSelectMonths(3, 2, ACAD_ORDER), [8, 10, 12]),
);
assert(
  "2次/年＋4個月＋學年度→[8,12]",
  eq(L.autoSelectMonths(2, 4, ACAD_ORDER), [8, 12]),
);

/* ---------- 4. 頻次／區間解析與標籤 ---------- */
assert("parseFrequency(4)＝4", L.parseFrequency(4) === 4);
assert("parseFrequency(5)＝null", L.parseFrequency(5) === null);
assert("parseFrequency('4')＝null", L.parseFrequency("4") === null);
assert("parseIntervalMonths(2)＝2", L.parseIntervalMonths(2) === 2);
assert("parseIntervalMonths(1)＝null", L.parseIntervalMonths(1) === null);
assert("frequencyLabel(4)＝4次/年", L.frequencyLabel(4) === "4次/年");
assert("intervalLabel(3)＝3個月", L.intervalLabel(3) === "3個月");
assert(
  "頻次選項 [2,3,4]",
  eq(L.FREQUENCY_OPTIONS, [2, 3, 4]),
);
assert("區間選項 [2,3,4]", eq(L.INTERVAL_OPTIONS, [2, 3, 4]));

/* ---------- 5. 設定完成判定 ---------- */
const fullSched = { unitIds: ["u1"], months: [1, 4], caseCount: 5 };
assert("設定完成：單位＋月份＋件數→true", L.scheduleSetupComplete(fullSched) === true);
assert(
  "設定完成：單位為空→false",
  L.scheduleSetupComplete({ ...fullSched, unitIds: [] }) === false,
);
assert(
  "設定完成：月份為空→false",
  L.scheduleSetupComplete({ ...fullSched, months: [] }) === false,
);
assert(
  "設定完成：件數 null→false",
  L.scheduleSetupComplete({ ...fullSched, caseCount: null }) === false,
);
assert(
  "設定完成：件數 0→false",
  L.scheduleSetupComplete({ ...fullSched, caseCount: 0 }) === false,
);
assert("設定完成：null→false", L.scheduleSetupComplete(null) === false);

/* ---------- 6. 排程 pill 嚴格化（v1.18：件數納入） ---------- */
const pillFull = {
  indicatorId: "i1",
  category: "year",
  period: "2026",
  periodLabel: "2026年度",
  months: [1, 4],
  frequency: 4,
  intervalMonths: 3,
  refYear: null,
  caseCount: 5,
  unitIds: ["u1"],
  notes: "",
  selfReview: false,
  updatedBy: "x",
  updatedByName: "X",
  updatedAt: null,
};
assert("pill：設定完成→done", L.schedulePillState(pillFull) === "done");
assert(
  "pill：件數 null→none",
  L.schedulePillState({ ...pillFull, caseCount: null }) === "none",
);
assert(
  "pill：月份為空→none",
  L.schedulePillState({ ...pillFull, months: [] }) === "none",
);
assert(
  "pill：單位為空→none",
  L.schedulePillState({ ...pillFull, unitIds: [] }) === "none",
);
assert("pill：null→none", L.schedulePillState(null) === "none");

/* ---------- 7. 分工表合併 ---------- */
const prev = [
  {
    reviewerId: "r1",
    units: [{ unitId: "u1", caseCount: 5 }],
  },
];
const merged = L.mergeItemsWithUnits(prev, ["r1", "r2"], ["u1", "u2"]);
assert(
  "合併：r1 保留 u1 件數 5 並新增 u2",
  eq(merged.find((x) => x.reviewerId === "r1")?.units, [
    { unitId: "u1", caseCount: 5 },
    { unitId: "u2", caseCount: null },
  ]),
);
assert(
  "合併：r2 新增兩單位（件數 null）",
  eq(merged.find((x) => x.reviewerId === "r2")?.units, [
    { unitId: "u1", caseCount: null },
    { unitId: "u2", caseCount: null },
  ]),
);
assert(
  "合併：依 reviewerId 排序",
  eq(
    merged.map((x) => x.reviewerId),
    ["r1", "r2"],
  ),
);
assert(
  "合併：空表新增",
  L.mergeItemsWithUnits([], ["r9"], ["u9"]).length === 1,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
