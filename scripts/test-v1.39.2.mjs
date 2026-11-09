/**
 * v1.39.2 斷言測試：權限頁列來源只取實際建立的職稱／角色（deriveTemplateRowNames）。
 * 用 esbuild 打包後在 node 執行（被測函式皆零依賴）。
 * 覆蓋：無文件時三目標皆空列；kind 有值時以 kind 為準；舊文件無 kind 時
 * 以名稱分類（v1.39.3：含「單位」→單位角色，其餘一律→群組，不讀 groupId；
 * 不只認固定清單）；系統管理員／一般人員永不列入；同名去重；職稱一律歸單位。
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";

const ROOT = "/home/hatch/workspace/repos/QAweb";

const entry = `
import { deriveTemplateRowNames } from "${ROOT}/src/lib/permissions";
export { deriveTemplateRowNames };
`;
writeFileSync("/tmp/v1392-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v1392-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v1392-test-bundle.cjs",
  logLevel: "silent",
  define: { "import.meta.env": "{}" },
});
const require2 = createRequire("/tmp/v1392-test-bundle.cjs");
const L = require2("/tmp/v1392-test-bundle.cjs");

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

const empty = L.deriveTemplateRowNames([], []);
assert(
  "無文件時三目標皆空列",
  empty.group.length === 0 &&
    empty.unit.length === 0 &&
    empty.unitRole.length === 0,
);

const byKind = L.deriveTemplateRowNames(
  [
    { name: "召集人", kind: "group" },
    { name: "單位召集人", kind: "unit" },
  ],
  [{ name: "護理長" }],
);
assert(
  "kind 有值時以 kind 為準：group→群組、unit→單位角色、職稱→單位",
  eqNames(byKind.group, ["召集人"]) &&
    eqNames(byKind.unit, ["護理長"]) &&
    eqNames(byKind.unitRole, ["單位召集人"]),
);

const legacy = L.deriveTemplateRowNames(
  [
    { name: "召集人" },
    { name: "品管組召集人" },
    { name: "單位召集人" },
    { name: "單位執行幹事" },
    { name: "副召集人" },
    { name: "系統管理員" },
    { name: "一般人員" },
  ],
  [{ name: "護理長" }, { name: "召集人" }, { name: "護理長" }],
);
assert(
  "舊文件無 kind 時以名稱分類（v1.39.3：含「單位」→單位角色，其餘一律→群組，不讀 groupId）",
  eqNames(legacy.group, ["召集人", "品管組召集人", "副召集人"]) &&
    eqNames(legacy.unitRole, ["單位召集人", "單位執行幹事"]) &&
    eqNames(legacy.unit, ["護理長", "召集人"]),
);
assert(
  "系統管理員、一般人員永不列入",
  !legacy.group.includes("系統管理員") &&
    !legacy.unitRole.includes("一般人員") &&
    !legacy.unit.includes("系統管理員"),
);
assert(
  "同名去重：職稱護理長出現兩次只列一次",
  legacy.unit.filter((n) => n === "護理長").length === 1,
);

const bothKinds = L.deriveTemplateRowNames(
  [
    { name: "召集人", kind: "group" },
    { name: "召集人", kind: "unit" },
  ],
  [],
);
assert(
  "同名分屬兩類時兩邊都列（各類一名一檔）",
  eqNames(bothKinds.group, ["召集人"]) &&
    eqNames(bothKinds.unitRole, ["召集人"]),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
