/**
 * v1.39.4 斷言測試：權限頁被 Firestore rules 擋住——permissionTemplates
 * 在 rules 完全沒有放行，伺服器讀取一律被拒，權限頁頂部只剩
 * "Missing or insufficient permissions."、三目標全空。
 * 覆蓋（皆為靜態守衛，無需 emulator）：
 * - firestore.rules 有且僅有一條 match /permissionTemplates/{id}
 * - 該條含 allow read: if isAuthed();（can() 需為所有登入者載入範本）
 * - 該條寫入限 isAdmin（create/update/delete），不放寬給一般登入者
 * - roles／titles 的讀取規則未被動到（仍為 allow read: if isAuthed();）
 * - 權限頁 loadData 改用 Promise.allSettled，單一集合失敗不拖垮整頁，
 *   且失敗集合名稱逐一進橫幅（permissionTemplates／roles／titles 三名皆有）
 */
import { readFileSync } from "fs";
import assert from "node:assert/strict";

const ROOT = "/home/hatch/workspace/repos/QAweb";
let pass = 0;
function check(name, fn) {
  fn();
  pass++;
  console.log(`ok - ${name}`);
}

const rules = readFileSync(`${ROOT}/firestore.rules`, "utf8");
const page = readFileSync(
  `${ROOT}/src/features/PermissionManagementPage.tsx`,
  "utf8",
);

// --- rules：permissionTemplates 有且僅有一條 ---
const ptMatches = rules.match(/match \/permissionTemplates\/\{id\} \{/g) ?? [];
check("rules 有且僅有一條 permissionTemplates match", () => {
  assert.equal(ptMatches.length, 1);
});
const ptBlock = rules.slice(
  rules.indexOf("match /permissionTemplates/{id} {"),
  rules.indexOf("match /permissionTemplates/{id} {") + 400,
);
check("permissionTemplates 讀取為登入者可讀", () => {
  assert.match(ptBlock, /allow read: if isAuthed\(\);/);
});
check("permissionTemplates 寫入限管理員", () => {
  assert.match(ptBlock, /allow create, update, delete: if isAdmin\(\);/);
  assert.doesNotMatch(ptBlock, /allow (read, )?write: if isAuthed\(\);/);
});

// --- rules：roles／titles 讀取規則未被動到 ---
for (const coll of ["roles", "titles"]) {
  check(`${coll} 讀取規則仍為登入者可讀`, () => {
    const idx = rules.indexOf(`match /${coll}/{id} {`);
    assert.ok(idx >= 0, `${coll} match 不存在`);
    assert.match(rules.slice(idx, idx + 200), /allow read: if isAuthed\(\);/);
  });
}

// --- loadData：allSettled＋逐集合失敗標示 ---
const loadDataSrc = page.slice(
  page.indexOf("const loadData = useCallback"),
  page.indexOf("useEffect(() => {", page.indexOf("const loadData = useCallback")),
);
check("loadData 用 Promise.allSettled 讀三集合", () => {
  assert.match(loadDataSrc, /Promise\.allSettled\(\[/);
  assert.doesNotMatch(loadDataSrc, /Promise\.all\(\[/);
});
for (const label of [
  "權限範本（permissionTemplates）",
  "角色（roles）",
  "職稱（titles）",
]) {
  check(`失敗集合名稱有標示：${label}`, () => {
    assert.ok(loadDataSrc.includes(`failures.push("${label}")`));
  });
}
check("失敗時橫幅寫明其餘資料照常顯示", () => {
  assert.ok(loadDataSrc.includes("部分資料讀取失敗："));
  assert.ok(loadDataSrc.includes("其餘資料照常顯示"));
});

console.log(`\n${pass} passed`);
