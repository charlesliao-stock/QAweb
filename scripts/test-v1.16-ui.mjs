/**
 * v1.16.0 UI 層斷言測試：SchedulePage 導出的純函式（pill 判定／期間自動偵測／
 * 加審預覽任務數／自審預設值）＋統計週期聚合（resultAnalysis／dashboardStats）。
 * 用 esbuild 打包後在 jsdom 全域環境下執行；import.meta.env 以 {} 墊掉
 *（firebase.ts 模組頂層讀取，node 下無此物件）。
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
  schedulePillState, assignmentPillState, previewTempTaskCount,
  defaultPeriodForStatsCycle, defaultSelfAuditReviewers, defaultAddAuditReviewers,
} from "${ROOT}/src/features/SchedulePage";
import { monthlyTrend, indicatorMonthStats } from "${ROOT}/src/lib/resultAnalysis";
import { unitMonthAvgs, declineAlerts, cycleMonthLabel } from "${ROOT}/src/lib/dashboardStats";
import { academicYearOf, monthToCalendarYear } from "${ROOT}/src/lib/cycle";
export {
  schedulePillState, assignmentPillState, previewTempTaskCount,
  defaultPeriodForStatsCycle, defaultSelfAuditReviewers, defaultAddAuditReviewers,
  monthlyTrend, indicatorMonthStats, unitMonthAvgs, declineAlerts, cycleMonthLabel,
  academicYearOf, monthToCalendarYear,
};
`;
writeFileSync("/tmp/v116-ui-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v116-ui-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v116-ui-test-bundle.cjs",
  logLevel: "silent",
  define: { "import.meta.env": "{}" },
});
const require2 = createRequire("/tmp/v116-ui-test-bundle.cjs");
const L = require2("/tmp/v116-ui-test-bundle.cjs");

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

/* ---------- 1. pill 判定邏輯 ---------- */
const schedFull = {
  indicatorId: "i1", category: "year", period: "2026", periodLabel: "2026年度",
  months: [1, 7], caseCount: 5, unitIds: ["u1", "u2"], notes: "",
  selfReview: false, updatedBy: "x", updatedByName: "X", updatedAt: null,
};
assert("pill：有排程且單位非空→done", L.schedulePillState(schedFull) === "done");
assert("pill：排程單位為空→none", L.schedulePillState({ ...schedFull, unitIds: [] }) === "none");
assert("pill：無排程→none", L.schedulePillState(null) === "none");
assert("pill：分工表有項目→done",
  L.assignmentPillState({ indicatorId: "i1", items: [{ reviewerId: "r1", units: [{ unitId: "u1", caseCount: null }] }], updatedAt: null }) === "done");
assert("pill：分工表空→none",
  L.assignmentPillState({ indicatorId: "i1", items: [], updatedAt: null }) === "none");
assert("pill：分工表 null→none", L.assignmentPillState(null) === "none");
assert("pill：分工表 undefined→none", L.assignmentPillState(undefined) === "none");

/* ---------- 2. 期間自動偵測 ---------- */
assert("期間：statsCycle=year→今年", L.defaultPeriodForStatsCycle("year", D(2026, 11, 5)) === "2026");
assert("期間：academic＋2026-11→115", L.defaultPeriodForStatsCycle("academic", D(2026, 11, 5)) === "115");
assert("期間：academic＋2027-03→115", L.defaultPeriodForStatsCycle("academic", D(2027, 3, 15)) === "115");
assert("期間：academic＋2027-08→116", L.defaultPeriodForStatsCycle("academic", D(2027, 8, 1)) === "116");

/* ---------- 3. 加審預覽任務數 ---------- */
assert("預覽：2月×3單位×2審核員＝12", L.previewTempTaskCount([1, 7], ["u1", "u2", "u3"], ["r1", "r2"]) === 12);
assert("預覽：月份為空→0", L.previewTempTaskCount([], ["u1"], ["r1"]) === 0);
const asg = {
  indicatorId: "i1",
  items: [
    { reviewerId: "r1", units: [{ unitId: "u1", caseCount: null }, { unitId: "u2", caseCount: null }] },
    { reviewerId: "r2", units: [{ unitId: "u3", caseCount: null }] },
  ],
  updatedAt: null,
};
assert("加審預設審核員：選 u1→r1", eq(L.defaultAddAuditReviewers(asg, ["u1"]), ["r1"]));
assert("加審預設審核員：選 u1,u3→r1,r2", eq(L.defaultAddAuditReviewers(asg, ["u1", "u3"]), ["r1", "r2"]));
assert("加審預設審核員：無分工表→空", eq(L.defaultAddAuditReviewers(null, ["u1"]), []));

/* ---------- 4. 自審預設值 ---------- */
const users = [
  { id: "a", unitCode: "u1", status: "在職" },
  { id: "b", unitCode: "u1", status: "停用" },
  { id: "c", unitCode: "u2", status: "在職" },
];
assert("自審預設：同單位在職者（排除停用）", eq(L.defaultSelfAuditReviewers(users, "u1"), ["a"]));
assert("自審預設：無人→空", eq(L.defaultSelfAuditReviewers(users, "u9"), []));

/* ---------- 5. 趨勢 x 軸排序 ---------- */
const recs = [
  { taskId: "t1", indicatorId: "i1", unitId: "u1", year: 2026, month: 9, rate: 90 },
  { taskId: "t2", indicatorId: "i1", unitId: "u1", year: 2026, month: 8, rate: 80 },
  { taskId: "t3", indicatorId: "i1", unitId: "u1", year: 2027, month: 1, rate: 95 },
  { taskId: "t4", indicatorId: "i1", unitId: "u1", year: 2026, month: 7, rate: 70 }, // 學年度114，應排除
  { taskId: "t5", indicatorId: "i2", unitId: "u1", year: 2026, month: 8, rate: 60 }, // 不同指標，應排除
];
const ptsA = L.monthlyTrend(recs, "i1", "academic", "115");
assert("趨勢學年度：月份順序 [8,9,1]", eq(ptsA.map((p) => p.month), [8, 9, 1]));
assert("趨勢學年度：標籤如 115-08", eq(ptsA.map((p) => p.label), ["115-08", "115-09", "115-01"]));
assert("趨勢學年度：排除他期(114-07)與他指標", ptsA.length === 3);
const ptsY = L.monthlyTrend(recs, "i1", "year", "2026");
assert("趨勢年度：月份順序 7,8,9", eq(ptsY.map((p) => p.month), [7, 8, 9]));
assert("趨勢年度：標籤維持 N月", eq(ptsY.map((p) => p.label), ["7月", "8月", "9月"]));

/* ---------- 6. indicatorMonthStats 按週期鍵分組 ---------- */
const atasks = [
  { id: "a", indicatorId: "i1", unitId: "u1", reviewerId: "r", year: 2026, month: 1, caseCount: 5 },
  { id: "b", indicatorId: "i1", unitId: "u2", reviewerId: "r", year: 2027, month: 1, caseCount: 5 },
];
const th = new Map([["i1", 90]]);
const statsA = L.indicatorMonthStats(atasks, [], 2026, 1, th, "academic");
assert("統計學年度：2026-01 歸戶 114-01（不含 2027-01）",
  statsA.length === 1 && statsA[0].totalUnits === 1);
const statsA2 = L.indicatorMonthStats(atasks, [], 2027, 1, th, "academic");
assert("統計學年度：2027-01 歸戶 115-01（一單位）",
  statsA2.length === 1 && statsA2[0].totalUnits === 1);
const statsY = L.indicatorMonthStats(atasks, [], 2026, 1, th, "year");
assert("統計年度：只取 2026-01（一單位）",
  statsY.length === 1 && statsY[0].totalUnits === 1);

/* ---------- 7. dashboardStats 週期標籤 ---------- */
assert("cycleMonthLabel 學年度", L.cycleMonthLabel(2026, 8, "academic") === "115-08");
assert("cycleMonthLabel 年度", L.cycleMonthLabel(2026, 8, "year") === "2026-08");
const drecs = [
  { id: "x", taskId: "t", indicatorId: "i", unitId: "u1", year: 2026, month: 8, reviewDate: "", reviewerName: "", reviewedPersonEmpNo: "", reviewedPersonName: "", rate: 80, answers: [], submittedAt: null },
];
const umr = L.unitMonthAvgs(drecs, ["2026-08"], "academic");
assert("unitMonthAvgs 學年度輸出 ym=115-08",
  umr.length === 1 && umr[0].ym === "115-08" && umr[0].avg === 80);
const drows = [
  { unitId: "u1", ym: "115-08", avg: 95 },
  { unitId: "u1", ym: "115-09", avg: 90 },
  { unitId: "u1", ym: "115-10", avg: 85 },
];
const alerts = L.declineAlerts(drows, ["115-08", "115-09", "115-10"], 90);
assert("declineAlerts 週期月標籤可判連續下滑",
  alerts.length === 1 && alerts[0].kind === "decline" && alerts[0].unitId === "u1");

/* ---------- 8. 曆年換算（查閱／產生排程用） ---------- */
assert("學年度115：8月→2026", L.monthToCalendarYear("academic", "115", 8) === 2026);
assert("學年度115：1月→2027", L.monthToCalendarYear("academic", "115", 1) === 2027);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
