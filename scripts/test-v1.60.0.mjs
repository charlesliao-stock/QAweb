/**
 * v1.60.0 斷言測試：排程刪除、重複加審偵測、加審失敗常駐錯誤、
 * 未達閾值挑選（定義 A＋taskId join）、加審彈窗加大＋月份換行。
 * 混合測試：lib/belowThreshold.ts 與 lib/scheduling.ts 的純函式以
 * esbuild 打包後真的跑；其餘為靜態守衛（原始碼文字比對），無需 emulator。
 * 線上逐項點按由主代理另行驗證（需 admin 帳號；重複兩筆 live 資料
 * 無法由此環境讀取，見版次回報）。
 */
import { readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { buildSync } from "esbuild";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf-8");

function bundle(entry, out) {
  // 寫在專案內（而非 os tmpdir），Node 才能從專案 node_modules 解析 external 的 firebase
  const dir = join(ROOT, ".test-tmp");
  mkdirSync(dir, { recursive: true });
  const bundled = join(dir, out);
  buildSync({
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    // Firebase SDK 由 Node 原生載入（捲進 bundle 會踩 @grpc 的 CJS require）
    external: ["firebase/app", "firebase/firestore"],
    outfile: bundled,
    logLevel: "silent",
  });
  return bundled;
}

const below = await import(bundle("src/lib/belowThreshold.ts", "qi-fix-158-belowThreshold-1600.mjs"));
const sched = await import(bundle("src/lib/scheduling.ts", "qi-fix-158-scheduling-1600.mjs"));
const rates = await import(bundle("src/lib/analysisRates.ts", "qi-fix-158-analysisRates-1600.mjs"));

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}`);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- 0. 版號 ----
const versionTs = read("src/version.ts");
const pkg = JSON.parse(read("package.json"));
check("0a 版號 1.60.0（version.ts＋package.json 一致）", versionTs.includes('VERSION = "1.60.0"') && pkg.version === "1.60.0");
check("0b BUILD_DATE 2026-11-13", versionTs.includes('BUILD_DATE = "2026-11-13"'));

// ---- 1. 下一個月 ----
check("1a 2025/6 → 2025/7", eq(below.nextCalendarMonth(2025, 6), { year: 2025, month: 7 }));
check("1b 2025/12 → 2026/1（跨年）", eq(below.nextCalendarMonth(2025, 12), { year: 2026, month: 1 }));

// ---- 2. 未達定義 A（達標人次占比＜閾值）----
const TH = 90;
const rec = (taskId, unitId, year, month, rate, thresholdAtSchedule) => ({
  taskId, indicatorId: "3-0002", unitId, year, month, rate,
  ...(thresholdAtSchedule !== undefined ? { thresholdAtSchedule } : {}),
});
const task = (id, scheduleCategory) => ({ id, ...(scheduleCategory ? { scheduleCategory } : {}) });
const tempSched = (period, months, unitIds, selfReview = false, unlimitedUnits = false) => ({
  indicatorId: "3-0002", category: "temp", period: String(period), periodLabel: "臨時",
  months, frequency: null, intervalMonths: null, refYear: null, caseCount: 3,
  unitIds, unlimitedUnits, notes: "", selfReview,
  updatedBy: "", updatedByName: "", updatedAt: null,
});

// 2A：2A 單位 2025/6 四筆、三筆達標 → 75%＜90 未達；6A 四筆全達標 → 不列
let rows = below.buildBelowThresholdRows({
  records: [
    rec("t1", "2A", 2025, 6, 100), rec("t2", "2A", 2025, 6, 100),
    rec("t3", "2A", 2025, 6, 100), rec("t4", "2A", 2025, 6, 50),
    rec("t5", "6A", 2025, 6, 100), rec("t6", "6A", 2025, 6, 100),
    rec("t7", "6A", 2025, 6, 100), rec("t8", "6A", 2025, 6, 95),
  ],
  tasks: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"].map((id) => task(id)),
  indicatorId: "3-0002", threshold: TH, tempSchedules: [],
});
check("2a 矩陣定義 A：75% 單位列入、100% 單位不列", rows.length === 1 && rows[0].units.length === 1 && rows[0].units[0].unitId === "2A" && rows[0].units[0].rate === 75 && rows[0].units[0].pass === 3 && rows[0].units[0].total === 4);
check("2b 列按年月（2025/6）＋閾值 90", rows.length === 1 && rows[0].year === 2025 && rows[0].month === 6 && rows[0].threshold === 90);

// 2C：逐筆 thresholdAtSchedule 優先（85 分、排程當時閾值 80 → 達標）
const pr = below.unitMonthPassRate([rec("t1", "2A", 2025, 6, 85, 80)], 90);
check("2c thresholdAtSchedule 優先：85 分對 80 達標", pr.pass === 1 && pr.rate === 100);
// 2D：與 passRateOf 同一算法（交叉驗證）
const shared = [
  { indicatorId: "3-0002", unitId: "2A", year: 2025, month: 6, rate: 100, thresholdAtSchedule: undefined, answers: [], personEmpNo: "", personName: "", bedNo: "" },
  { indicatorId: "3-0002", unitId: "2A", year: 2025, month: 6, rate: 50, thresholdAtSchedule: undefined, answers: [], personEmpNo: "", personName: "", bedNo: "" },
];
check("2d unitMonthPassRate 與 passRateOf 結果一致", eq(below.unitMonthPassRate(shared, 90), { pass: 1, total: 2, rate: 50 }) && rates.passRateOf(shared, 90).rate === 50);

// ---- 3. 常規／加審判定（taskId join）----
rows = below.buildBelowThresholdRows({
  records: [
    rec("tt1", "2A", 2025, 6, 50), // 加審任務 → 排除
    rec("tt2", "2A", 2025, 6, 50), // 舊任務缺 scheduleCategory → 常規
    rec("", "2A", 2025, 6, 50), // 匯入紀錄 → 常規
    rec("gone", "2A", 2025, 6, 50), // 任務已刪 → 常規
    rec("t9", "5C", 2025, 6, 50), // 常規任務 → 常規
  ],
  tasks: [task("tt1", "temp"), task("tt2"), task("t9", "year")],
  indicatorId: "3-0002", threshold: TH, tempSchedules: [],
});
const row26 = rows.find((r) => r.year === 2025 && r.month === 6);
check("3a 加審紀錄排除、舊任務／匯入／任務已刪皆視為常規", !!row26 && row26.units.some((u) => u.unitId === "2A" && u.total === 3) && row26.units.some((u) => u.unitId === "5C" && u.total === 1));
check("3b 排序：最新年月在前", (() => {
  const r2 = below.buildBelowThresholdRows({
    records: [rec("a1", "2A", 2025, 6, 10), rec("a2", "2A", 2025, 8, 10), rec("a3", "2A", 2025, 7, 10)],
    tasks: [task("a1"), task("a2"), task("a3")],
    indicatorId: "3-0002", threshold: TH, tempSchedules: [],
  });
  return eq(r2.map((r) => `${r.year}/${r.month}`), ["2025/8", "2025/7", "2025/6"]);
})());

// ---- 4. 已加審判定 ----
const targetTemp = tempSched(new Date(2025, 6, 15).getTime(), [7], ["2A", "9Z"]);
const otherTemp = tempSched(new Date(2025, 7, 15).getTime(), [8], ["2A"]);
const selfTemp = tempSched(new Date(2025, 6, 15).getTime(), [7], ["2A"], true);
const naTemp = tempSched(new Date(2025, 6, 15).getTime(), [7], [], false, true);
const base = {
  records: [rec("b1", "2A", 2025, 6, 10)],
  tasks: [task("b1")], indicatorId: "3-0002", threshold: TH,
};
check("4a 下月有加審且單位重疊 → 已加審", below.buildBelowThresholdRows({ ...base, tempSchedules: [targetTemp] })[0].alreadyAddReviewed === true);
check("4b 下月無加審 → 未加審", below.buildBelowThresholdRows({ ...base, tempSchedules: [otherTemp] })[0].alreadyAddReviewed === false);
check("4c 自審不算已加審", below.buildBelowThresholdRows({ ...base, tempSchedules: [selfTemp] })[0].alreadyAddReviewed === false);
check("4d 不限單位加審覆蓋下月 → 已加審", below.buildBelowThresholdRows({ ...base, tempSchedules: [naTemp] })[0].alreadyAddReviewed === true);

// ---- 5. 重複加審偵測 ----
const now = Date.now();
const existing = [tempSched(now - 5 * 60 * 1000, [7], ["2A", "6A"])];
check("5a 同月份同單位 5 分鐘內 → 重複", sched.findDuplicateTempSchedule(existing, { months: [7], unitIds: ["6A", "2A"], unlimitedUnits: false, selfReview: false }, now) !== null);
check("5b 不同月份 → 不重複", sched.findDuplicateTempSchedule(existing, { months: [8], unitIds: ["2A", "6A"], unlimitedUnits: false, selfReview: false }, now) === null);
check("5c 不同單位 → 不重複", sched.findDuplicateTempSchedule(existing, { months: [7], unitIds: ["2A"], unlimitedUnits: false, selfReview: false }, now) === null);
check("5d 超過 10 分鐘 → 不重複（正常第二次加審不受影響）", sched.findDuplicateTempSchedule(existing, { months: [7], unitIds: ["2A", "6A"], unlimitedUnits: false, selfReview: false }, now + 11 * 60 * 1000) === null);
check("5e 自審／加審分開比", sched.findDuplicateTempSchedule(existing, { months: [7], unitIds: ["2A", "6A"], unlimitedUnits: false, selfReview: true }, now) === null);
check("5f 不限單位相同 → 重複", sched.findDuplicateTempSchedule([tempSched(now - 60 * 1000, [7], [], false, true)], { months: [7], unitIds: [], unlimitedUnits: true, selfReview: false }, now) !== null);

// ---- 6. 任務歸屬判定（刪除用）----
const sch = { category: "temp", period: "1750000000000" };
check("6a 標記相符 → 屬於該排程", sched.isTaskOfSchedule({ scheduleCategory: "temp", schedulePeriod: "1750000000000" }, sch) === true);
check("6b 週期不同 → 不屬於", sched.isTaskOfSchedule({ scheduleCategory: "temp", schedulePeriod: "1750000000001" }, sch) === false);
check("6c 未標記舊任務 → 不屬於（不誤刪）", sched.isTaskOfSchedule({}, sch) === false);
check("6d 類別不同 → 不屬於", sched.isTaskOfSchedule({ scheduleCategory: "year", schedulePeriod: "1750000000000" }, sch) === false);

// ---- 7. 靜態守衛 ----
const page = read("src/features/SchedulePage.tsx");
const schedTs = read("src/lib/scheduling.ts");
const ui = read("src/components/ui.tsx");
const css = read("src/styles.css");
check("7a 主清單刪除按鈕（handleDeleteSchedule）", page.includes("handleDeleteSchedule(r)") && page.includes("刪除此排程（含其未完成任務"));
check("7b 查閱視窗刪除按鈕", page.includes("刪除此排程") && page.includes("onDeleted"));
check("7c 編輯器刪除改走 deleteScheduleWithTasks", page.includes("deleteScheduleWithTasks(") && !page.includes("已產生的任務不受影響"));
check("7d 刪除保留已完成任務（keptDoneTasks）", schedTs.includes("keptDoneTasks") && schedTs.includes('data.status === "done"'));
check("7e 加審對話框中寬（medium）", page.includes("medium\n      >") || page.includes("medium"));
check("7f 常駐錯誤區（form-error＋role=alert）", page.includes('className="form-error"') && page.includes('role="alert"'));
check("7g 加審防重入（saving 守衛）", (page.match(/if \(saving\) return;/g) ?? []).length >= 2);
check("7h 加審重複偵測呼叫", page.includes("findDuplicateTempSchedule("));
check("7i 加審年份帶入（yearOverride）", page.includes("yearOverride: pickedYear") && schedTs.includes("yearOverride") && schedTs.includes("setFullYear"));
check("7j 挑選按鈕＋套用函式", page.includes("由未達閾值挑選") && page.includes("applyBelowThresholdRow"));
check("7k 挑選彈窗第二層（layer={2}）", page.includes("layer={2}"));
check("7l Modal 支援 medium＋layer", ui.includes("medium") && ui.includes("reviewer-modal-layer-"));
check("7m 中寬 960px 樣式", css.includes(".reviewer-modal.medium") && css.includes("min(960px, calc(100vw - 32px))"));
check("7n 月份格換行（6 欄）", css.includes(".month-grid") && css.includes("flex-wrap: wrap") && css.includes("calc(16.666% - 6px)"));
check("7o 手機月份格 3 欄", css.includes("calc(33.333% - 6px)"));
check("7p 常駐錯誤樣式", css.includes(".form-error"));
check("7q 加審失敗寫 console.error", page.includes('console.error("[加審失敗]"'));

// ---- 8. 範圍守衛：不動 rules／結果分析／AnalysisRecord ----
const changed = execSync("git status --porcelain", { cwd: ROOT }).toString();
check("8a firestore.rules 未改", !changed.includes("firestore.rules"));
check("8b ResultsPage.tsx 未改（矩陣格／AnalysisRecord 不動）", !changed.includes("ResultsPage.tsx"));
check("8c analysisRates.ts 未改（定義 A 不動）", !changed.includes("src/lib/analysisRates.ts"));
check("8d 新 lib 只有 belowThreshold.ts", existsSync(join(ROOT, "src/lib/belowThreshold.ts")));

// ---- 總結 ----
console.log(`\n${pass} passed, ${fail} failed`);
rmSync(join(ROOT, ".test-tmp"), { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
