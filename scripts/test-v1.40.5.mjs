/**
 * v1.40.5 斷言測試：全系統寫死名稱稽核修正（靜態守衛＋函式驗證，無需 emulator）。
 *
 * 問題：舊程式以角色／職稱「名稱字串」決定身分與範圍（例如 roles.includes("審查員")、
 * title.includes("護理長")、GroupsPage 開頁自動補種五個固定群組名稱），
 * 換一家名稱不同的醫院就全部失效。
 *
 * 本版修正：
 * - 新檔 lib/orgMeta.ts：角色 `category`（reviewer／convener／officer／unitHead／
 *   senior／general）＋ `kind`（group／unit）；職稱 `isUnitHead／isDistrictHead／
 *   isHospitalHead／isOfficer／isConvener` 旗標。欄位優先、缺失才以名稱推導
 *   （legacy，僅遷移相容；管理員補設欄位後即不再依賴名稱）。
 * - 新檔 lib/useOrgMeta.ts：由 roles／titles 集合建立詮釋資料對照表。
 * - 角色建立／編輯寫入 category＋kind；職稱建立／編輯寫入主管層級旗標
 *   （編輯時即使名稱不變也要能存旗標）；改適用範圍時權限範本 group↔unitRole 一併遷移。
 * - GroupsPage 開頁不再自動補種固定名稱群組；seed.ts 刪 SYSTEM_ROLE_NAMES／
 *   SEED_GROUP_NAMES 匯出；刪死碼 lib/access.ts（名稱鍵控 ROLE_PAGES）與
 *   types.ts 的 Role 名稱聯集。
 * - AuditPage／ResultsPage／SchedulePage／DashboardPage／TaskHandoffPage／
 *   ReviewerManagement／auth／firebase（readReviewRecords 範圍、grantReviewerRole
 *   授予對象）／reviewerValidity／scheduling／orgImport 皆改走詮釋資料。
 * - 刻意保留：系統管理員／一般人員是結構性身分（仍以名稱判斷）；
 *   deriveTemplateRowNames 的 kind 優先、名稱含「單位」fallback；
 *   demo 資料與匯入範本的固定名稱屬範例類。
 * - firestore.rules 按名稱判斷（isAdmin／isGanShi／canManageSchedule）未改：
 *   rules 無法按名稱查詢 roles 集合，改資料驅動需 custom claims 或衍生欄位，
 *   列為待決（v1.2 P0 後端權限另案）。
 * 覆蓋：
 * 1. legacy 推導重現舊行為（類別／範圍／職稱旗標）
 * 2. 欄位優先於名稱（自訂名稱「查核員」＋category reviewer 即生效；舊名改類別即失效）
 * 3. roleIdentity 委派層舊簽名行為不變（test-v1.21 相容）
 * 4. dashboardVariant 變體改走旗標／類別（test-v1.15 相容）
 * 5. reviewerValidity 效期清理改走類別
 * 6. 靜態守衛：正式流程不再以固定名稱字串決定歸屬或權限（每處）
 * 7. GroupsPage 無 ensureSeeds／SEED_GROUP_NAMES；seed.ts 無該兩匯出
 * 8. access.ts 已刪；types.ts 無 Role 聯集
 * 9. 版號一致：src/version.ts 與 package.json 皆為 1.40.5
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "/home/hatch/workspace/repos/QAweb";
const read = (p) => readFileSync(`${ROOT}/${p}`, "utf8");
const groupsSrc = read("src/features/GroupsPage.tsx");
const auditSrc = read("src/features/AuditPage.tsx");
const resultsSrc = read("src/features/ResultsPage.tsx");
const scheduleSrc = read("src/features/SchedulePage.tsx");
const dashboardSrc = read("src/features/DashboardPage.tsx");
const handoffSrc = read("src/features/TaskHandoffPage.tsx");
const reviewerMgmtSrc = read("src/features/ReviewerManagement.tsx");
const authSrc = read("src/lib/auth.tsx");
const firebaseSrc = read("src/lib/firebase.ts");
const seedSrc = read("src/lib/seed.ts");
const typesSrc = read("src/types.ts");
const versionTs = read("src/version.ts");
const pkg = JSON.parse(read("package.json"));

let pass = 0;
function check(name, fn) {
  fn();
  pass++;
  console.log(`ok - ${name}`);
}

// --- 函式驗證：esbuild 打包零依賴模組 ---
const esbuildPackage = readdirSync(resolve(ROOT, "node_modules/.pnpm")).find(
  (entry) => entry.startsWith("esbuild@"),
);
if (!esbuildPackage) throw new Error("pnpm esbuild package not found");
const { build } = await import(
  pathToFileURL(
    resolve(ROOT, "node_modules/.pnpm", esbuildPackage, "node_modules/esbuild/lib/main.js"),
  ).href,
);
writeFileSync(
  "/tmp/v1-40-5-test.ts",
  `export * from "${ROOT}/src/lib/orgMeta";
   export * from "${ROOT}/src/lib/roleIdentity";
   export * from "${ROOT}/src/lib/dashboardVariant";
   export * from "${ROOT}/src/lib/reviewerValidity";`,
);
await build({
  entryPoints: ["/tmp/v1-40-5-test.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v1-40-5-test.cjs",
  logLevel: "silent",
});
const lib = createRequire("/tmp/v1-40-5-test.cjs")("/tmp/v1-40-5-test.cjs");

// --- 1. legacy 推導重現舊行為 ---
check("legacy 角色類別：審查員系→reviewer、召集人系→convener、執行幹事系→officer", () => {
  if (lib.legacyRoleCategory("審查員") !== "reviewer") throw new Error("審查員");
  if (lib.legacyRoleCategory("品管組審查員") !== "reviewer") throw new Error("品管組審查員");
  if (lib.legacyRoleCategory("單位審查員") !== "reviewer") throw new Error("單位審查員");
  if (lib.legacyRoleCategory("召集人") !== "convener") throw new Error("召集人");
  if (lib.legacyRoleCategory("品管組召集人") !== "convener") throw new Error("品管組召集人");
  if (lib.legacyRoleCategory("單位召集人") !== "convener") throw new Error("單位召集人");
  if (lib.legacyRoleCategory("執行幹事") !== "officer") throw new Error("執行幹事");
  if (lib.legacyRoleCategory("單位執行幹事") !== "officer") throw new Error("單位執行幹事");
  if (lib.legacyRoleCategory("護理長") !== "unitHead") throw new Error("護理長");
  if (lib.legacyRoleCategory("主任") !== "senior") throw new Error("主任");
  if (lib.legacyRoleCategory("督導") !== "senior") throw new Error("督導");
  if (lib.legacyRoleCategory("護理師") !== "general") throw new Error("護理師");
  if (lib.legacyRoleCategory("全球") !== "general") throw new Error("全球");
});
check("legacy 角色範圍：含「單位」→unit，其餘→group", () => {
  if (lib.legacyRoleScope("單位執行幹事") !== "unit") throw new Error("單位執行幹事");
  if (lib.legacyRoleScope("單位審查員") !== "unit") throw new Error("單位審查員");
  if (lib.legacyRoleScope("召集人") !== "group") throw new Error("召集人");
  if (lib.legacyRoleScope("審查員") !== "group") throw new Error("審查員");
});
check("legacy 職稱旗標：護理長→單位主管、督導→轄區主管、主任→院級主管、副護理長→皆否", () => {
  const f = lib.legacyTitleFlags("護理長");
  if (!f.isUnitHead) throw new Error("護理長 isUnitHead");
  if (lib.legacyTitleFlags("副護理長").isUnitHead) throw new Error("副護理長不應為單位主管");
  if (!lib.legacyTitleFlags("督導").isDistrictHead) throw new Error("督導");
  if (!lib.legacyTitleFlags("主任").isHospitalHead) throw new Error("主任");
  if (!lib.legacyTitleFlags("副主任").isHospitalHead) throw new Error("副主任");
});

// --- 2. 欄位優先於名稱 ---
check("欄位優先：自訂名稱「查核員」＋category reviewer 即為審查員", () => {
  const meta = lib.buildRoleMetaMap([{ name: "查核員", category: "reviewer", kind: "group" }]);
  if (!lib.isReviewerRole(["查核員"], meta)) throw new Error("查核員未被認作審查員");
  if (!lib.isReviewerRoleMeta(["查核員"], meta)) throw new Error("meta 層未認");
});
check("欄位優先：舊名「審查員」改 category general 後即不再是審查員", () => {
  const meta = lib.buildRoleMetaMap([{ name: "審查員", category: "general", kind: "group" }]);
  if (lib.isReviewerRole(["審查員"], meta)) throw new Error("審查員仍被認作審查員");
});
check("欄位優先：職稱旗標有值時不以名稱推導", () => {
  const flags = lib.resolveTitleFlags({ name: "小組長", isUnitHead: true });
  if (!flags.isUnitHead) throw new Error("小組長 isUnitHead 旗標未生效");
  const byId = lib.buildTitleMetaById([{ id: "t1", name: "小組長", isUnitHead: true }]);
  if (!lib.titleFlagsOf("小組長", "t1", undefined, byId).isUnitHead) throw new Error("titleFlagsOf byId 失效");
});

// --- 3. roleIdentity 委派層舊簽名行為不變 ---
check("roleIdentity：只傳名稱時走 legacy（test-v1.21 行為）", () => {
  if (!lib.isReviewerRole(["審查員"])) throw new Error("審查員");
  if (lib.isReviewerRole(["全球"])) throw new Error("全球不應是審查員");
  if (!lib.isConvenerRole(["單位召集人"])) throw new Error("單位召集人");
  if (!lib.isOfficerRole(["品管組執行幹事"])) throw new Error("品管組執行幹事");
  if (!lib.isGroupScopedRole("召集人")) throw new Error("召集人應為群組範圍");
  if (lib.isGroupScopedRole("全球")) throw new Error("全球不應為群組範圍");
  if (!lib.isUnitLevelRole("單位審查員")) throw new Error("單位審查員");
  if (lib.isUnitLevelRole("審查員")) throw new Error("審查員不應為單位級");
  if (!lib.hasSchedulePermission(["召集人"])) throw new Error("召集人應有排程權限");
  if (lib.hasSchedulePermission(["單位召集人"])) throw new Error("單位召集人不應有排程權限");
  if (!lib.hasSchedulePermission(["品管組執行幹事"])) throw new Error("品管組執行幹事應有排程權限");
});

// --- 4. dashboardVariant 變體改走旗標／類別 ---
check("dashboardVariant：舊名稱輸入仍得舊變體（test-v1.15 相容）", () => {
  const v = lib.getDashboardVariants({ roles: ["護理長", "審查員"], title: "副護理長", isAdmin: false });
  if (v.join(",") !== "headNurse,reviewer,nurse") throw new Error(`實為 ${v.join(",")}`);
  const v2 = lib.getDashboardVariants({ roles: ["執行幹事", "召集人", "審查員"], title: "護理師", isAdmin: false });
  if (v2.join(",") !== "officer,convener,reviewer,nurse") throw new Error(`實為 ${v2.join(",")}`);
  const v3 = lib.getDashboardVariants({ roles: ["護理師"], title: "科主任", isAdmin: false });
  if (v3.join(",") !== "director,nurse") throw new Error(`實為 ${v3.join(",")}`);
  const v4 = lib.getDashboardVariants({ roles: ["護理師"], title: "督導", isAdmin: false });
  if (v4.join(",") !== "supervisor,nurse") throw new Error(`實為 ${v4.join(",")}`);
});
check("dashboardVariant：自訂名稱＋旗標／類別即生效", () => {
  const meta = lib.buildRoleMetaMap([{ name: "查核員", category: "reviewer", kind: "group" }]);
  const v = lib.getDashboardVariants(
    { roles: ["查核員"], title: "小組長", isAdmin: false },
    { roleMeta: meta },
  );
  if (!v.includes("reviewer")) throw new Error(`查核員未得 reviewer 變體：${v.join(",")}`);
  const flags = lib.buildTitleMetaMap([{ name: "小組長", isUnitHead: true }]);
  const v2 = lib.getDashboardVariants(
    { roles: ["護理師"], title: "小組長", isAdmin: false },
    { titleMeta: flags },
  );
  if (!v2.includes("headNurse")) throw new Error(`小組長未得 headNurse 變體：${v2.join(",")}`);
});

// --- 5. reviewerValidity 效期清理改走類別 ---
check("reviewerValidity：逾期只移除審查員類別角色", () => {
  const out = lib.activeRolesForReviewerExpiry(["審查員", "護理長"], "2020-01-01");
  if (out.join(",") !== "護理長") throw new Error(`實為 ${out.join(",")}`);
  const meta = lib.buildRoleMetaMap([{ name: "查核員", category: "reviewer", kind: "group" }]);
  const out2 = lib.activeRolesForReviewerExpiry(["查核員", "護理長"], "2020-01-01", new Date("2026-11-10"), meta);
  if (out2.join(",") !== "護理長") throw new Error(`實為 ${out2.join(",")}`);
  const out3 = lib.activeRolesForReviewerExpiry(["查核員", "護理長"], null, new Date("2026-11-10"), meta);
  if (out3.join(",") !== "查核員,護理長") throw new Error(`未到期不應移除：${out3.join(",")}`);
});

// --- 6. 靜態守衛：正式流程不再以固定名稱決定歸屬或權限 ---
const NAME_CHECKS = [
  'includes("護理長")',
  'includes("審查員")',
  'includes("督導")',
  'includes("召集人")',
  'includes("執行幹事")',
  'includes("副主任")',
  'includes("副護理長")',
];
function assertNoNameLogic(src, file) {
  for (const pat of NAME_CHECKS) {
    if (src.includes(pat)) throw new Error(`${file} 仍有 ${pat}`);
  }
}
check("AuditPage：身分改走 titleFlagsOf／hasRoleCategory，不再比對名稱", () => {
  assertNoNameLogic(auditSrc, "AuditPage");
  if (!auditSrc.includes("titleFlagsOf(")) throw new Error("未用 titleFlagsOf");
  if (!auditSrc.includes("convenerRoleNames(")) throw new Error("未用 convenerRoleNames");
});
check("ResultsPage：D12 護理長規則改走旗標／類別", () => {
  assertNoNameLogic(resultsSrc, "ResultsPage");
  if (!resultsSrc.includes("titleFlagsOf(")) throw new Error("未用 titleFlagsOf");
});
check("SchedulePage：單位主管改走旗標／類別", () => {
  assertNoNameLogic(scheduleSrc, "SchedulePage");
  if (!scheduleSrc.includes("titleFlagsOf(")) throw new Error("未用 titleFlagsOf");
});
check("DashboardPage：變體傳入詮釋資料", () => {
  if (!dashboardSrc.includes("getDashboardVariants(")) throw new Error("未呼叫 getDashboardVariants");
  if (!dashboardSrc.includes("roleMeta: orgMeta.roleMeta")) throw new Error("未傳 roleMeta");
  if (!dashboardSrc.includes("titleMetaById: orgMeta.titleMetaById")) throw new Error("未傳 titleMetaById");
});
check("TaskHandoffPage：管理範圍改走 scheduleScopeRoleNames", () => {
  if (!handoffSrc.includes("scheduleScopeRoleNames(")) throw new Error("未用 scheduleScopeRoleNames");
  if (handoffSrc.includes("GROUP_CONVENER_ROLES")) throw new Error("仍用 GROUP_CONVENER_ROLES");
});
check("ReviewerManagement：審查員名單改走 isReviewerRole＋meta", () => {
  if (!reviewerMgmtSrc.includes("isReviewerRole(person.roles, orgMeta.roleMeta)")) throw new Error("未用 isReviewerRole＋meta");
  if (reviewerMgmtSrc.includes('person.roles.includes("審查員")')) throw new Error("仍以名稱過濾審查員");
});
check("auth：登入效期清理載入角色主檔建 meta", () => {
  if (!authSrc.includes("buildRoleMetaMap(")) throw new Error("未建 roleMeta");
  if (!authSrc.includes("activeRolesForReviewerExpiry(storedRoles, reviewerAccessExpiresAt, new Date(), roleMeta)")) throw new Error("未傳 roleMeta");
});
check("firebase：readReviewRecords 範圍改走類別／旗標；grantReviewerRole 由 roles 集合解析", () => {
  if (!firebaseSrc.includes("hasRoleCategory(profile.roles, \"senior\", roleMeta)")) throw new Error("未用 senior 類別");
  if (!firebaseSrc.includes("resolveReviewerRoleName")) throw new Error("未由 roles 集合解析審查員角色");
  if (firebaseSrc.includes('roles.has("護理長")')) throw new Error("仍以名稱判單位範圍");
});
check("GroupsPage：角色建立寫入 category＋kind；職稱儲存寫入旗標；無 isUnitLevelRole 名稱呼叫", () => {
  if (!groupsSrc.includes("category: newRoleCategory,")) throw new Error("角色建立未寫 category");
  if (!groupsSrc.includes("kind: newRoleKind,")) throw new Error("角色建立未寫 kind");
  if (!groupsSrc.includes("isUnitHead: titleForm.isUnitHead,")) throw new Error("職稱儲存未寫旗標");
  if (groupsSrc.includes("isUnitLevelRole(")) throw new Error("仍呼叫 isUnitLevelRole");
  if (!groupsSrc.includes("roleEditKind")) throw new Error("角色編輯無 kind 狀態");
});

// --- 7. 自動補種已移除 ---
check("GroupsPage 無 ensureSeeds／SEED_GROUP_NAMES", () => {
  if (groupsSrc.includes("ensureSeeds")) throw new Error("仍有 ensureSeeds");
  if (groupsSrc.includes("SEED_GROUP_NAMES")) throw new Error("仍引用 SEED_GROUP_NAMES");
});
check("seed.ts 無 SYSTEM_ROLE_NAMES／SEED_GROUP_NAMES 匯出", () => {
  if (seedSrc.includes("SYSTEM_ROLE_NAMES")) throw new Error("仍有 SYSTEM_ROLE_NAMES");
  if (seedSrc.includes("SEED_GROUP_NAMES")) throw new Error("仍有 SEED_GROUP_NAMES");
});

// --- 8. 死碼與名稱聯集已刪 ---
check("lib/access.ts 已刪除；types.ts 無 Role 名稱聯集", () => {
  if (existsSync(`${ROOT}/src/lib/access.ts`)) throw new Error("access.ts 仍存在");
  if (typesSrc.includes("export type Role")) throw new Error("types.ts 仍有 Role 聯集");
  if (typesSrc.includes('"單位審查員"')) throw new Error("types.ts 仍有舊角色名稱");
});

// --- 9. 版號一致 ---
check("版號一致：version.ts 與 package.json 皆為 1.40.5", () => {
  if (!versionTs.includes('VERSION = "1.40.5"')) throw new Error("version.ts 不是 1.40.5");
  if (pkg.version !== "1.40.5") throw new Error(`package.json 是 ${pkg.version}`);
});

console.log(`\n${pass} passed`);
