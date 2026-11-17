/**
 * v1.59.0 斷言測試：自審／加審標示分流（A1／A2／B4）、審查區間單月特例與
 * 臨時連續分組（B2）、B3 角色範圍過濾無洩漏（驗證、不改程式）、
 * 曲線圖加審標註（C）、曲線圖未達閾值點標紅（追加）。
 * 混合測試：reviewActive.ts／tempChartNote.ts／analysisRates.ts 以 esbuild
 * 打包後真的跑純函式；其餘為靜態守衛（原始碼文字比對），無需 emulator。
 * 線上逐項點按由主代理另行驗證。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildSync } from "esbuild";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf-8");

function bundle(entry, out) {
  const bundled = join(tmpdir(), out);
  buildSync({
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: bundled,
    logLevel: "silent",
  });
  return bundled;
}

const { intervalDisplay } = await import(
  bundle("src/lib/reviewActive.ts", "qi-fix-158-reviewActive-159.mjs")
);
const { buildTempTaskKeys, columnTempNote } = await import(
  bundle("src/lib/tempChartNote.ts", "qi-fix-158-tempChartNote-159.mjs")
);
const { isPassing } = await import(
  bundle("src/lib/analysisRates.ts", "qi-fix-158-analysisRates-159.mjs")
);

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

const versionTs = read("src/version.ts");
const pkg = JSON.parse(read("package.json"));
const sched = read("src/features/SchedulePage.tsx");
const audit = read("src/features/AuditPage.tsx");
const results = read("src/features/ResultsPage.tsx");
const trend = read("src/components/TrendChart.tsx");
const css = read("src/styles.css");
const reviewActive = read("src/lib/reviewActive.ts");

// ---- 0. 版號 ----
check(
  "版號 1.59.0 一致",
  versionTs.includes('VERSION = "1.59.0"') && pkg.version === "1.59.0",
);

// ---- B2. intervalDisplay ----
const iv = (start, end, reviewMonths) => ({
  start,
  end,
  reviewMonths,
  allMonths: reviewMonths,
});
check(
  "B2 單月（年度）2026/11",
  intervalDisplay(iv({ year: 2026, month: 11 }, { year: 2026, month: 11 }, [{ year: 2026, month: 11 }]), "year") === "2026/11",
);
check(
  "B2 單月（學年度）2026/11",
  intervalDisplay(iv({ year: 2026, month: 11 }, { year: 2026, month: 11 }, [{ year: 2026, month: 11 }]), "academic") === "2026/11",
);
check(
  "B2 同年多月 2026/1-3",
  intervalDisplay(iv({ year: 2026, month: 1 }, { year: 2026, month: 3 }, [{ year: 2026, month: 1 }, { year: 2026, month: 3 }]), "year") === "2026/1-3",
);
check(
  "B2 跨年不動 2026/11-2027/1",
  intervalDisplay(iv({ year: 2026, month: 11 }, { year: 2027, month: 1 }, [{ year: 2026, month: 11 }, { year: 2027, month: 1 }]), "year") === "2026/11-2027/1",
);
check(
  "B2 臨時連續 2026/3-5",
  intervalDisplay(
    iv({ year: 2026, month: 3 }, { year: 2026, month: 5 }, [3, 4, 5].map((m) => ({ year: 2026, month: m }))),
    "temp",
  ) === "2026/3-5",
);
check(
  "B2 臨時不連續 2026/3、2026/5（每組完整年月）",
  intervalDisplay(
    iv({ year: 2026, month: 3 }, { year: 2026, month: 5 }, [3, 5].map((m) => ({ year: 2026, month: m }))),
    "temp",
  ) === "2026/3、2026/5",
);
check(
  "B2 臨時跨年連續 2026/12-2027/1",
  intervalDisplay(
    iv({ year: 2026, month: 12 }, { year: 2027, month: 1 }, [{ year: 2026, month: 12 }, { year: 2027, month: 1 }]),
    "temp",
  ) === "2026/12-2027/1",
);
check(
  "B2 臨時單月 2026/3",
  intervalDisplay(iv({ year: 2026, month: 3 }, { year: 2026, month: 3 }, [{ year: 2026, month: 3 }]), "temp") === "2026/3",
);
check(
  "B2 臨時混合 2026/3-4、2026/6、2026/8",
  intervalDisplay(
    iv({ year: 2026, month: 3 }, { year: 2026, month: 8 }, [3, 4, 6, 8].map((m) => ({ year: 2026, month: m }))),
    "temp",
  ) === "2026/3-4、2026/6、2026/8",
);
check(
  "B2 臨時未排序輸入仍正確分組",
  intervalDisplay(
    iv({ year: 2026, month: 3 }, { year: 2026, month: 5 }, [5, 3].map((m) => ({ year: 2026, month: m }))),
    "temp",
  ) === "2026/3、2026/5",
);
check(
  "B2 舊臨時列舉 2026/3、5 已消失",
  !reviewActive.includes('ms.join("、")'),
);

// ---- C. tempChartNote 純函式 ----
const selfKeys = new Set(["IND1|111"]);
const tasks = [
  { indicatorId: "IND1", year: 2026, month: 3, unitId: "U1", scheduleCategory: "temp", schedulePeriod: "222" },
  { indicatorId: "IND1", year: 2026, month: 5, unitId: "U1", scheduleCategory: "temp", schedulePeriod: "111" },
  { indicatorId: "IND1", year: 2026, month: 4, unitId: "U1", scheduleCategory: "year", schedulePeriod: "2026" },
  { indicatorId: "IND1", year: 2026, month: 6, unitId: "U1", scheduleCategory: "temp" },
  { indicatorId: "IND2", year: 2026, month: 3, unitId: "U1", scheduleCategory: "temp", schedulePeriod: "333" },
];
const keys = buildTempTaskKeys(tasks, selfKeys);
check(
  "C 加審任務建鍵（含 3 月、不含自審 5 月、不含年度 4 月）",
  keys.has("IND1|2026-3|U1") &&
    !keys.has("IND1|2026-5|U1") &&
    !keys.has("IND1|2026-4|U1") &&
    keys.has("IND2|2026-3|U1"),
);
check(
  "C 舊任務缺 period 視為加審（6 月）",
  keys.has("IND1|2026-6|U1"),
);
const rec = (indicatorId, year, month, unitId) => ({ indicatorId, year, month, unitId });
check(
  "C 單月欄含加審紀錄 → （加審）",
  columnTempNote([rec("IND1", 2026, 3, "U1")], keys, 1) === "（加審）",
);
check(
  "C 季欄含加審紀錄 → （有加審）",
  columnTempNote([rec("IND1", 2026, 3, "U1")], keys, 3) === "（有加審）",
);
check(
  "C 半年／年欄含加審紀錄 → （有加審）",
  columnTempNote([rec("IND1", 2026, 3, "U1")], keys, 12) === "（有加審）",
);
check(
  "C 無加審紀錄 → null（一般紀錄不誤標）",
  columnTempNote([rec("IND1", 2026, 4, "U1")], keys, 1) === null,
);
check(
  "C 匯入紀錄對不上任務鍵 → null",
  columnTempNote([rec("IND1", 2026, 3, "U2")], keys, 1) === null,
);
check(
  "C 自審任務月無鍵 → null",
  columnTempNote([rec("IND1", 2026, 5, "U1")], keys, 1) === null,
);
check(
  "C 任務集合為空 → null",
  columnTempNote([rec("IND1", 2026, 3, "U1")], new Set(), 1) === null,
);

// ---- A1. SchedulePage 年別欄／計數／查閱視窗 ----
check(
  "A1 年別欄加審紅字 pill、自審維持 info pill",
  sched.includes('<span className="status-pill danger">加審</span>') &&
    sched.includes('<span className="status-pill info">自審</span>'),
);
check(
  "A1 年別欄不再寫死「臨時」單行＋「{refYear}年加審」小字（查閱視窗的模板字串除外）",
  !sched.includes("{sched.refYear}年加審\n") &&
    !/^\s*臨時\s*$/m.test(sched),
);
check(
  "A1 操作欄「加審 N 筆」，不再寫「臨時 N 筆」",
  sched.includes("加審 {tempCount} 筆") && !sched.includes("臨時 {tempCount} 筆"),
);
check(
  "A1 tempCount 只計 temp 且非自審（自審不計入加審筆數）",
  sched.includes('if (s.category !== "temp" || s.selfReview) continue;'),
);
check(
  "A1 查閱視窗標題 note：加審／自審分流，消除「臨時・臨時」",
  sched.includes('sched.selfReview ? "自審" : "加審"') &&
    !sched.includes('"臨時" : categoryLabel'),
);
check(
  "A1 查閱視窗期間列：只有加審才附（refYear年加審），自審不附",
  sched.includes("!sched.selfReview &&") &&
    sched.includes("（${sched.refYear}年加審）"),
);
check(
  "A1 自審對話框說明同步改為年別欄顯示「自審」標籤",
  sched.includes("清單年別欄顯示「自審」標籤"),
);
check(
  "A1 未改 lib/cycle.ts 全域 categoryLabel（temp 仍回「臨時」）",
  read("src/lib/cycle.ts").includes('if (c === "temp") return "臨時";'),
);

// ---- A2. 只刪排程／單位設定欄細項小字 ----
check(
  "A2 主清單排程欄細項小字已刪（{sched.months.length} 個月・ 不再出現）",
  !sched.includes("{sched.months.length} 個月・"),
);
check(
  "A2 隔壁審查員欄細項小字保留（位審查員・）",
  sched.includes("位審查員・"),
);
check(
  "A2 已排／未排 pill 仍在（主清單）",
  sched.includes("已排") && sched.includes("未排"),
);

// ---- B1／B4. AuditPage ----
check(
  "B1 表頭「審查區間」，「審核區間」表頭已無",
  audit.includes('label="審查區間"') && !audit.includes('label="審核區間"'),
);
check(
  "B1 「審核進度」兩欄不改",
  audit.includes('label="審核進度（人次）"') &&
    audit.includes('label="審核進度（單位次）"'),
);
check(
  "B4 指標名前 badge：加審／自審分流，取代「臨時」",
  audit.includes('selfReview ? "自審" : "加審"') &&
    !audit.includes('<span className="badge">臨時</span>'),
);
check(
  "B4 badge 在指標名稱前方（badge 位置早於 <b>名稱）",
  (() => {
    const b = audit.indexOf('selfReview ? "自審" : "加審"');
    const n = audit.indexOf("<b>{r.indicatorName}</b>", b);
    return b > 0 && n > b;
  })(),
);

// ---- B3. 角色範圍過濾（驗證、不改程式） ----
check(
  "B3 管理員／高階主管全見分支仍在",
  audit.includes("if (isAdmin || isSenior) visible = true;"),
);
check(
  "B3 審查員僅分工表指派單位（reviewerOf）",
  audit.includes("reviewerOf.get(s.indicatorId)?.get(staffId)"),
);
check(
  "B3 護理長僅自審且本人單位在內",
  audit.includes("isHeadNurse &&") &&
    audit.includes("s.selfReview &&") &&
    audit.includes("s.unitIds.includes(user.unitCode)"),
);
check(
  "B3 召集人／執行幹事僅所屬群組",
  audit.includes("myConvenerGroupIds.includes(ind.groupId)"),
);
check(
  "B3 篩選下拉只取已過濾 rows（組別／指標選項源自 rows）",
  audit.includes("rows.forEach((r) => {") &&
    audit.includes("const groupOptions = useMemo") &&
    audit.includes("const indicatorOptions = useMemo"),
);
check(
  "B3 can() 僅用於修改已提交（editSubmitted），未改走 permissionTemplates",
  audit.includes('can("editSubmitted"') && !audit.includes('can("auditView"'),
);

// ---- C. ResultsPage 串接 ----
check(
  "C chartSeries／sectionChartSeries 回傳 notes，tips 同步加註",
  results.includes("notes: (string | null)[]") &&
    results.includes("notes.push(note)"),
);
check(
  "C chartModal 帶 notes（組別分析彈窗曲線）",
  results.includes("notes: (string | null)[];") &&
    results.includes("notes,") &&
    results.includes("notes={chartModal.notes}"),
);
check(
  "C 指標分析 indSummary 帶 chartNotes",
  results.includes("chartNotes") &&
    results.includes("notes={indSummary.chartNotes}"),
);
check(
  "C 單位分析下方曲線帶 notes",
  results.includes("notes={s.notes}"),
);
check(
  "C 三處曲線圖皆接 notes（單位／指標／彈窗）",
  (results.match(/notes=\{/g) ?? []).length === 3,
);
check(
  "C reviewTasks 改為全部身分皆載入（不再只限審查員才查任務表）",
  !results.includes('if (scope.kind === "reviewer") {\n          const taskCached') &&
    results.includes("scheduleCategory:") &&
    results.includes("schedulePeriod:"),
);
check(
  "C 自審排程鍵由 indicatorSchedules 載入（排除自審任務）",
  results.includes('collection(db, "indicatorSchedules")') &&
    results.includes("selfReviewTempKeys"),
);
check(
  "C 不改 AnalysisRecord（未讀取 taskId 進分析紀錄；匯入寫入 taskId: \"\" 維持原樣）",
  !results.includes("taskId: String(v.taskId") &&
    !results.includes("taskId: typeof v.taskId") &&
    results.includes('taskId: "",'),
);

// ---- 追加：曲線圖未達閾值點標紅 ----
check(
  "追加 達標判定沿用 isPassing（rate ≥ 閾值達標）",
  isPassing(90, 90) === true &&
    isPassing(100, 90) === true &&
    isPassing(80, 90) === false &&
    isPassing(null, 90) === false &&
    isPassing(80, 0) === false,
);
check(
  "追加 TrendChart 用 isPassing＋threshold 判定 below（閾值 null 不標）",
  trend.includes('import { isPassing } from "../lib/analysisRates"') &&
    trend.includes("threshold != null && !isPassing(values[index], threshold)") &&
    trend.includes('? " below"'),
);
check(
  "追加 點標紅用 .chart-dot.below（紅 #dc2626，與閾值線同紅）",
  css.includes(".chart-dot.below") &&
    css.includes("fill: #dc2626;") &&
    css.includes(".chart-dot.latest.below"),
);
check(
  "追加 連線不改色（.chart-line 仍為 #288a7f）",
  css.includes("stroke: #288a7f;"),
);
check(
  "追加 三處曲線圖皆傳 threshold（與閾值線同一來源）",
  (results.match(/threshold=\{/g) ?? []).length >= 3,
);
check(
  "追加 無資料點不標紅：values 只收 rate != null 的欄（chartSeries／indSummary 皆過濾）",
  results.includes("if (c.rate != null)") &&
    results.includes("point.pr.rate != null"),
);

// ---- 總結 ----
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
