/**
 * v1.14.0 測試：esbuild 打包純函式 lib 後跑斷言＋靜態檢查。
 * 涵蓋：scheduleStatus.ts（顯示狀態）、
 *       types.ts 清理（CapaCase 已刪、reviewers PageId）、
 *       導覽接線（v1.21 審查員管理已刪除／季度分析／審查總覽入口）、
 *       firebase.ts 移植函式存在、版本號。
 * v1.40.5：access.ts（名稱鍵控 ROLE_PAGES 死碼）已刪除，本測試不再覆蓋該檔；
 *       Role 名稱聯集亦隨之移除（types.ts 不再匯出 Role）。
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

/* ---- access.ts 已刪除（v1.40.5）：名稱鍵控 ROLE_PAGES 死碼，無人引用 ---- */
t("lib/access.ts 已刪除", !existsSync(join("src", "lib", "access.ts")));
t("types.ts 無 Role 名稱聯集", !src("types.ts").includes("export type Role"));

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
// v1.40.5：Role 名稱聯集已刪除（身分改走 roles 集合的 category／kind 欄位）
t("Role 名稱聯集已刪除", !types.includes("export type Role"));
t("types.ts 無舊角色名稱", !types.includes('"單位審查員"'));
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
t(
  "ResultsPage 有四個新頁籤（v1.25.0）",
  results.includes('"group"') &&
    results.includes('"unit"') &&
    results.includes('"indicator"') &&
    results.includes('"import"'),
);
t("ResultsPage 不再引入 QuarterResults（v1.25.0）", !results.includes("QuarterResults"));
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
t("package.json 版號 1.28.0", pkg.version === "1.28.0");
t("version.ts 版號 1.28.0", src("version.ts").includes('VERSION = "1.28.0"'));

/* ---- 3 檔存在（v1.25.0：QuarterResults 已隨舊結果分析畫面移除） ---- */
for (const f of [
  "features/ReviewerManagement.tsx",
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
