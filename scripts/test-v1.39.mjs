/**
 * v1.39.0 斷言測試：權限判斷改吃人員指派情境（can()）。
 * 用 esbuild 打包後在 node 執行（被測函式皆零依賴）。
 * 覆蓋：範本共用（同名不同群組／單位）、跨與不跨群組（以 membership 為準）、
 * 跨與不跨單位（單位角色以本人 unitCode 所屬群組的 membership 為準；
 * 職稱範本勾選即對本人單位生效）、舊文件欄位被忽略（catalog 不再含
 * roleDocs/titleDocs）、無範本＝無權限、聯集 OR（Charles 2026-11-20 定案
 * Q4 A：職稱範本有勾或角色範本有勾，任一有即有權限，取代 v1.39.0 交集制）；
 * 管理員 bypass 在 usePermissions hook（isAdmin || can），不在 can() 本身。
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";

import { ROOT } from "./lib/paths.mjs";

const entry = `
import {
  can, emptyPermissions, templateKey, templateDocId, parseTemplateCategory,
  encodeTemplateName, decodeTemplateName,
} from "${ROOT}/src/lib/permissions";
export { can, emptyPermissions, templateKey, templateDocId, parseTemplateCategory, encodeTemplateName, decodeTemplateName };
`;
writeFileSync("/tmp/v139-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v139-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v139-test-bundle.cjs",
  logLevel: "silent",
  define: { "import.meta.env": "{}" },
});
const require2 = createRequire("/tmp/v139-test-bundle.cjs");
const L = require2("/tmp/v139-test-bundle.cjs");

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

/** v1.39.0 catalog：只有 templates＋unitGroups，不再有 roleDocs/titleDocs。 */
function makeCatalog({ templates = [], unitGroups = {} }) {
  const out = { templates: {}, unitGroups };
  for (const t of templates) {
    out.templates[L.templateKey(t.category, t.name)] = {
      category: t.category,
      name: t.name,
      permissions: { ...L.emptyPermissions(), ...(t.perms || {}) },
      cross: t.cross === true,
    };
  }
  return out;
}

const TITLE_FULL = { "page.dashboard": true, editSubmitted: true };
const UNIT_GROUPS = { "9A": "g-ward", "9B": "g-icu" };

function baseUser(overrides = {}) {
  return {
    roles: ["召集人"],
    memberships: [{ groupId: "g-icu", roles: ["召集人"] }],
    title: "護理長",
    titleId: "t-hn-9a",
    unitCode: "9A",
    ...overrides,
  };
}

function baseCatalog(overrides = {}) {
  return makeCatalog({
    templates: [
      { category: "group", name: "召集人", perms: { "page.dashboard": true, editSubmitted: true }, cross: false },
      { category: "unit", name: "護理長", perms: TITLE_FULL, cross: false },
    ],
    unitGroups: UNIT_GROUPS,
    ...overrides,
  });
}

/* ---------- 範本共用 ---------- */
assert(
  "範本共用：同名召集人（加護組持有）＋護理長皆勾選→可看儀表板",
  L.can(baseUser(), "page.dashboard", baseCatalog()) === true,
);
assert(
  "範本共用：跨群組時，目標群組為病房組（未持有）仍可改已提交",
  L.can(
    baseUser(),
    "editSubmitted",
    makeCatalog({
      templates: [
        { category: "group", name: "召集人", perms: { editSubmitted: true }, cross: true },
        { category: "unit", name: "護理長", perms: { editSubmitted: true }, cross: false },
      ],
      unitGroups: UNIT_GROUPS,
    }),
    "g-ward",
  ) === true,
);
assert(
  "不跨群組：目標群組為病房組（未持有）、且職稱側未勾選→不可改已提交",
  L.can(
    baseUser(),
    "editSubmitted",
    makeCatalog({
      templates: [
        { category: "group", name: "召集人", perms: { editSubmitted: true }, cross: false },
        { category: "unit", name: "護理長", perms: { editSubmitted: false }, cross: false },
      ],
      unitGroups: UNIT_GROUPS,
    }),
    "g-ward",
  ) === false,
);
assert(
  "不跨群組：目標群組為所屬加護組→可改已提交",
  L.can(baseUser(), "editSubmitted", baseCatalog(), "g-icu") === true,
);
assert(
  "群組角色無 membership 不生效：roles 有召集人但無 membership、且職稱側未勾選→不可看儀表板",
  L.can(
    baseUser({ memberships: [] }),
    "page.dashboard",
    makeCatalog({
      templates: [
        { category: "group", name: "召集人", perms: { "page.dashboard": true }, cross: false },
        { category: "unit", name: "護理長", perms: { "page.dashboard": false }, cross: false },
      ],
      unitGroups: UNIT_GROUPS,
    }),
  ) === false,
);

/* ---------- 職稱（v1.39：範本勾選即對本人單位生效，不再讀職稱文件 unitCodes） ---------- */
assert(
  "職稱不跨單位：人在 9B、範本勾選→仍可看儀表板（本人即在自己的單位）",
  L.can(baseUser({ unitCode: "9B" }), "page.dashboard", baseCatalog()) === true,
);
assert(
  "職稱跨單位：人在 9B、範本勾選→可看儀表板",
  L.can(
    baseUser({ unitCode: "9B" }),
    "page.dashboard",
    makeCatalog({
      templates: [
        { category: "group", name: "召集人", perms: { "page.dashboard": true }, cross: false },
        { category: "unit", name: "護理長", perms: { "page.dashboard": true }, cross: true },
      ],
      unitGroups: UNIT_GROUPS,
    }),
  ) === true,
);

/* ---------- 無範本／無職稱（聯集制：任一側有勾即有權限） ---------- */
assert(
  "無範本＝無權限：兩側範本都不存在→不可看儀表板",
  L.can(
    baseUser(),
    "page.dashboard",
    makeCatalog({ templates: [], unitGroups: UNIT_GROUPS }),
  ) === false,
);
assert(
  "聯集：只有職稱範本有勾（角色範本不存在）→可看儀表板",
  L.can(
    baseUser(),
    "page.dashboard",
    makeCatalog({
      templates: [
        { category: "unit", name: "護理長", perms: { "page.dashboard": true }, cross: false },
      ],
      unitGroups: UNIT_GROUPS,
    }),
  ) === true,
);
assert(
  "聯集：只有角色範本有勾（職稱範本不存在）→可看儀表板",
  L.can(
    baseUser(),
    "page.dashboard",
    makeCatalog({
      templates: [
        { category: "group", name: "召集人", perms: { "page.dashboard": true }, cross: false },
      ],
      unitGroups: UNIT_GROUPS,
    }),
  ) === true,
);
assert(
  "聯集：只有職稱、沒有角色（roles 為空、職稱有勾）→可看儀表板",
  L.can(
    baseUser({ roles: [], memberships: [] }),
    "page.dashboard",
    baseCatalog(),
  ) === true,
);
assert(
  "聯集：無職稱（title 為空）、角色有勾→可看儀表板",
  L.can(baseUser({ title: "", titleId: "" }), "page.dashboard", baseCatalog()) === true,
);
assert(
  "無身分＝無權限：roles 為空且 title 為空→不可看儀表板",
  L.can(
    baseUser({ roles: [], memberships: [], title: "", titleId: "" }),
    "page.dashboard",
    baseCatalog(),
  ) === false,
);

/* ---------- 單位角色（以本人 unitCode 所屬群組的 membership 為準） ---------- */
function unitRoleUser(unitCode, memberships) {
  return {
    roles: ["單位召集人"],
    memberships: memberships ?? [{ groupId: "g-ward", roles: ["單位召集人"] }],
    title: "護理長",
    titleId: "t-hn-9a",
    unitCode,
  };
}
function unitRoleCatalog(cross, titlePerms) {
  return makeCatalog({
    templates: [
      { category: "unitRole", name: "單位召集人", perms: { "page.dashboard": true }, cross },
      // 職稱側預設勾選（使測試只量測角色側的跨單位行為）；傳 titlePerms
      // 為 {} 時職稱側不授權，改量測「角色側單獨不成立→不可」的情形
      { category: "unit", name: "護理長", perms: titlePerms ?? { "page.dashboard": true }, cross: true },
    ],
    unitGroups: UNIT_GROUPS,
  });
}
assert(
  "單位角色不跨：人在 9A、持有於本人單位群組（病房組）→可看儀表板",
  L.can(unitRoleUser("9A"), "page.dashboard", unitRoleCatalog(false)) === true,
);
assert(
  "單位角色不跨：人在 9A、只持有於他組（加護組）membership、且職稱側未勾選→不可看儀表板",
  L.can(
    unitRoleUser("9A", [{ groupId: "g-icu", roles: ["單位召集人"] }]),
    "page.dashboard",
    unitRoleCatalog(false, {}),
  ) === false,
);
assert(
  "單位角色不跨：人在 9A、roles 有但無 membership、且職稱側未勾選→不可看儀表板",
  L.can(unitRoleUser("9A", []), "page.dashboard", unitRoleCatalog(false, {})) === false,
);
assert(
  "單位角色不跨：人在 9C（單位不在對照表）、且職稱側未勾選→不可看儀表板",
  L.can(unitRoleUser("9C"), "page.dashboard", unitRoleCatalog(false, {})) === false,
);
assert(
  "單位角色跨單位：人在 9B、只持有於病房組 membership→可看儀表板",
  L.can(unitRoleUser("9B"), "page.dashboard", unitRoleCatalog(true)) === true,
);
assert(
  "單位角色跨單位：人在 9B、roles 有但無 membership→可看儀表板",
  L.can(unitRoleUser("9B", []), "page.dashboard", unitRoleCatalog(true)) === true,
);

/* ---------- 舊文件欄位被忽略 ---------- */
assert(
  "舊文件欄位被忽略：catalog 帶舊 roleDocs（召集人 groupId＝別組）／titleDocs（unitCodes＝9B）也不影響判斷",
  (() => {
    const catalog = baseCatalog();
    catalog.roleDocs = { 召集人: [{ kind: "group", groupId: "g-other", unitCode: "" }] };
    catalog.titleDocs = [{ id: "t-hn-9a", name: "護理長", unitCodes: ["9B"] }];
    // g-ward 斷言用職稱側未勾選 editSubmitted 的變體：群組角色不跨群組時
    // 目標群組未持有→角色側不授權，職稱側亦未勾選→不可
    const noTitleEdit = makeCatalog({
      templates: [
        { category: "group", name: "召集人", perms: { editSubmitted: true }, cross: false },
        { category: "unit", name: "護理長", perms: { "page.dashboard": true }, cross: false },
      ],
      unitGroups: UNIT_GROUPS,
    });
    return L.can(baseUser(), "page.dashboard", catalog) === true
      && L.can(baseUser(), "editSubmitted", noTitleEdit, "g-ward") === false;
  })(),
);
assert(
  "舊文件欄位被忽略：單位角色文件帶 unitCode＝9A，但使用者只持有於他組 membership、且職稱側未勾選→不跨仍不可",
  (() => {
    const catalog = unitRoleCatalog(false, {});
    catalog.roleDocs = { 單位召集人: [{ kind: "unit", groupId: "", unitCode: "9A" }] };
    return L.can(
      unitRoleUser("9A", [{ groupId: "g-icu", roles: ["單位召集人"] }]),
      "page.dashboard",
      catalog,
    ) === false;
  })(),
);

/* ---------- 聯集（Q4 A：職稱 OR 角色，任一有勾即有權限） ---------- */
assert(
  "角色聯集 OR 職稱：職稱未勾選、角色有勾→可看儀表板",
  L.can(
    baseUser(),
    "page.dashboard",
    makeCatalog({
      templates: [
        { category: "group", name: "召集人", perms: { "page.dashboard": true }, cross: false },
        { category: "unit", name: "護理長", perms: { "page.dashboard": false }, cross: false },
      ],
      unitGroups: UNIT_GROUPS,
    }),
  ) === true,
);
assert(
  "角色聯集 OR 職稱：角色未勾選、職稱有勾→可看儀表板",
  L.can(
    baseUser(),
    "page.dashboard",
    makeCatalog({
      templates: [
        { category: "group", name: "召集人", perms: { "page.dashboard": false }, cross: false },
        { category: "unit", name: "護理長", perms: { "page.dashboard": true }, cross: false },
      ],
      unitGroups: UNIT_GROUPS,
    }),
  ) === true,
);
assert(
  "角色聯集 OR 職稱：兩邊都未勾選→不可看儀表板",
  L.can(
    baseUser(),
    "page.dashboard",
    makeCatalog({
      templates: [
        { category: "group", name: "召集人", perms: { "page.dashboard": false }, cross: false },
        { category: "unit", name: "護理長", perms: { "page.dashboard": false }, cross: false },
      ],
      unitGroups: UNIT_GROUPS,
    }),
  ) === false,
);

/* ---------- 輔助函式與 bypass 邊界 ---------- */
assert(
  "templateKey：group:召集人",
  L.templateKey("group", "召集人") === "group:召集人",
);
assert(
  "templateDocId：unit__護理長",
  L.templateDocId("unit", "護理長") === "unit__護理長",
);
assert(
  "templateDocId：含 / 的名稱編碼為 %2F，doc() 不再拋錯",
  L.templateDocId("unit", "護理長/副護理長") === "unit__護理長%2F副護理長" &&
    !L.templateDocId("unit", "護理長/副護理長").includes("/"),
);
assert(
  "templateDocId：編碼可逆、既有名稱不受影響",
  L.decodeTemplateName(L.encodeTemplateName("護理長/副護理長")) === "護理長/副護理長" &&
    L.encodeTemplateName("主任") === "主任" &&
    L.decodeTemplateName(L.encodeTemplateName("含%2F字面")) === "含%2F字面",
);
assert(
  "parseTemplateCategory：無效值回 undefined",
  L.parseTemplateCategory("group") === "group" &&
    L.parseTemplateCategory("unitRole") === "unitRole" &&
    L.parseTemplateCategory("x") === undefined,
);
assert(
  "bypass 邊界：can() 本身不 bypass，系統管理員無範本仍回 false（bypass 在 usePermissions hook）",
  L.can(
    { roles: ["系統管理員"], memberships: [], title: "不存在的職稱", titleId: "", unitCode: "9A" },
    "page.dashboard",
    baseCatalog(),
  ) === false,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
