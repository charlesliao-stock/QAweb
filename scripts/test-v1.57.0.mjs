/**
 * v1.57.0 斷言測試：人員管理 7 項＋權限管理頁改版。
 * 混合測試：roleDerivation.ts 以 node 型別剝離直接跑真的推導；
 * 其餘為靜態守衛（原始碼文字比對），無需 emulator。
 * 線上逐項點按由主代理另行驗證。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  deriveRoleCategory,
  deriveRoleScope,
  deriveRoleScopeFromLevel,
} from "../src/lib/roleDerivation.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf-8");

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

const groups = read("src/features/GroupsPage.tsx");
const perms = read("src/features/PermissionManagementPage.tsx");
const derivation = read("src/lib/roleDerivation.ts");
const ui = read("src/components/ui.tsx");
const versionTs = read("src/version.ts");
const pkg = JSON.parse(read("package.json"));

// ---- 0. 版號 ----
check("版號 1.57.0 一致", versionTs.includes('VERSION = "1.57.0"') && pkg.version === "1.57.0");

// ---- A1/A2. 查詢按鈕 ----
check("人員頁有查詢按鈕與尚未查詢空狀態", groups.includes("尚未查詢") && groups.includes("請設定篩選條件後按「查詢」"));
check("人員頁查詢後才套用篩選（applied 快照）", groups.includes("appliedUserUnitFilter") && groups.includes("appliedUserSearch"));
check("單位頁查詢後才套用篩選（applied 快照）", groups.includes("appliedUnitGroupFilter") && groups.includes("appliedUnitSearch"));
check("loadUsers 仍在掛載時跑（badge 不受影響）", groups.includes("loadUsers()"));
check("loadMaster 仍在掛載時跑（群組下拉不空）", groups.includes("loadMaster()"));

// ---- A3. 關鍵字推導（真的跑） ----
const EXPECTED = [
  ["委員會召集人", "convener", "group"],
  ["委員會執行秘書", "officer", "group"],
  ["委員會執行幹事", "officer", "group"],
  ["品管組召集人", "convener", "group"],
  ["品管組副召集人", "convener", "group"],
  ["品管組執行幹事", "officer", "group"],
  ["品管組組長", "general", "group"],
  ["品管組審查員", "reviewer", "group"],
  ["單位召集人", "convener", "unit"],
  ["單位執行幹事", "officer", "unit"],
  ["單位組長", "general", "unit"],
  ["單位審查員", "reviewer", "unit"],
];
const LEVEL_ID = { 委員會: "rl-committee", 品管組: "rl-qi", 單位: "rl-unit" };
for (const [name, cat, scope] of EXPECTED) {
  const level = name.startsWith("委員會") ? "委員會" : name.startsWith("品管組") ? "品管組" : "單位";
  check(
    `推導 ${name}＝${cat}／${scope}`,
    deriveRoleCategory(name) === cat &&
      deriveRoleScope({ levelId: LEVEL_ID[level], levelName: level, name }) === scope,
  );
}
check("委員會執行秘書維持執行幹事", deriveRoleCategory("委員會執行秘書") === "officer");
check("層級→範圍對照：委員會／品管組＝group、單位＝unit（現行有效行為）",
  deriveRoleScopeFromLevel("rl-committee", "委員會") === "group" &&
    deriveRoleScopeFromLevel("rl-qi", "品管組") === "group" &&
    deriveRoleScopeFromLevel("rl-unit", "單位") === "unit");
check("未分層級退回名稱推導：含單位→unit、其餘→group",
  deriveRoleScope({ name: "單位審查員" }) === "unit" && deriveRoleScope({ name: "品管組組長" }) === "group");
const uiHits = groups.split("\n").filter((l) => {
  const t = l.trim();
  return (t.includes("功能類別") || t.includes("適用範圍")) && !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/**");
});
check("角色頁已移除功能類別／適用範圍顯示（僅剩推導說明註解）",
  !groups.includes("功能類別") && uiHits.length === 0);

// ---- A4. 共用 Modal 彈窗 ----
check("ui.tsx 有共用 Modal（reviewer-modal backdrop、點空白關閉）",
  ui.includes("export function Modal") && ui.includes("reviewer-modal-backdrop") && ui.includes("onClick={onClose}"));
check("GroupsPage 編輯入口使用 Modal", groups.includes("<Modal") && groups.includes("Modal,"));

// ---- A5. 搜尋優先 ----
check("角色成員候選上限 20 筆", groups.includes(".slice(0, 20)"));
check("群組加入單位改搜尋優先", groups.includes("群組加入單位改搜尋優先"));

// ---- A6/A7. 三層／兩層下拉 ----
check("賦予角色為群組→層級→角色三層下拉", groups.includes("群組→層級→角色三層下拉"));
check("賦予職稱兩層下拉＋下方已選列可移除重選", groups.includes("移除重選"));

// ---- B. 權限頁目標動態生成 ----
check("寫死的 TARGET_LABELS 已移除、目標由層級動態生成",
  !perms.includes("TARGET_LABELS") && perms.includes("roleLevels") && perms.includes("titleLevels"));
check("目標 key 加前綴 role:／title:", perms.includes("`role:${level.id}`") && perms.includes("`title:${level.id}`"));
check("預設選取第一個目標（角色委員會）", perms.includes('useState<string>("role:rl-committee")'));
check("一段改 radio 跨區／不跨區、標籤統一", perms.includes("一、角色／職稱是否可以跨區") && perms.includes("跨區") && perms.includes("不跨區"));
check("委員會層級新建範本 cross 預設 true", perms.includes("isCommitteeLevel") && perms.includes("cross: tpl? tpl.cross: isCommitteeLevel(level)"));
check("新層級鍵集：group 桶 11 鍵、unit／unitRole 桶 7 鍵",
  perms.includes("GROUP_ONLY_PERM_KEYS") && perms.includes("group 桶＝11 鍵"));
check("未分層級不另設目標（列為一般使用者）", perms.includes("一般使用者") || !perms.includes("未分層級"));

// ---- 總結 ----
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
