/**
 * v1.38.0 斷言測試：權限名稱範本制 can()。
 * 用 esbuild 打包後在 node 執行（被測函式皆零依賴）。
 * 覆蓋：範本共用（同名不同群組／單位）、跨與不跨群組／單位、
 * 單位角色、無範本＝無權限、無職稱＝無權限、kind 不明兩類都找、
 * 舊單位角色文件無 unitCode 相容；管理員 bypass 在 usePermissions
 * hook（isAdmin || can），不在 can() 本身，見最後一項 guard。
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";

const ROOT = "/home/hatch/workspace/repos/QAweb";

const entry = `
import {
  can, emptyPermissions, templateKey, templateDocId, parseTemplateCategory,
} from "${ROOT}/src/lib/permissions";
export { can, emptyPermissions, templateKey, templateDocId, parseTemplateCategory };
`;
writeFileSync("/tmp/v138-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v138-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v138-test-bundle.cjs",
  logLevel: "silent",
  define: { "import.meta.env": "{}" },
});
const require2 = createRequire("/tmp/v138-test-bundle.cjs");
const L = require2("/tmp/v138-test-bundle.cjs");

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

function makeCatalog({ templates = [], roleDocs = {}, titleDocs = [] }) {
  const out = { templates: {}, roleDocs: {}, titleDocs: [] };
  for (const t of templates) {
    out.templates[L.templateKey(t.category, t.name)] = {
      category: t.category,
      name: t.name,
      permissions: { ...L.emptyPermissions(), ...(t.perms || {}) },
      cross: t.cross === true,
    };
  }
  out.roleDocs = roleDocs;
  out.titleDocs = titleDocs;
  return out;
}

const HN_TITLE_DOC = { id: "t-hn-9a", name: "護理長", unitCodes: ["9A"] };
const CONVENER_DOCS = {
  召集人: [{ kind: "group", groupId: "g-icu", unitCode: "" }],
};
const TITLE_FULL = { "page.dashboard": true, editSubmitted: true };

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
    roleDocs: CONVENER_DOCS,
    titleDocs: [HN_TITLE_DOC],
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
      roleDocs: CONVENER_DOCS,
      titleDocs: [HN_TITLE_DOC],
    }),
    "g-ward",
  ) === true,
);
assert(
  "不跨群組：目標群組為病房組（未持有）→不可改已提交",
  L.can(baseUser(), "editSubmitted", baseCatalog(), "g-ward") === false,
);
assert(
  "不跨群組：目標群組為所屬加護組→可改已提交",
  L.can(baseUser(), "editSubmitted", baseCatalog(), "g-icu") === true,
);

/* ---------- 職稱跨單位 ---------- */
assert(
  "職稱跨單位：護理長跨單位，人在 9B 仍可看儀表板",
  L.can(
    baseUser({ unitCode: "9B" }),
    "page.dashboard",
    makeCatalog({
      templates: [
        { category: "group", name: "召集人", perms: { "page.dashboard": true }, cross: false },
        { category: "unit", name: "護理長", perms: { "page.dashboard": true }, cross: true },
      ],
      roleDocs: CONVENER_DOCS,
      titleDocs: [HN_TITLE_DOC],
    }),
  ) === true,
);
assert(
  "職稱不跨單位：人在 9B、職稱只適用 9A→不可看儀表板",
  L.can(baseUser({ unitCode: "9B" }), "page.dashboard", baseCatalog()) === false,
);
assert(
  "職稱不跨單位：人在 9A、職稱適用 9A→可看儀表板",
  L.can(baseUser(), "page.dashboard", baseCatalog()) === true,
);

/* ---------- 無範本／無職稱 ---------- */
assert(
  "無範本＝無權限：召集人範本不存在→不可看儀表板",
  L.can(
    baseUser(),
    "page.dashboard",
    makeCatalog({
      templates: [
        { category: "unit", name: "護理長", perms: { "page.dashboard": true }, cross: false },
      ],
      roleDocs: CONVENER_DOCS,
      titleDocs: [HN_TITLE_DOC],
    }),
  ) === false,
);
assert(
  "無職稱＝無權限：title 為空→不可看儀表板",
  L.can(baseUser({ title: "", titleId: "" }), "page.dashboard", baseCatalog()) === false,
);

/* ---------- 單位角色 ---------- */
function unitRoleUser(unitCode) {
  return {
    roles: ["單位召集人"],
    memberships: [],
    title: "護理長",
    titleId: "t-hn-9a",
    unitCode,
  };
}
function unitRoleCatalog({ cross, unitCode }) {
  return makeCatalog({
    templates: [
      { category: "unitRole", name: "單位召集人", perms: { "page.dashboard": true }, cross },
      // 職稱側設為跨單位，使測試只量測角色側的跨單位行為
      { category: "unit", name: "護理長", perms: { "page.dashboard": true }, cross: true },
    ],
    roleDocs: {
      單位召集人: [{ kind: "unit", groupId: "", unitCode }],
    },
    titleDocs: [HN_TITLE_DOC],
  });
}
assert(
  "單位角色不跨：人在所屬單位 9A→可看儀表板",
  L.can(unitRoleUser("9A"), "page.dashboard", unitRoleCatalog({ cross: false, unitCode: "9A" })) === true,
);
assert(
  "單位角色不跨：人在他單位 9B→不可看儀表板",
  L.can(unitRoleUser("9B"), "page.dashboard", unitRoleCatalog({ cross: false, unitCode: "9A" })) === false,
);
assert(
  "單位角色跨單位：人在 9B→可看儀表板",
  L.can(unitRoleUser("9B"), "page.dashboard", unitRoleCatalog({ cross: true, unitCode: "9A" })) === true,
);
assert(
  "單位角色舊文件無 unitCode（相容）：不跨仍視為本人單位→可看儀表板",
  L.can(unitRoleUser("9A"), "page.dashboard", unitRoleCatalog({ cross: false, unitCode: "" })) === true,
);

/* ---------- 交集與 kind 不明 ---------- */
assert(
  "角色聯集 AND 職稱：職稱未勾選→不可看儀表板",
  L.can(
    baseUser(),
    "page.dashboard",
    makeCatalog({
      templates: [
        { category: "group", name: "召集人", perms: { "page.dashboard": true }, cross: false },
        { category: "unit", name: "護理長", perms: { "page.dashboard": false }, cross: false },
      ],
      roleDocs: CONVENER_DOCS,
      titleDocs: [HN_TITLE_DOC],
    }),
  ) === false,
);
assert(
  "kind 不明兩類都找：無角色文件，群組範本仍生效",
  L.can(
    baseUser(),
    "page.dashboard",
    makeCatalog({
      templates: [
        { category: "group", name: "召集人", perms: { "page.dashboard": true }, cross: false },
        { category: "unit", name: "護理長", perms: { "page.dashboard": true }, cross: false },
      ],
      roleDocs: {},
      titleDocs: [HN_TITLE_DOC],
    }),
  ) === true,
);
assert(
  "群組角色無 membership 不生效：roles 有召集人但無 membership→不可看儀表板",
  L.can(baseUser({ memberships: [] }), "page.dashboard", baseCatalog()) === false,
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
  "parseTemplateCategory：無效值回 undefined",
  L.parseTemplateCategory("group") === "group" &&
    L.parseTemplateCategory("unitRole") === "unitRole" &&
    L.parseTemplateCategory("x") === undefined,
);
assert(
  "bypass 邊界：can() 本身不 bypass，系統管理員無範本仍回 false（bypass 在 usePermissions hook）",
  L.can(
    { roles: ["系統管理員"], memberships: [], title: "護理長", titleId: "t-hn-9a", unitCode: "9A" },
    "page.dashboard",
    baseCatalog(),
  ) === false,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
