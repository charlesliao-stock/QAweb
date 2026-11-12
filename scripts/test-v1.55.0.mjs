/**
 * v1.55.0 斷言測試：人員管理職稱／角色分層級版面（方案 A）。
 * 函式驗證（esbuild 打包 orgLevels.ts 實跑）＋靜態守衛，無需 emulator。
 * 線上逐項點按由主代理另行驗證。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- 實跑 orgLevels.ts ----
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
writeFileSync(
  "/tmp/v1-55-0-test.ts",
  `export * from "${ROOT}/src/lib/orgLevels.ts";`,
);
await esbuild.build({
  entryPoints: ["/tmp/v1-55-0-test.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v1-55-0-test.cjs",
  logLevel: "silent",
});
const lib = require("/tmp/v1-55-0-test.cjs");

// 預設層級與順序
check(
  "職稱預設層級 部級→單位",
  eq(lib.DEFAULT_TITLE_LEVELS.map((l) => l.name), ["部級", "單位"]),
);
check(
  "角色預設層級 委員會→品管組→單位",
  eq(lib.DEFAULT_ROLE_LEVELS.map((l) => l.name), ["委員會", "品管組", "單位"]),
);
// 職稱遷移對照
check(
  "職稱遷移：主任／副主任／督導→部級",
  ["主任", "副主任", "督導"].every((n) => lib.titleLevelIdForName(n) === "tl-dept"),
);
check(
  "職稱遷移：護理長／副護理長／護理師→單位",
  ["護理長", "副護理長", "護理師"].every((n) => lib.titleLevelIdForName(n) === "tl-unit"),
);
check("職稱遷移：對不上→空（未分層級）", lib.titleLevelIdForName("召集人") === "");
// 角色遷移對照（前綴）
check(
  "角色遷移：委員會*→委員會",
  lib.roleLevelIdForName("委員會執行秘書") === "rl-committee",
);
check(
  "角色遷移：品管組*→品管組",
  lib.roleLevelIdForName("品管組副召集人") === "rl-qi",
);
check(
  "角色遷移：單位*→單位",
  lib.roleLevelIdForName("單位組長") === "rl-unit",
);
check("角色遷移：對不上→空", lib.roleLevelIdForName("指標負責人") === "");
// 6 個新角色
check("新角色共 6 個", lib.NEW_ROLES.length === 6);
check(
  "新角色名單正確",
  eq(
    lib.NEW_ROLES.map((r) => r.name),
    [
      "委員會召集人",
      "委員會執行秘書",
      "委員會執行幹事",
      "品管組副召集人",
      "品管組組長",
      "單位組長",
    ],
  ),
);
const byName = Object.fromEntries(lib.NEW_ROLES.map((r) => [r.name, r]));
check(
  "副召集人＝召集人類別／群組範圍",
  byName["品管組副召集人"].category === "convener" && byName["品管組副召集人"].kind === "group",
);
check(
  "兩組長＝一般類別",
  byName["品管組組長"].category === "general" && byName["單位組長"].category === "general",
);
check(
  "兩組長範圍：品管組組長群組／單位組長單位",
  byName["品管組組長"].kind === "group" && byName["單位組長"].kind === "unit",
);
check(
  "委員會三項皆群組範圍",
  ["委員會召集人", "委員會執行秘書", "委員會執行幹事"].every(
    (n) => byName[n].kind === "group",
  ),
);
check(
  "委員會執行秘書＝執行幹事類別（名稱推斷）",
  byName["委員會執行秘書"].category === "officer",
);
// 分組顯示
const items = [
  { name: "護理師", levelId: "tl-unit" },
  { name: "主任", levelId: "tl-dept" },
  { name: "舊職稱", levelId: "" },
  { name: "督導", levelId: "tl-dept" },
];
const sections = lib.groupByLevel(items, lib.DEFAULT_TITLE_LEVELS);
check(
  "分組：層級順序＋未分層級最後",
  eq(
    sections.map((s) => s.level?.name ?? "未分層級"),
    ["部級", "單位", "未分層級"],
  ),
);
check(
  "分組：部級含主任、督導",
  eq(sections[0].items.map((i) => i.name), ["主任", "督導"]),
);
check(
  "分組：空層級不出區段",
  lib.groupByLevel([{ name: "a", levelId: "tl-dept" }], lib.DEFAULT_TITLE_LEVELS).length === 1,
);
// 刪除擋下
check("刪除擋下：層級有項目", lib.canDeleteLevel(items, "tl-dept") === false);
check("刪除放行：層級無項目", lib.canDeleteLevel(items, "tl-nope") === true);
// 排序與查層級
check("新增層級 order 接最後", lib.nextLevelOrder(lib.DEFAULT_TITLE_LEVELS) === 2);
check("空集合新增 order 為 0", lib.nextLevelOrder([]) === 0);
check(
  "匯入以名稱查層級",
  lib.levelIdByName(lib.DEFAULT_ROLE_LEVELS, "品管組") === "rl-qi" &&
    lib.levelIdByName(lib.DEFAULT_ROLE_LEVELS, "不存在") === "",
);

// ---- 靜態守衛 ----
const versionTs = read("src/version.ts");
const pkg = JSON.parse(read("package.json"));
check("版號 1.55.0（version.ts）", versionTs.includes('VERSION = "1.55.0"'));
check("版號 1.55.0（package.json）", pkg.version === "1.55.0");

const groups = read("src/features/GroupsPage.tsx");
check("TitleRow 有 levelId", /interface TitleRow[\s\S]*?levelId: string;/.test(groups));
check("RoleRow 有 levelId", /interface RoleRow[\s\S]*?levelId: string;/.test(groups));
check("職稱表單有層級下拉", groups.includes('value={titleForm.levelId}'));
check("角色建立有層級下拉", groups.includes("value={newRoleLevelId}"));
check("角色編輯有層級下拉", groups.includes("value={roleEditLevelId}"));
check("職稱列表按層級分組", groups.includes("titleSections.map((section)"));
check("角色列表按層級分組", groups.includes("roleSections.map((section)"));
check("層級刪除擋下邏輯", groups.includes("canDeleteLevel(items, level.id)"));
check("人員職稱下拉用 optgroup", groups.includes("<optgroup"));
check("人員角色按層級分區", groups.includes("roleFormSections.map((section)"));
check("遷移在開頁執行（管理員）", groups.includes("migrateOrgLevels("));
check("職稱匯入表頭有層級", groups.includes('const TITLE_HEADER = ["職稱名稱", "層級"]'));
check("角色匯入表頭有層級", groups.includes('const ROLE_HEADER = ["角色名稱", "層級"]'));
check(
  "人員新增不再強制職稱",
  !groups.includes('setUserError("請選擇職稱")'),
);
check(
  "人員匯入不再強制職稱",
  !read("src/lib/orgImport.ts").includes("人員新增須填職稱"),
);

const rules = read("firestore.rules");
check("rules 有 titleLevels", rules.includes("match /titleLevels/{id}"));
check("rules 有 roleLevels", rules.includes("match /roleLevels/{id}"));

const seed = read("src/lib/seed.ts");
check(
  "種子 qi-officer 只剩一個（品管組執行幹事）",
  (seed.match(/id: "qi-officer"/g) || []).length === 1 &&
    seed.includes('name: "品管組執行幹事"'),
);
check("種子無舊名品管執行幹事", !seed.includes('name: "品管執行幹事"'));

const migration = read("src/lib/levelMigration.ts");
check("遷移有防重跑旗標", migration.includes("orgLevelsV155"));
check("遷移會建立 6 新角色", migration.includes("NEW_ROLES"));
check("遷移會處理舊角色", migration.includes("OLD_ROLE_NAME"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
