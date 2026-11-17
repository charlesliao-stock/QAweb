/**
 * v1.28 階段 2 斷言：儀表板瘦身——旗標預設／解析／月份窗口／任務合併／計數。
 * 執行：node scripts/test-v1.28-dashboard.mjs（專案根目錄）
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";
import { resolve } from "path";
const ROOT = resolve(import.meta.dirname, "..");
writeFileSync(
  "/tmp/t128d.ts",
  [
    `export { DEFAULT_DASHBOARD_SECTIONS, parseDashboardSections, resolveDashboardSections } from "${ROOT}/src/lib/dashboardSections";`,
    `export { countRecordsByTask, dashboardMonthWindow, mergeDashTasks, taskProgressCount, taskProgressLabel, lagLights } from "${ROOT}/src/lib/dashboardStats";`,
    `export { quotaRecordMatchesGroup } from "${ROOT}/src/features/dashboard/periodicQuotaCounts";`,
  ].join("\n"),
);
await build({ entryPoints: ["/tmp/t128d.ts"], bundle: true, format: "cjs", platform: "node", outfile: "/tmp/t128d.cjs", logLevel: "silent" });
const L = createRequire("/tmp/t128d.cjs")("/tmp/t128d.cjs");
let f = 0;
const a = (n, c) => { if (!c) { f++; console.error("FAIL:", n); } };

// 旗標預設：留本月提醒、拿掉跨月／全院分析
a("預設：本月待辦／次月預告／逾期鎖定／解鎖／落後燈／48h 開", ["monthlyTodo", "nextMonthPreview", "overdueLocked", "unlockReview", "lagLights", "alert48h"].every((k) => L.DEFAULT_DASHBOARD_SECTIONS[k] === true));
a("預設：個人走勢／Top3／單位平均／帕累托／3月趨勢／雷達／紅旗／高風險關", ["personalTrend", "weakTop3", "unitAvg", "pareto", "trendAlerts", "radar", "redFlags", "riskyUnits"].every((k) => L.DEFAULT_DASHBOARD_SECTIONS[k] === false));
a("預設：重點指標／超額加審／轄區進度／組別達標率／戰情總覽開", ["focusIndicators", "overAudit", "unitProgress", "groupPassRate", "overview"].every((k) => L.DEFAULT_DASHBOARD_SECTIONS[k] === true));
// 解析：只收布林已知鍵
a("parse：非布林／未知鍵忽略", JSON.stringify(L.parseDashboardSections({ personalTrend: true, unitAvg: "yes", unknownKey: true, pareto: 1 })) === JSON.stringify({ personalTrend: true }));
a("parse：null 回空物件", JSON.stringify(L.parseDashboardSections(null)) === "{}");
// 優先序：預設 ← 管理員 ← 個人
a("resolve：管理員可開走勢", L.resolveDashboardSections({ personalTrend: true }).personalTrend === true);
a("resolve：個人偏好壓過管理員", L.resolveDashboardSections({ personalTrend: true }, { personalTrend: false }).personalTrend === false);
a("resolve：皆缺值回預設", L.resolveDashboardSections().monthlyTodo === true && L.resolveDashboardSections().pareto === false);

// 月份窗口
{
  const w = L.dashboardMonthWindow(new Date(2026, 10, 6, 12, 0, 0)); // 2026-11-06
  a("窗口 11 月：本月 2026/11、次月 2026/12、上月 2026/10", w.curYear === 2026 && w.curMonth === 11 && w.nextYear === 2026 && w.nextMonth === 12 && w.prevYear === 2026 && w.prevMonth === 10);
  a("窗口 11 月：48h 起點為 48 小時前", w.alertSinceMs === new Date(2026, 10, 6, 12, 0, 0).getTime() - 48 * 3600 * 1000);
  const d = L.dashboardMonthWindow(new Date(2026, 11, 15));
  a("窗口 12 月：次月跨年 2027/1", d.nextYear === 2027 && d.nextMonth === 1 && d.prevMonth === 11);
  const j = L.dashboardMonthWindow(new Date(2027, 0, 5));
  a("窗口 1 月：上月跨年 2026/12", j.prevYear === 2026 && j.prevMonth === 12 && j.nextMonth === 2);
}
// 任務合併去重（先出現者優先）
{
  const t1 = { id: "a", doneCount: 0 };
  const t2 = { id: "a", doneCount: 5 };
  const merged = L.mergeDashTasks([t1], [{ id: "b", doneCount: 0 }], [t2]);
  a("合併：同 id 只留一份、先出現者優先", merged.length === 2 && merged.find((t) => t.id === "a").doneCount === 0);
}
// 計數
a("計數：依 taskId 累加", (() => { const m = L.countRecordsByTask([{ taskId: "a" }, { taskId: "a" }, { taskId: "b" }]); return m.get("a") === 2 && m.get("b") === 1; })());

// 年度／學年度週期件數：任務 progress 採整個 quota group，calendar-month doneCount 保持分離
{
  const periodicTask = {
    id: "task-a",
    quotaGroupId: "quota-a",
    doneCount: 0,
    quotaDoneCount: 2,
    caseCount: 3,
    status: "pending",
    deadline: "2026-11-08",
  };
  a("週期任務：進度使用區間共用 quota count", L.taskProgressCount(periodicTask) === 2 && L.taskProgressLabel(periodicTask) === "2/3");
  a("週期任務：落後燈號以區間 count 計算", (() => { const rows = L.lagLights([periodicTask], "2026-11-06"); return rows.length === 1 && Math.abs(rows[0].pct - 2 / 3) < 0.001 && rows[0].level === "yellow"; })());
  const monthlyTask = { id: "task-b", doneCount: 1, caseCount: 3 };
  a("一般／臨時任務：進度仍使用原 task 件數", L.taskProgressCount(monthlyTask) === 1 && L.taskProgressLabel(monthlyTask) === "1/3");
}

// 週期 quota 匯入結果必須與指標、單位及區間年月全數相符
{
  const group = {
    indicatorId: "indicator-a",
    unitId: "10A",
    quotaIntervalStartYear: 2026,
    quotaIntervalStartMonth: 2,
    quotaIntervalEndYear: 2026,
    quotaIntervalEndMonth: 4,
  };
  a("quota match：同指標、同單位、區間內", L.quotaRecordMatchesGroup({ indicatorId: "indicator-a", unitId: "10A", year: 2026, month: 3 }, group));
  a("quota match：不同指標不混計", !L.quotaRecordMatchesGroup({ indicatorId: "indicator-b", unitId: "10A", year: 2026, month: 3 }, group));
  a("quota match：不同單位不混計", !L.quotaRecordMatchesGroup({ indicatorId: "indicator-a", unitId: "10B", year: 2026, month: 3 }, group));
  a("quota match：區間外不計", !L.quotaRecordMatchesGroup({ indicatorId: "indicator-a", unitId: "10A", year: 2026, month: 5 }, group));
}

console.log(f ? `failed ${f}` : "v1.28-dashboard：配額與 dashboard assertions 通過");
process.exit(f ? 1 : 0);
