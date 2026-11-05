/**
 * v1.14.0 測試：esbuild 打包純函式 lib 後跑斷言＋靜態檢查。
 * 涵蓋：access.ts（17 角色對照，v1.21 增 6 新角色）、scheduleStatus.ts（顯示狀態）、
 *       types.ts 清理（CapaCase 已刪、reviewers PageId、Role 擴充）、
 *       導覽接線（v1.21 審查員管理已刪除／季度分析／審查總覽入口）、
 *       firebase.ts 移植函式存在、版本號。
 * 執行：node scripts/test-v1.14.mjs
 */
import { buildSync } from "esbuild";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

const cacheBase = join("node_modules", ".cache", "qatest");
if (!existsSync(cacheBase)) mkdirSync(cacheBase, { recursive: true });
const dir = mkdtempSync(join(cacheBase, "run-"));
void tmpdir;
for (const [src, out] of [
  ["src/lib/access.ts", "ac.mjs"],
  ["src/lib/scheduleStatus.ts", "ss.mjs"],
]) {
  buildSync({
    entryPoints: [src],
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["firebase/firestore"],
    outfile: join(dir, out),
    logLevel: "silent",
  });
}
const ac = await import(pathToFileURL(join(dir, "ac.mjs")).href);
const ss = await import(pathToFileURL(join(dir, "ss.mjs")).href);

let pass = 0;
const fails = [];
function t(name, cond) {
  if (cond) pass++;
  else fails.push(name);
}
function src(name) {
  return readFileSync(join("src", name), "utf8");
}

/* ---- access.ts：17 角色對照（v1.21 增 6 新角色） ---- */
t("ROLE_PAGES 有 17 個角色", Object.keys(ac.ROLE_PAGES).length === 17);
t("管理員可進 admin", ac.canView("系統管理員", "admin") === true);
t("一般人員不可進 admin", ac.canView("一般人員", "admin") === false);
t("審查員可進 audit", ac.canView("審查員", "audit") === true);
t("品管組審查員可進 audit", ac.canView("品管組審查員", "audit") === true);
t("單位執行幹事可進 audit", ac.canView("單位執行幹事", "audit") === true);
t("主任可進 groups", ac.canView("主任", "groups") === true);

/* ---- scheduleStatus.ts ---- */
t(
  "done>=total → 已完成",
  ss.getScheduleTaskDisplayStatus({ done: 3, total: 3, status: "進行中" }) ===
    "已完成",
);
t(
  "部分完成 → 進行中",
  ss.getScheduleTaskDisplayStatus({ done: 1, total: 3, status: "進行中" }) ===
    "進行中",
);
t(
  "未開始 → 待開始",
  ss.getScheduleTaskDisplayStatus({ done: 0, total: 3, status: "待開始" }) ===
    "待開始",
);
t(
  "total<=0 → 資料異常",
  ss.getScheduleTaskDisplayStatus({ done: 0, total: 0, status: "進行中" }) ===
    "資料異常",
);
t("進度 1/2 → 50", ss.getScheduleTaskProgress({ done: 1, total: 2 }) === 50);

/* ---- types.ts 清理 ---- */
const types = src("types.ts");
t("CapaCase 已刪除", !types.includes("CapaCase"));
t("PageId 有 reviewers", types.includes('"reviewers"'));
t("Role 有主任", types.includes('"主任"'));
t("Role 有執行幹事", types.includes('"執行幹事"'));
t("舊 Indicator 介面保留（QuarterResults 用）", types.includes("interface Indicator"));
t("舊 ScheduleTask 介面保留（scheduleStatus 用）", types.includes("interface ScheduleTask"));

/* ---- 導覽接線（v1.21：審查員管理已刪除，改由角色管理） ---- */
const app = src("app/App.tsx");
t("App 不再引入 ReviewerManagement", !app.includes("ReviewerManagement"));
t("審查員管理已從導覽移除", !app.includes('"reviewers", label: "審查員管理"'));
t("App 不再用 can(manageRoles) gating", !app.includes('can("manageRoles")'));
const audit = src("features/AuditPage.tsx");
t("AuditPage 不再引入 ReviewOverviewPage（v1.19 取代）", !audit.includes("ReviewOverviewPage"));
t("AuditPage 為品管審查清單（v1.19）", audit.includes("進行中的審查排程"));
const results = src("features/ResultsPage.tsx");
t("ResultsPage 有季度分析頁籤", results.includes("quarterly"));
t("ResultsPage 引入 QuarterResults", results.includes("QuarterResults"));
const ui = src("components/ui.tsx");
t("PAGE_COPY 有 reviewers", ui.includes("reviewers:"));

/* ---- firebase.ts 移植 ---- */
const fblib = src("lib/firebase.ts");
for (const name of [
  "readReviewRecords",
  "readIndicatorYearSchedule",
  "grantReviewerRole",
  "readFirebaseUsersForReviewerManagement",
  "readFirebaseGroupsForReviewerManagement",
  "isFirebaseReviewerRoleWriteEnabled",
  "toFirebaseProfile",
  "FirebaseProfile",
]) {
  t(`firebase.ts 匯出 ${name}`, fblib.includes(name));
}
t("移植函式用單一 where（避免複合索引）", !fblib.includes('where("year", "==", year)'));

/* ---- 舊集合引用清理 ---- */
const ind = src("features/IndicatorsPage.tsx");
t("IndicatorsPage 改用 reviewRecords", ind.includes('"reviewRecords"'));
t("IndicatorsPage 無舊 reviews 集合引用", !ind.includes('"reviews"'));

/* ---- 版本號 ---- */
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
t("package.json 版號 1.21.0", pkg.version === "1.21.0");
t("version.ts 版號 1.21.0", src("version.ts").includes('VERSION = "1.21.0"'));

/* ---- 4 檔存在 ---- */
for (const f of [
  "features/QuarterResults.tsx",
  "features/ReviewerManagement.tsx",
  "lib/access.ts",
  "lib/scheduleStatus.ts",
]) {
  t(`${f} 存在`, existsSync(join("src", f)));
}

console.log(`pass ${pass}, fail ${fails.length}`);
if (fails.length) {
  console.log("FAILED:");
  for (const f of fails) console.log(" -", f);
  process.exit(1);
}
