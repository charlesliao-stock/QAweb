/**
 * v1.56.0 斷言測試：職稱／角色介面對稱、組織與設定收成管理員限定、任務交接移入品質管理。
 * 靜態守衛（原始碼文字比對），無需 emulator。線上逐項點按由主代理另行驗證。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
const perms = read("src/lib/permissions.ts");
const usePerms = read("src/lib/usePermissions.ts");
const app = read("src/app/App.tsx");
const versionTs = read("src/version.ts");
const pkg = JSON.parse(read("package.json"));

// ---- 1. 角色列補編輯按鈕 ----
const roleTable = groups.slice(
  groups.indexOf("function renderRoleTable"),
  groups.indexOf("function renderRoleTable") + 3000,
);
check(
  "角色列有編輯按鈕且呼叫 openRoleMembers",
  roleTable.includes("<Pencil size={13} /> 編輯") &&
    roleTable.includes("onClick={() => openRoleMembers(row.id)}"),
);
check(
  "角色列操作順序：編輯 → 成員管理 → 刪除",
  roleTable.indexOf("編輯") < roleTable.indexOf("成員管理") &&
    roleTable.indexOf("成員管理") < roleTable.indexOf("刪除"),
);
const titleTable = groups.slice(
  groups.indexOf("function renderTitleTable"),
  groups.indexOf("function renderTitleTable") + 3000,
);
check(
  "職稱列操作順序不變：編輯 → 成員管理 → 刪除",
  titleTable.indexOf("編輯") < titleTable.indexOf("成員管理") &&
    titleTable.indexOf("成員管理") < titleTable.indexOf("刪除"),
);

// ---- 2. 成員面板對稱 ----
check("職稱成員面板關閉鈕為返回職稱清單", groups.includes("返回職稱清單"));
check("角色成員面板關閉鈕為返回角色清單", groups.includes("返回角色清單"));
check(
  "角色編輯儲存鈕文字為儲存修改",
  groups.includes('{roleEditSaving ? "儲存中…" : "儲存修改"}'),
);
check(
  "角色建立／編輯下拉框皆用 select-wrap（無裸 text-input select）",
  !/<select\n\s+className="text-input"/.test(groups),
);
check(
  "職稱加入改勾選批次：titleAddChecked state 存在",
  groups.includes("const [titleAddChecked, setTitleAddChecked] = useState<string[]>([]);"),
);
check(
  "職稱加入改勾選批次：handleTitleMembersAdd 存在、單筆版已移除",
  groups.includes("async function handleTitleMembersAdd()") &&
    !groups.includes("async function handleTitleMemberAdd("),
);
check(
  "職稱候選表有全選勾選與加入所選按鈕",
  groups.includes('aria-label="全選"') &&
    groups.includes("加入所選（{titleAddChecked.length}）"),
);
check(
  "職稱清單底部有說明文字",
  groups.includes("職稱以名稱唯一；可在此新增職稱、管理成員或刪除職稱。"),
);
check(
  "無維護限品管執行幹事的舊說明文字",
  !groups.includes("維護限品管執行幹事"),
);

// ---- 3. 讀取／空狀態對稱 ----
check(
  "角色頁有 rolesLoading 旗標",
  groups.includes("const [rolesLoading, setRolesLoading] = useState(true);") &&
    groups.includes("rolesLoading || levelsLoading"),
);
check(
  "角色空狀態文案與職稱對齊",
  groups.includes('description="使用右上角「新增角色」或「批次上傳」建立角色。"') &&
    groups.includes('description="使用右上角「新增職稱」或「批次上傳」建立職稱。"'),
);

// ---- 4. 組織與設定收成管理員限定 ----
check("GroupsPage 無 canManageMaster 殘留", !groups.includes("canManageMaster"));
check(
  "can() 對管理員專屬鍵只認 isAdmin",
  usePerms.includes("ADMIN_ONLY_PERM_KEYS") &&
    usePerms.includes("if ((ADMIN_ONLY_PERM_KEYS as readonly string[]).includes(key)) {") &&
    usePerms.includes("return isAdmin;"),
);
check(
  "管理員專屬鍵含 page.groups／page.admin／page.permissions／manageRoles",
  ["page.groups", "page.admin", "page.permissions", "manageRoles"].every((k) =>
    perms.includes(`"${k}"`),
  ) &&
    perms.includes("ADMIN_ONLY_PERM_KEYS"),
);

// ---- 5. 任務交接移入品質管理 ----
const navGroups = app.slice(app.indexOf("const NAV_GROUPS"), app.indexOf("];", app.indexOf("const NAV_GROUPS")));
const qualitySection = navGroups.slice(
  navGroups.indexOf('label: "品質管理"'),
  navGroups.indexOf('label: "組織與設定"'),
);
const orgSection = navGroups.slice(navGroups.indexOf('label: "組織與設定"'));
check(
  "任務交接在品質管理分區（結果分析之後、CAPA 之前）",
  qualitySection.includes('{ id: "handoff"') &&
    qualitySection.indexOf('{ id: "results"') < qualitySection.indexOf('{ id: "handoff"') &&
    qualitySection.indexOf('{ id: "handoff"') < qualitySection.indexOf('{ id: "capa"'),
);
check("任務交接已不在組織與設定分區", !orgSection.includes('{ id: "handoff"'));
check(
  "任務交接權限不變：仍為 page.handoff、仍列群組專屬鍵",
  perms.includes('handoff: "page.handoff"') &&
    perms.includes('"page.handoff"') &&
    app.includes('{page === "handoff" && <TaskHandoffPage onAction={notify} />}'),
);

// ---- 6. 版號 ----
check("版號 1.56.0（version.ts）", versionTs.includes('VERSION = "1.56.0"'));
check("版號 1.56.0（package.json）", pkg.version === "1.56.0");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
