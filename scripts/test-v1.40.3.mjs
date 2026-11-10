/**
 * v1.40.3 斷言測試：人員管理頁職稱、角色對應修正（靜態守衛＋函式驗證，無需 emulator）。
 *
 * 調查結論（寫死在斷言裡，防回退）：
 * - 人員表單的職稱下拉、角色勾選，與職稱／角色頁籤共用同一來源：
 *   職稱 ← titles state（Firestore titles 集合）；角色 ← roleOptions state
 *   （Firestore roles 集合）；角色頁籤清單 roleRows 由 roleOptions 衍生。
 * - 過去的不一致：人員表單與角色成員管理的角色分區，靠 roleIdentity.ts 的
 *   寫死名單 isGroupScopedRole（10 個名稱）決定——角色分類建立的角色若不在
 *   名單內（例如「全球」「組長」「品管召集人」），在人員表單只能進「其他角色」、
 *   永遠寫不進 membership；權限判斷的群組角色範本只認 membership 指派，
 *   該角色在權限管理設好的群組權限永遠無法生效。
 * - 本版修正：分區不再看寫死名稱清單，改由指派情境決定——管理員在人員表單
 *   選群組＋角色就寫 membership，不指定群組就進「其他角色」（全域）；
 *   角色成員管理亦同（單位級角色仍以其單位所屬群組計）。
 *   儲存模型不變（memberships＋roles 聯集＋titleId／title）；更名／刪除
 *   對人員的同步更新維持原樣。
 * 覆蓋：
 * 1. 職稱下拉選項來源就是 titles state（無寫死名單）
 * 2. 群組＋角色配對列出全部 roleOptions；其他角色亦列出全部 roleOptions
 * 3. 編輯人員時 otherRoles 切分改為 membership 依據（聯集中未進 membership 者）
 * 4. addRoleToUser：有指定群組才寫 membership，未指定只進聯集
 * 5. 角色成員管理：非單位級角色一律要求選群組、顯示群組選單
 * 6. 匯入更新：保留的全域角色改為「未出現在舊 membership 者」
 * 7. GroupsPage.tsx 內不再出現 isGroupScopedRole（寫死名單退出指派路徑）
 * 8. isGroupScopedRole 函式本身保留（test-v1.21 相容；orgImport 選填 ctx 仍用）
 * 9. 版號一致：src/version.ts 與 package.json 皆為 1.40.3
 */
import { createRequire } from "node:module";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "/home/hatch/workspace/repos/QAweb";
const groupsSrc = readFileSync(`${ROOT}/src/features/GroupsPage.tsx`, "utf8");
const roleIdentitySrc = readFileSync(`${ROOT}/src/lib/roleIdentity.ts`, "utf8");
const versionTs = readFileSync(`${ROOT}/src/version.ts`, "utf8");
const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));

let pass = 0;
function check(name, fn) {
  fn();
  pass++;
  console.log(`ok - ${name}`);
}

// --- 1. 職稱下拉來源就是 titles state ---
check("人員表單職稱下拉選項來自 titles state", () => {
  if (!groupsSrc.includes("{titles.map((t) => ("))
    throw new Error("職稱下拉未以 titles.map 產生選項");
  if (!groupsSrc.includes("value={userForm.titleId}"))
    throw new Error("職稱下拉未綁定 userForm.titleId");
});

// --- 2. 兩區角色皆列出全部 roleOptions ---
check("群組＋角色配對列出全部 roleOptions（無寫死名單過濾）", () => {
  const section = groupsSrc.split('title="群組＋角色"')[1];
  if (!section) throw new Error("找不到「群組＋角色」區段");
  const head = section.slice(0, 1200);
  if (!head.includes("{roleOptions.map((r) => ("))
    throw new Error("群組＋角色未直接以 roleOptions.map 列出");
  if (head.includes("isGroupScopedRole"))
    throw new Error("群組＋角色仍用 isGroupScopedRole 過濾");
});
check("其他角色列出全部 roleOptions（無寫死名單過濾）", () => {
  const section = groupsSrc.split('title="其他角色"')[1];
  if (!section) throw new Error("找不到「其他角色」區段");
  const head = section.slice(0, 1200);
  if (!head.includes("{roleOptions.map((r) => ("))
    throw new Error("其他角色未直接以 roleOptions.map 列出");
  if (head.includes("isGroupScopedRole"))
    throw new Error("其他角色仍用 isGroupScopedRole 過濾");
});

// --- 3. 編輯切分改為 membership 依據 ---
check("編輯人員時 otherRoles 以 membership 切分（非寫死名單）", () => {
  if (!groupsSrc.includes("!row.memberships.some((membership) => membership.roles.includes(r))"))
    throw new Error("找不到 membership 依據的 otherRoles 切分");
});

// --- 4. addRoleToUser：有群組才寫 membership ---
check("addRoleToUser 只在有指定群組時寫 membership", () => {
  const fn = groupsSrc.split("function addRoleToUser")[1].slice(0, 900);
  if (!fn.includes("if (groupId) {"))
    throw new Error("addRoleToUser 未改為 if (groupId)");
  if (fn.includes("isGroupScopedRole"))
    throw new Error("addRoleToUser 仍用 isGroupScopedRole");
});

// --- 5. 角色成員管理：非單位級一律指定群組 ---
check("角色成員管理非單位級角色一律要求選群組", () => {
  const fn = groupsSrc.split("async function handleRoleMembersAdd")[1].slice(0, 1400);
  if (fn.includes("isGroupScopedRole"))
    throw new Error("handleRoleMembersAdd 仍用 isGroupScopedRole");
  if (!fn.includes('onAction("請先選擇此角色適用的群組")'))
    throw new Error("未要求選擇適用群組");
});
check("角色成員管理群組選單對非單位級角色皆顯示", () => {
  if (!groupsSrc.includes("{managingRole.kind !== \"unit\" && ("))
    throw new Error("群組選單未以角色 kind 決定顯示");
  if (groupsSrc.includes("isUnitLevelRole(managingRole.name)"))
    throw new Error("群組選單仍以名稱決定顯示");
});

// --- 6. 匯入更新保留全域角色改為 membership 依據 ---
check("匯入更新保留的全域角色以舊 membership 切分", () => {
  if (!groupsSrc.includes("deriveRoles(existing?.memberships ?? [])"))
    throw new Error("找不到以舊 membership 切分的 keep 邏輯");
  if (!groupsSrc.includes("!oldMembershipRoles.has(x)"))
    throw new Error("keep 未以 oldMembershipRoles 過濾");
});

// --- 7. GroupsPage 不再出現 isGroupScopedRole ---
check("GroupsPage.tsx 內無 isGroupScopedRole（寫死名單退出指派路徑）", () => {
  if (groupsSrc.includes("isGroupScopedRole"))
    throw new Error("GroupsPage 仍有 isGroupScopedRole 殘留");
});

// --- 8. 函式本身保留（test-v1.21 相容）＋ deriveRoles 行為 ---
check("roleIdentity.ts 仍匯出 isGroupScopedRole（相容舊測試）", () => {
  if (!roleIdentitySrc.includes("export function isGroupScopedRole"))
    throw new Error("isGroupScopedRole 被刪，test-v1.21 會失敗");
});
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
  "/tmp/v1-40-3-test.ts",
  `export { deriveRoles, deriveGroupIds } from "${ROOT}/src/lib/roleIdentity";`,
);
await build({
  entryPoints: ["/tmp/v1-40-3-test.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v1-40-3-test.cjs",
  logLevel: "silent",
});
const lib = createRequire("/tmp/v1-40-3-test.cjs")("/tmp/v1-40-3-test.cjs");
check("deriveRoles：匯入 keep 邏輯——舊 membership 角色不保留、其餘保留", () => {
  const oldMembershipRoles = new Set(
    lib.deriveRoles([{ groupId: "g1", roles: ["品管組審查員"] }]),
  );
  const keep = ["品管組審查員", "全球", "系統管理員"].filter(
    (x) => !oldMembershipRoles.has(x),
  );
  if (keep.join(",") !== "全球,系統管理員")
    throw new Error(`keep 實為 ${keep.join(",")}`);
});

// --- 9. 角色／職稱頁籤清單與人員表單同源 ---
check("角色頁籤清單由 roleOptions 衍生", () => {
  if (!groupsSrc.includes("roleOptions.map((r) => ({"))
    throw new Error("roleRows 未由 roleOptions 衍生");
});
check("職稱頁籤與人員表單共用 titles state", () => {
  if (!groupsSrc.includes("const [titles, setTitles] = useState<TitleRow[]>([]);"))
    throw new Error("找不到 titles state");
});

// --- 10. 更名／刪除同步維持 ---
check("角色刪除仍同步移除所有人員的該角色", () => {
  if (!groupsSrc.includes("將同時從所有人員的角色中移除此角色"))
    throw new Error("角色刪除同步移除文案消失");
});
check("職稱刪除仍在有人使用時擋下", () => {
  if (!groupsSrc.includes("尚有人員使用，無法刪除"))
    throw new Error("職稱刪除使用檢查消失");
});

// --- 11. 版號一致 ---
check("版號一致：version.ts 與 package.json 皆為 1.40.3", () => {
  if (!versionTs.includes('VERSION = "1.40.3"'))
    throw new Error("version.ts 不是 1.40.3");
  if (pkg.version !== "1.40.3")
    throw new Error(`package.json 是 ${pkg.version}`);
});

console.log(`\n${pass} passed`);
