/**
 * v1.58.0 斷言測試：刪除「其他角色」／「督導轄區群組」，改由分工表衍生 roles
 * 與部級職稱負責單位承接；授予審查員流程加選群組步驟。
 * 混合測試：roleIdentity.ts 以 esbuild 打包後真的跑推導；
 * 其餘為靜態守衛（原始碼文字比對），無需 emulator。
 * 線上逐項點按由主代理另行驗證。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildSync } from "esbuild";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf-8");

// roleIdentity.ts 有 extensionless import（./orgMeta），node 型別剝離跑不到；
// 用 esbuild 打包成單檔 ESM 再 import，跑真的推導函式。
const bundled = join(tmpdir(), "qi-fix-158-roleIdentity.mjs");
buildSync({
  entryPoints: [join(ROOT, "src/lib/roleIdentity.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundled,
  logLevel: "silent",
});
const {
  deriveRoles,
  deriveStoredRoles,
  groupedRolesSegments,
} = await import(bundled);

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

const groups = read("src/features/GroupsPage.tsx");
const identity = read("src/lib/roleIdentity.ts");
const firebase = read("src/lib/firebase.ts");
const reviewerMgmt = read("src/features/ReviewerManagement.tsx");
const auth = read("src/lib/auth.tsx");
const dashboard = read("src/features/DashboardPage.tsx");
const supervisor = read("src/features/dashboard/SupervisorTab.tsx");
const migration = read("src/lib/levelMigration.ts");
const versionTs = read("src/version.ts");
const pkg = JSON.parse(read("package.json"));

// ---- 0. 版號 ----
check("版號 1.58.0 一致", versionTs.includes('VERSION = "1.58.0"') && pkg.version === "1.58.0");

// ---- 1. deriveStoredRoles（真的跑） ----
check(
  "分工表角色全進聯集",
  eq(
    deriveStoredRoles(
      [
        { groupId: "g1", roles: ["品管組審查員"] },
        { groupId: "g2", roles: ["單位召集人"] },
      ],
      [],
    ).sort(),
    ["品管組審查員", "單位召集人"].sort(),
  ),
);
check(
  "全域角色直接消失（只留系統管理員）",
  eq(
    deriveStoredRoles([], ["品管組組長", "系統管理員"]),
    ["系統管理員"],
  ),
);
check(
  "無分工表＋前次一般人員 → 保留一般人員",
  eq(deriveStoredRoles([], ["一般人員"]), ["一般人員"]),
);
check(
  "無分工表＋無前次 roles → 預設一般人員",
  eq(deriveStoredRoles([], []), ["一般人員"]),
);
check(
  "系統管理員與分工表角色並存",
  eq(
    deriveStoredRoles(
      [{ groupId: "g1", roles: ["品管組召集人"] }],
      ["系統管理員"],
    ).sort(),
    ["品管組召集人", "系統管理員"].sort(),
  ),
);
check(
  "空 groupId 的列不計入衍生",
  eq(
    deriveStoredRoles([{ groupId: "", roles: ["品管組組長"] }], []),
    ["一般人員"],
  ),
);
check(
  "deriveRoles 本身不變",
  eq(
    deriveRoles([{ groupId: "g1", roles: ["A", "B"] }, { groupId: "g2", roles: ["B", "C"] }]).sort(),
    ["A", "B", "C"].sort(),
  ),
);

// ---- 1b. 人員列表角色欄不再有「其他」段（真的跑） ----
check(
  "groupedRolesSegments 只列分工表段",
  eq(
    groupedRolesSegments(
      [{ groupId: "g1", roles: ["品管組審查員"] }],
      (id) => (id === "g1" ? "病房組" : id),
    ),
    [{ label: "病房組", roles: ["品管組審查員"] }],
  ),
);
check(
  "無 membership 者角色欄為空（不再顯示其他角色）",
  eq(groupedRolesSegments([], () => "病房組"), []),
);

// ---- 2. GroupsPage：其他角色／轄區群組已刪 ----
check("GroupsPage 無 otherRoles 殘留", !groups.includes("otherRoles"));
check("GroupsPage 無 districtGroupIds 殘留", !groups.includes("districtGroupIds"));
check("GroupsPage 無 toggleOtherRole 殘留", !groups.includes("toggleOtherRole"));
check("GroupsPage 無 roleFormSections 殘留", !groups.includes("roleFormSections"));
check(
  "handleUserSave 用 deriveStoredRoles 算 roles",
  groups.includes("deriveStoredRoles(") &&
    groups.includes("previousRoles") &&
    groups.includes("users.find((u) => u.staffId === view.staffId)?.roles"),
);
check(
  "儲存 payload 寫 titleUnitCodes",
  groups.includes("titleUnitCodes,"),
);
check(
  "負責單位只在部級督導時顯示",
  groups.includes("showTitleUnits") &&
    groups.includes('formTitleLevel?.name === "部級"') &&
    groups.includes("isDistrictHead === true"),
);
check(
  "負責單位搜尋優先（空搜尋不列候選、上限 20 筆）",
  groups.includes("titleUnitCandidates") &&
    groups.includes('if (kw === "") return [];') &&
    groups.includes(".slice(0, 20)"),
);
check(
  "換職稱／移除重選時清空負責單位",
  groups.includes("titleUnitCodes: []"),
);
check(
  "匯入更新不再保留既有全域角色",
  !groups.includes("更新 memberships 時保留既有全域角色") &&
    groups.includes("patch.roles = deriveStoredRoles(v.memberships, existing?.roles ?? []);"),
);
check(
  "匯入新建預設 titleUnitCodes 空陣列",
  groups.includes("titleUnitCodes: [],"),
);
check(
  "removeRoleFromUser／addRoleToUser 用 deriveStoredRoles 重算",
  groups.includes("const roles = deriveStoredRoles(memberships, row.roles);"),
);

// ---- 3. roleIdentity：otherRolesOf 已刪 ----
check("otherRolesOf 已刪除", !identity.includes("otherRolesOf"));
check("deriveStoredRoles 在 roleIdentity.ts", identity.includes("export function deriveStoredRoles"));

// ---- 4. grantReviewerRole 加選群組步驟 ----
check(
  "grantReviewerRole 簽名含 groupId、必選群組",
  firebase.includes("export async function grantReviewerRole(") &&
    firebase.includes("groupId: string") &&
    firebase.includes("請先選擇授予群組"),
);
check(
  "授予寫入分工表＋衍生聯集，不再 arrayUnion roles",
  firebase.includes("mergeMembership(") &&
    firebase.includes("deriveStoredRoles(memberships, beforeRoles)") &&
    !firebase.includes("arrayUnion(reviewerRoleName)"),
);
check(
  "ReviewerManagement 對話框有授予群組下拉、未選不能授予",
  reviewerMgmt.includes("grantGroupId") &&
    reviewerMgmt.includes("授予群組 *") &&
    reviewerMgmt.includes("disabled={Boolean(savingId) || !canWriteRoles || !grantGroupId}"),
);
check(
  "授予後本機狀態同步群組",
  reviewerMgmt.includes("groupIds: [...new Set([...item.groupIds, grantGroupId])]"),
);

// ---- 5. 督導轄區改由 titleUnitCodes 承接 ----
check("auth.tsx 載入 titleUnitCodes、不再讀轄區", auth.includes("titleUnitCodes") && !auth.includes("districtGroupIds"));
check(
  "DashboardPage 傳 titleUnitCodes 給 SupervisorTab",
  dashboard.includes("titleUnitCodes={user?.titleUnitCodes ?? []}"),
);
check(
  "SupervisorTab 按單位代碼過濾轄區單位",
  supervisor.includes("titleUnitCodes.includes(u.code)") &&
    !supervisor.includes("districtGroupIds"),
);
check(
  "SupervisorTab 空值訊息改指負責單位設定",
  supervisor.includes("尚未設定負責單位") && supervisor.includes("負責單位設定"),
);

// ---- 6. levelMigration 舊名更名仍寫回 roles（由分工表重算） ----
check(
  "levelMigration 更名後 roles 由分工表重算",
  migration.includes("deriveStoredRoles(") && migration.includes("import { deriveStoredRoles }"),
);

// ---- 總結 ----
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
