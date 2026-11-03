/**
 * v1.12.0 測試：用 esbuild 把純函式 lib 打包後在 node 跑斷言。
 * 涵蓋：權限 can() 多重角色取聯集、角色預設權限全無、審查員自動連動、
 *       稽核搜尋過濾、10 steps 標題單一來源、單位只顯示代號（靜態檢查）。
 * 執行：node scripts/test-v1.12.mjs
 */
import { buildSync } from "esbuild";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

// bundle 輸出放在 repo 內，node 才能解析到 node_modules 的 firebase/firestore；
// firebase/firestore 標 external（只 import 不呼叫，打包會炸 grpc）
const cacheBase = join("node_modules", ".cache", "qatest");
if (!existsSync(cacheBase)) mkdirSync(cacheBase, { recursive: true });
const dir = mkdtempSync(join(cacheBase, "run-"));
void tmpdir;
for (const [src, out] of [
  ["src/lib/permissions.ts", "pm.mjs"],
  ["src/lib/audit.ts", "au.mjs"],
  ["src/lib/scheduling.ts", "sch.mjs"],
  ["src/lib/seed.ts", "seed.mjs"],
  ["src/lib/indicators.ts", "ind.mjs"],
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
const pm = await import(pathToFileURL(join(dir, "pm.mjs")).href);
const au = await import(pathToFileURL(join(dir, "au.mjs")).href);
const sch = await import(pathToFileURL(join(dir, "sch.mjs")).href);
const seed = await import(pathToFileURL(join(dir, "seed.mjs")).href);
const ind = await import(pathToFileURL(join(dir, "ind.mjs")).href);

let pass = 0;
const fails = [];
function t(name, cond) {
  if (cond) pass++;
  else fails.push(name);
}

/* ---- 權限：5 鍵 ---- */
t("PERM_KEYS 有 5 個", pm.PERM_KEYS.length === 5);
t(
  "PERM_LABELS 覆蓋全部鍵",
  pm.PERM_KEYS.every((k) => typeof pm.PERM_LABELS[k] === "string"),
);

/* ---- 角色預設權限全無 ---- */
{
  const e = pm.emptyPermissions();
  t(
    "emptyPermissions 全 false",
    pm.PERM_KEYS.every((k) => e[k] === false),
  );
}

/* ---- can() 多重角色取聯集 ---- */
t(
  "canByRoles 單一角色有權限",
  pm.canByRoles(["審查員"], "editSubmitted", {
    審查員: { editSubmitted: true },
  }) === true,
);
t(
  "canByRoles 多重角色取聯集（其一有即有）",
  pm.canByRoles(["一般人員", "審查員"], "editSubmitted", {
    一般人員: { editSubmitted: false },
    審查員: { editSubmitted: true },
  }) === true,
);
t(
  "canByRoles 都沒有則 false",
  pm.canByRoles(["一般人員"], "manageSchedule", {
    一般人員: { resultQuery: true },
  }) === false,
);
t("canByRoles 未知角色 false", pm.canByRoles(["幽靈"], "resultQuery", {}) === false);
t("canByRoles 空角色 false", pm.canByRoles([], "resultQuery", {}) === false);
t(
  "canByRoles 缺鍵視為 false",
  pm.canByRoles(["審查員"], "manageRoles", { 審查員: {} }) === false,
);
t(
  "canByRoles 舊資料相容：表中無該角色退回預設（系統管理員管角色權限）",
  pm.canByRoles(["系統管理員"], "manageRoles", {}) === true,
);
t(
  "canByRoles Firestore 明確 false 蓋掉預設 true",
  pm.canByRoles(["審查員"], "editSubmitted", {
    審查員: { editSubmitted: false },
  }) === false,
);

/* ---- can() 交集語義：(角色聯集有) AND (職稱有) ---- */
{
  const RP = {
    審查員: { editSubmitted: true },
    一般人員: { resultQuery: true },
  };
  const TP = {
    護理師: { editSubmitted: true },
    督導: { manageRoles: true },
  };
  t(
    "交集：角色有＋職稱無 → false",
    pm.can({ roles: ["審查員"], title: "督導" }, "editSubmitted", RP, TP) === false,
  );
  t(
    "交集：角色無＋職稱有 → false",
    pm.can({ roles: ["一般人員"], title: "護理師" }, "editSubmitted", RP, TP) === false,
  );
  t(
    "交集：兩邊都有 → true",
    pm.can({ roles: ["審查員"], title: "護理師" }, "editSubmitted", RP, TP) === true,
  );
  t(
    "交集：多重角色任一有＋職稱有 → true",
    pm.can({ roles: ["一般人員", "審查員"], title: "護理師" }, "editSubmitted", RP, TP) === true,
  );
  t(
    "交集：無角色 → false",
    pm.can({ roles: [], title: "護理師" }, "editSubmitted", RP, TP) === false,
  );
  t(
    "交集：無職稱 → false",
    pm.can({ roles: ["審查員"], title: "" }, "editSubmitted", RP, TP) === false,
  );
  t("交集：null 使用者 → false", pm.can(null, "editSubmitted", RP, TP) === false);
  t(
    "交集：職稱不在表中 → false",
    pm.can({ roles: ["審查員"], title: "不存在" }, "editSubmitted", RP, TP) === false,
  );
  t(
    "交集：角色退回預設＋職稱有 → true",
    pm.can({ roles: ["系統管理員"], title: "督導" }, "manageRoles", {}, TP) === true,
  );
}

/* ---- parsePermissions ---- */

/* ---- parsePermissions ---- */
t(
  "parsePermissions 只取 5 鍵的布林值",
  JSON.stringify(pm.parsePermissions({ resultQuery: true, bogus: 1, viewPhotos: "yes" })) ===
    JSON.stringify({ resultQuery: true }),
);
t(
  "parsePermissions 非物件回傳空",
  JSON.stringify(pm.parsePermissions(null)) === JSON.stringify({}),
);

/* ---- 10 steps 標題單一來源 ---- */
t(
  "TEN_STEPS_TITLES 與 TEN_STEP_TITLES 內容一致",
  JSON.stringify(seed.TEN_STEPS_TITLES) === JSON.stringify(ind.TEN_STEP_TITLES),
);
t("標題共 10 個", ind.TEN_STEP_TITLES.length === 10);
t("第 4 步為標準依據", ind.TEN_STEP_TITLES[3] === "標準依據");

/* ---- 審查員自動連動 ---- */
t("shouldAutoLinkReviewer 含審查員", sch.shouldAutoLinkReviewer(["審查員"]) === true);
t(
  "shouldAutoLinkReviewer 多重角色含審查員",
  sch.shouldAutoLinkReviewer(["一般人員", "審查員"]) === true,
);
t("shouldAutoLinkReviewer 無審查員", sch.shouldAutoLinkReviewer(["護理長"]) === false);
t("shouldAutoLinkReviewer 空陣列", sch.shouldAutoLinkReviewer([]) === false);
t(
  "UNCATEGORIZED_GROUP_ID",
  sch.UNCATEGORIZED_GROUP_ID === "__uncategorized__",
);
t(
  "未分類審查員 doc id 格式",
  sch.reviewerDocId(sch.UNCATEGORIZED_GROUP_ID, "A123") === "__uncategorized____A123",
);

/* ---- 稽核搜尋過濾 ---- */
{
  const rows = [
    { actorLabel: "王小明（A001）", action: "建立指標", target: "IND-01", detail: "新增", dateKey: "2026-11-04" },
    { actorLabel: "李大華（B002）", action: "停用指標", target: "IND-02", detail: "廢止", dateKey: "2026-11-03" },
    { actorLabel: "王小明（A001）", action: "編輯指標", target: "IND-01", detail: "改閾值", dateKey: "2026-11-04" },
  ];
  t("關鍵字比對動作", au.filterAuditRows(rows, "停用", "").length === 1);
  t("關鍵字比對人員", au.filterAuditRows(rows, "王小明", "").length === 2);
  t("關鍵字比對說明", au.filterAuditRows(rows, "閾值", "").length === 1);
  t("關鍵字比對對象", au.filterAuditRows(rows, "IND-02", "").length === 1);
  t("無關鍵字回傳全部", au.filterAuditRows(rows, "", "").length === 3);
  t("無符合回傳空", au.filterAuditRows(rows, "不存在", "").length === 0);
  t("日期篩選", au.filterAuditRows(rows, "", "2026-11-04").length === 2);
  t(
    "關鍵字＋日期合併",
    au.filterAuditRows(rows, "王小明", "2026-11-03").length === 0,
  );
  t("大小寫不敏感", au.filterAuditRows(rows, "ind-01", "").length === 2);
}

/* ---- 單位只顯示代號（靜態檢查） ---- */
{
  const dash = readFileSync("src/features/DashboardPage.tsx", "utf8");
  const exec = readFileSync("src/features/ReviewExecutePage.tsx", "utf8");
  const sched = readFileSync("src/features/SchedulePage.tsx", "utf8");
  const grp = readFileSync("src/features/GroupsPage.tsx", "utf8");
  t("DashboardPage 無 unitName(", !dash.includes("unitName("));
  t("ReviewExecutePage 無 unitName(", !exec.includes("unitName("));
  t("SchedulePage 無 unitName(", !sched.includes("unitName("));
  t("GroupsPage 無 unitNameOf", !grp.includes("unitNameOf"));
  t("GroupsPage 下拉無「代號＋名稱」", !grp.includes("{u.code} {u.name}"));
  const ind2 = readFileSync("src/features/IndicatorsPage.tsx", "utf8");
  t("10 steps 4 無重複後綴", !ind2.includes("TEN_STEP_TITLES[3]}（"));
  t("10 steps 5 無重複後綴", !ind2.includes("TEN_STEP_TITLES[4]}（"));
  t("10 steps 6 無重複後綴", !ind2.includes("TEN_STEP_TITLES[5]}（"));
}

console.log(`pass: ${pass}, fail: ${fails.length}`);
if (fails.length > 0) {
  console.log("FAILED:");
  for (const f of fails) console.log(" -", f);
  process.exit(1);
}
