/**
 * v1.39.3 斷言測試：權限頁列來源修復——無 kind 角色名不再被誤歸單位角色、
 * 權限頁進頁改走伺服器讀取（不吃陳舊快取）。
 * 用 esbuild 打包後在 node 執行（被測函式皆零依賴；載入路徑以原始碼層級
 * 回歸守衛驗證）。
 * 覆蓋：
 * - 無 kind 角色名「品管召集人」「召集人」「組長」「組員」→群組
 * - 無 kind 角色名「單位召集人」「單位執行幹事」「單位審查員」→單位角色
 * - kind 有值時 kind 優先於名稱
 * - 無 level 職稱名一律出現在單位目標
 * - 任何角色名至少出現在一個目標下（不靜默丟名）
 * - 權限頁 loadData 走 getDocsFromServer，不再走 roles／titles 的 cache-first
 */
import { build } from "esbuild";
import { writeFileSync, readFileSync } from "fs";
import { createRequire } from "module";

const ROOT = "/home/hatch/workspace/repos/QAweb";

const entry = `
import { deriveTemplateRowNames } from "${ROOT}/src/lib/permissions";
export { deriveTemplateRowNames };
`;
writeFileSync("/tmp/v1393-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v1393-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v1393-test-bundle.cjs",
  logLevel: "silent",
  define: { "import.meta.env": "{}" },
});
const require2 = createRequire("/tmp/v1393-test-bundle.cjs");
const L = require2("/tmp/v1393-test-bundle.cjs");

let passed = 0;
let failed = 0;
function assert(name, cond) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("FAIL:", name);
  }
}

/** 以集合方式比對名稱陣列（不依賴排序實作細節，只驗集合內容）。 */
function eqNames(actual, expected) {
  const a = [...actual].sort();
  const b = [...expected].sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// 使用者實際會建的名稱（無 kind，v1.39 起新文件不寫 kind）
const userNames = L.deriveTemplateRowNames(
  [
    { name: "品管召集人" },
    { name: "召集人" },
    { name: "組長" },
    { name: "組員" },
    { name: "品管組召集人" },
    { name: "品管組執行幹事" },
    { name: "執行幹事" },
    { name: "審查員" },
    { name: "副召集人" },
    { name: "教育幹事" },
    { name: "單位召集人" },
    { name: "單位執行幹事" },
    { name: "單位審查員" },
  ],
  [
    { name: "護理長" },
    { name: "單位護理長" },
    { name: "護理部主任" },
    { name: "副護理長" },
  ],
);
assert(
  "無 kind 角色名「品管召集人」「召集人」→群組（v1.39.2 會誤歸單位角色）",
  userNames.group.includes("品管召集人") &&
    userNames.group.includes("召集人") &&
    !userNames.unitRole.includes("品管召集人"),
);
assert(
  "無 kind 角色名「組長」「組員」→群組",
  userNames.group.includes("組長") && userNames.group.includes("組員"),
);
assert(
  "無 kind 角色名「副召集人」「教育幹事」等自訂名稱→群組，不靜默丟名",
  userNames.group.includes("副召集人") &&
    userNames.group.includes("教育幹事"),
);
assert(
  "無 kind 角色名「單位召集人」「單位執行幹事」「單位審查員」→單位角色",
  eqNames(userNames.unitRole, ["單位召集人", "單位執行幹事", "單位審查員"]),
);
assert(
  "無 level 職稱名一律出現在單位目標",
  eqNames(userNames.unit, ["副護理長", "單位護理長", "護理長", "護理部主任"]),
);

// kind 有值時 kind 優先於名稱
const kindWins = L.deriveTemplateRowNames(
  [
    { name: "召集人", kind: "unit" },
    { name: "單位召集人", kind: "group" },
  ],
  [],
);
assert(
  "kind 有值時 kind 優先：kind='unit' 的召集人→單位角色、kind='group' 的單位召集人→群組",
  eqNames(kindWins.unitRole, ["召集人"]) &&
    eqNames(kindWins.group, ["單位召集人"]),
);

// 任何角色名至少出現在一個目標下
const allNames = [
  ...userNames.group,
  ...userNames.unit,
  ...userNames.unitRole,
];
for (const n of [
  "品管召集人",
  "召集人",
  "組長",
  "組員",
  "單位召集人",
  "副召集人",
  "教育幹事",
]) {
  assert(`角色名「${n}」至少出現在一個目標下`, allNames.includes(n));
}

// 原始碼層級回歸守衛：權限頁進頁走伺服器讀取，不再走 cache-first
const pageSrc = readFileSync(
  `${ROOT}/src/features/PermissionManagementPage.tsx`,
  "utf8",
);
assert(
  "權限頁 loadData 用 getDocsFromServer 讀 roles",
  pageSrc.includes('getDocsFromServer(collection(db, "roles"))'),
);
assert(
  "權限頁 loadData 用 getDocsFromServer 讀 titles",
  pageSrc.includes('getDocsFromServer(collection(db, "titles"))'),
);
assert(
  "權限頁不再用 getCachedRefCollection 讀 roles／titles",
  !pageSrc.includes('getCachedRefCollection("roles"') &&
    !pageSrc.includes('getCachedRefCollection("titles"'),
);
assert(
  "權限頁讀取前先失效 refCache（roles／titles／permissionTemplates）",
  pageSrc.includes('invalidateRefCollection("roles")') &&
    pageSrc.includes('invalidateRefCollection("titles")') &&
    pageSrc.includes('invalidateRefCollection("permissionTemplates")'),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
