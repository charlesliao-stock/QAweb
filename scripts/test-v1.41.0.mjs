/**
 * v1.41.0 斷言測試：流量控管方案 A（最小更動）。
 *
 * 覆蓋：
 * A. 門檻判斷純函式（scripts/quota-lib.mjs，可實際執行斷言）：
 *    預設 80／95 換算、自訂門檻、讀寫刪任一觸發、每日去重、隔日自動恢復、
 *    監測停用、設定值正規化、太平洋日期／當日 00:00、Firestore REST 編解碼。
 * B. 前端攔截純函式（src/lib/maintenance.ts，tsc 編譯至暫存目錄後 import）：
 *    快取 TTL 邊界、維護開阻擋、管理員豁免、錯誤型別、設定正規化（與監測端同步）。
 * C. 靜態守衛：db.ts 七處執行點皆攔截、cacheFirst server 路徑攔截、
 *    auth 設定管理員豁免、App 維護橫幅、rules、workflow（cron、secrets、
 *    門檻不寫死）、AdminPage 設定區、版號一致。
 */
import { execSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import {
  computeThresholds,
  decodeFirestoreDoc,
  encodeFirestoreFields,
  evaluateUsage,
  normalizeQuotaSettings,
  pacificDateString,
  pacificDayStart,
  pacificOffsetMinutes,
} from "./quota-lib.mjs";

const ROOT = "/home/hatch/workspace/repos/QAweb";
const read = (p) => readFileSync(`${ROOT}/${p}`, "utf8");

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error("測試須為同步（請用 await 包裝）");
    pass++;
    console.log(`ok - ${name}`);
  } catch (err) {
    fail++;
    console.log(`FAIL - ${name}: ${err.message}`);
  }
}
function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ?? "不符"}：實際 ${JSON.stringify(actual)}，預期 ${JSON.stringify(expected)}`);
  }
}
function expectContains(haystack, needle, message) {
  if (!haystack.includes(needle)) throw new Error(message ?? `缺少：${needle}`);
}
function expectNotContains(haystack, needle, message) {
  if (haystack.includes(needle)) throw new Error(message ?? `不應出現：${needle}`);
}

const TODAY = "2026-11-10";
const YESTERDAY = "2026-11-09";
const OPEN = { maintenance: false, reason: "", updatedAt: "", alert80SentFor: "", shutdownSentFor: "" };
const usage = (reads, writes = 0, deletes = 0) => ({ reads, writes, deletes });

// ---------- A. quota-lib 門檻判斷 ----------
check("A1 預設門檻換算：提醒 40000／16000／16000，關站 47500／19000／19000", () => {
  const t = computeThresholds(undefined);
  eq(t.warn.reads, 40000);
  eq(t.warn.writes, 16000);
  eq(t.warn.deletes, 16000);
  eq(t.shutdown.reads, 47500);
  eq(t.shutdown.writes, 19000);
  eq(t.shutdown.deletes, 19000);
});

check("A2 自訂門檻 70／90：提醒 35000／14000，關站 45000／18000", () => {
  const t = computeThresholds({ warnPercent: 70, shutdownPercent: 90 });
  eq(t.warn.reads, 35000);
  eq(t.warn.writes, 14000);
  eq(t.shutdown.reads, 45000);
  eq(t.shutdown.writes, 18000);
});

check("A3 用量未達門檻 → 無動作", () => {
  const d = evaluateUsage({ usage: usage(39999, 15999, 15999), settings: undefined, status: OPEN, today: TODAY });
  eq(d.action, "none");
});

check("A4 讀取達 80% → 提醒", () => {
  const d = evaluateUsage({ usage: usage(40000), settings: undefined, status: OPEN, today: TODAY });
  eq(d.action, "alert80");
  eq(d.triggered[0].kind, "reads");
});

check("A5 寫入達 80%（讀取未達）→ 提醒，任一先到即觸發", () => {
  const d = evaluateUsage({ usage: usage(100, 16000), settings: undefined, status: OPEN, today: TODAY });
  eq(d.action, "alert80");
  eq(d.triggered[0].kind, "writes");
});

check("A6 刪除達 95% → 關站", () => {
  const d = evaluateUsage({ usage: usage(100, 100, 19000), settings: undefined, status: OPEN, today: TODAY });
  eq(d.action, "shutdown");
});

check("A7 讀取達 95% → 關站（優先於提醒）", () => {
  const d = evaluateUsage({ usage: usage(47500), settings: undefined, status: OPEN, today: TODAY });
  eq(d.action, "shutdown");
});

check("A8 今日已提醒過 → 不重複提醒", () => {
  const d = evaluateUsage({
    usage: usage(42000),
    settings: undefined,
    status: { ...OPEN, alert80SentFor: TODAY },
    today: TODAY,
  });
  eq(d.action, "none");
});

check("A9 昨日提醒過、今日又達門檻 → 再次提醒", () => {
  const d = evaluateUsage({
    usage: usage(42000),
    settings: undefined,
    status: { ...OPEN, alert80SentFor: YESTERDAY },
    today: TODAY,
  });
  eq(d.action, "alert80");
});

check("A10 已關站且用量回到提醒門檻以下 → 自動恢復", () => {
  const d = evaluateUsage({
    usage: usage(100),
    settings: undefined,
    status: { ...OPEN, maintenance: true, reason: "x", shutdownSentFor: YESTERDAY },
    today: TODAY,
  });
  eq(d.action, "recover");
});

check("A11 已關站、用量仍在提醒以上未達關站 → 維持關站、不重複動作", () => {
  const d = evaluateUsage({
    usage: usage(42000),
    settings: undefined,
    status: { ...OPEN, maintenance: true, reason: "x", shutdownSentFor: TODAY },
    today: TODAY,
  });
  eq(d.action, "none");
});

check("A12 已關站、用量又達關站且今日未發關站通知 → 補發關站動作", () => {
  const d = evaluateUsage({
    usage: usage(48000),
    settings: undefined,
    status: { ...OPEN, maintenance: true, reason: "x", shutdownSentFor: YESTERDAY },
    today: TODAY,
  });
  eq(d.action, "shutdown");
});

check("A13 監測停用 → 即使超標也無動作", () => {
  const d = evaluateUsage({
    usage: usage(99999, 99999, 99999),
    settings: { warnPercent: 80, shutdownPercent: 95, monitoringEnabled: false, lineEnabled: true },
    status: OPEN,
    today: TODAY,
  });
  eq(d.action, "none");
  eq(d.reason, "monitoring-disabled");
});

check("A14 設定值正規化：缺值用預設、越界箝制、提醒不小於關站退回預設", () => {
  eq(normalizeQuotaSettings(null).warnPercent, 80);
  eq(normalizeQuotaSettings({ warnPercent: 10 }).warnPercent, 50);
  eq(normalizeQuotaSettings({ shutdownPercent: 200 }).shutdownPercent, 99);
  const bad = normalizeQuotaSettings({ warnPercent: 95, shutdownPercent: 90 });
  eq(bad.warnPercent, 80);
  eq(bad.shutdownPercent, 95);
  eq(normalizeQuotaSettings({ lineEnabled: false }).lineEnabled, false);
  eq(normalizeQuotaSettings({}).monitoringEnabled, true);
});

check("A15 太平洋日期：2026-11-10T00:00Z 是太平洋 11/09，16:00Z 是 11/10", () => {
  eq(pacificDateString(new Date("2026-11-10T00:00:00Z")), "2026-11-09");
  eq(pacificDateString(new Date("2026-11-10T16:00:00Z")), "2026-11-10");
});

check("A16 太平洋偏移：11 月 PST -480、7 月 PDT -420", () => {
  eq(pacificOffsetMinutes(new Date("2026-11-10T12:00:00Z")), -480);
  eq(pacificOffsetMinutes(new Date("2026-07-01T12:00:00Z")), -420);
});

check("A17 太平洋當日 00:00：11/10 為 08:00Z", () => {
  eq(pacificDayStart(new Date("2026-11-10T16:00:00Z")).toISOString(), "2026-11-10T08:00:00.000Z");
});

check("A18 Firestore REST 編解碼往返", () => {
  const encoded = encodeFirestoreFields({ maintenance: true, reason: "x", n: 3 });
  const decoded = decodeFirestoreDoc(encoded);
  eq(decoded.maintenance, true);
  eq(decoded.reason, "x");
  eq(decoded.n, 3);
  eq(decodeFirestoreDoc(null), null);
  eq(decodeFirestoreDoc({}), null);
});

// ---------- B. maintenance.ts 前端攔截純函式（編譯後 import） ----------
const TMP_DIR = `${ROOT}/.tmp-maint-test`;
let maint = null;
try {
  execSync(
    "npx tsc src/lib/maintenance.ts --outDir .tmp-maint-test --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --declaration false",
    { cwd: ROOT, stdio: "pipe" },
  );
  maint = await import(`${TMP_DIR}/maintenance.js`);
} catch (err) {
  console.log(`FAIL - B0 編譯 maintenance.ts：${err.message}`);
  fail++;
}

if (maint) {
  const now = Date.now();
  check("B1 快取 TTL：5 分鐘內新鮮、5 分鐘整過期", () => {
    eq(maint.isCacheFresh(now, now), true);
    eq(maint.isCacheFresh(now - 4 * 60 * 1000 - 59000, now), true);
    eq(maint.isCacheFresh(now - 5 * 60 * 1000, now), false);
    eq(maint.isCacheFresh(now - 6 * 60 * 1000, now), false);
    eq(maint.MAINTENANCE_TTL_MS, 300000);
  });
  check("B2 維護開＋非管理員 → 阻擋；管理員豁免；維護關 → 不擋", () => {
    eq(maint.shouldBlockMaintenance({ maintenance: true }, false), true);
    eq(maint.shouldBlockMaintenance({ maintenance: true }, true), false);
    eq(maint.shouldBlockMaintenance({ maintenance: false }, false), false);
    eq(maint.shouldBlockMaintenance(null, false), false);
  });
  check("B3 MaintenanceModeError 帶 maintenance-mode code", () => {
    const err = new maint.MaintenanceModeError("測試原因");
    eq(maint.isMaintenanceError(err), true);
    eq(err.code, "maintenance-mode");
    if (!err.message.includes("測試原因")) throw new Error("錯誤訊息應帶原因");
    eq(maint.isMaintenanceError(new Error("x")), false);
    eq(maint.isMaintenanceError({ code: "maintenance-mode" }), true);
  });
  check("B4 前端設定正規化與監測端同步（預設 80／95、越界退回）", () => {
    const d = maint.normalizeQuotaSettings(null);
    eq(d.warnPercent, 80);
    eq(d.shutdownPercent, 95);
    const bad = maint.normalizeQuotaSettings({ warnPercent: 95, shutdownPercent: 90 });
    eq(bad.warnPercent, 80);
    eq(bad.shutdownPercent, 95);
  });
  check("B5 豁免路徑：狀態文件與 users/* 讀取豁免，其餘不豁免", () => {
    eq(maint.isExemptReadPath("configs/system_status"), true);
    eq(maint.isExemptReadPath("users/1130142"), true);
    eq(maint.isExemptReadPath("reviewRecords/abc"), false);
    eq(maint.isExemptReadPath(undefined), false);
  });
}

// ---------- C. 靜態守衛 ----------
const dbTs = read("src/lib/db.ts");
const cacheFirstTs = read("src/lib/cacheFirst.ts");
const authTs = read("src/lib/auth.tsx");
const appTs = read("src/app/App.tsx");
const css = read("src/styles.css");
const rules = read("firestore.rules");
const workflow = read(".github/workflows/quota-monitor.yml");
const monitorJs = read("scripts/quota-monitor.mjs");
const adminTs = read("src/features/AdminPage.tsx");
const versionTs = read("src/version.ts");
const pkg = JSON.parse(read("package.json"));

check("C1 db.ts 七處執行點皆攔截（getDoc／getDocs／getDocsFromServer／setDoc／updateDoc／deleteDoc／commit）", () => {
  const n = (dbTs.match(/assertFirestoreAllowed\(/g) ?? []).length;
  if (n < 7) throw new Error(`攔截呼叫只有 ${n} 處，需 7 處`);
  for (const fn of ["getDoc", "getDocs", "getDocsFromServer", "setDoc", "updateDoc", "deleteDoc"]) {
    if (!dbTs.includes(`export async function ${fn}`)) throw new Error(`${fn} 未改為 async 攔截版`);
  }
});

check("C2 cacheFirst server 路徑攔截、維護錯誤不退回重試", () => {
  const n = (cacheFirstTs.match(/assertFirestoreAllowed\(/g) ?? []).length;
  if (n < 3) throw new Error(`cacheFirst 攔截只有 ${n} 處，需 3 處（強制伺服器＋兩處快取未命中）`);
  expectContains(cacheFirstTs, "isMaintenanceError(err)");
});

check("C3 auth.tsx 設定管理員豁免（登入、狀態訂閱、登出三處）", () => {
  const n = (authTs.match(/setMaintenanceAdmin\(/g) ?? []).length;
  if (n < 3) throw new Error(`setMaintenanceAdmin 只有 ${n} 處，需 3 處`);
  expectContains(authTs, 'profile.roles.includes("系統管理員")');
});

check("C4 App.tsx 監聽維護事件並顯示橫幅", () => {
  expectContains(appTs, "MAINTENANCE_EVENT");
  expectContains(appTs, "maintenance-banner");
  expectContains(appTs, "maintenanceBanner");
});

check("C5 styles.css 有維護橫幅樣式", () => {
  expectContains(css, ".maintenance-banner");
});

check("C6 firestore.rules：configs 讀取限登入、寫入限管理員", () => {
  expectContains(rules, "match /configs/{id} {");
  expectContains(rules, "allow read: if isAuthed();");
  expectContains(rules, "allow write: if isAdmin();");
});

check("C7 workflow：每 10 分鐘 cron、只用 secrets 引用", () => {
  expectContains(workflow, '"*/10 * * * *"');
  expectContains(workflow, "node scripts/quota-monitor.mjs");
  expectContains(workflow, "secrets.GCP_SERVICE_ACCOUNT_JSON");
  expectContains(workflow, "secrets.LINE_CHANNEL_ACCESS_TOKEN");
  expectContains(workflow, "secrets.LINE_USER_ID");
});

check("C8 workflow 與 monitor script 皆不寫死門檻次數", () => {
  for (const bad of ["40000", "47500", "16000", "19000"]) {
    expectNotContains(workflow, bad, `workflow 不應寫死 ${bad}`);
    expectNotContains(monitorJs, bad, `monitor script 不應寫死 ${bad}`);
  }
  expectContains(monitorJs, "quota-lib.mjs");
  expectContains(monitorJs, "evaluateUsage");
});

check("C9 AdminPage 流量控管設定區：四欄位＋狀態顯示＋手動開關站", () => {
  expectContains(adminTs, "QuotaControlSection");
  expectContains(adminTs, "流量控管");
  expectContains(adminTs, "提醒門檻");
  expectContains(adminTs, "關站門檻");
  expectContains(adminTs, "監測開關");
  expectContains(adminTs, "LINE 提醒");
  expectContains(adminTs, '"configs", "quotaSettings"');
  expectContains(adminTs, '"configs", "system_status"');
  expectContains(adminTs, "手動開站");
  expectContains(adminTs, "手動關站");
});

check("C10 版號一致：src/version.ts 與 package.json 皆為 1.41.0", () => {
  expectContains(versionTs, '"1.41.0"');
  eq(pkg.version, "1.41.0");
});

try {
  rmSync(TMP_DIR, { recursive: true, force: true });
} catch {
  /* 忽略 */
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
