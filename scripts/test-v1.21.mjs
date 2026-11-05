/**
 * v1.21.0 斷言測試：複合文件 ID（組別＋編號唯一）、角色身分新舊並認、
 * 人員多群組模型、人／單位匯入解析與驗證、審查結果匯入解析與驗證。
 * 用 esbuild 打包後在 node 執行（被測函式皆零依賴）。
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";

const ROOT = "/home/hatch/workspace/repos/QAweb";

const entry = `
import {
  indicatorDocId, parseIndicatorDocId, indicatorCodeOf,
} from "${ROOT}/src/lib/indicators";
import {
  isReviewerRole, isConvenerRole, isOfficerRole, hasSchedulePermission,
  isGroupScopedRole, isUnitLevelRole,
  parseMemberships, deriveGroupIds, deriveRoles, groupsForRoles,
} from "${ROOT}/src/lib/roleIdentity";
import {
  parseBasicSheet, validateBasicRows,
  parseResultSheet, validateResultSheet, parseReviewMonth, resultTemplateRows,
} from "${ROOT}/src/lib/import";
import {
  parseUserSheet, validateUserRows, parseUnitSheet, validateUnitRows,
  userTemplateRows, unitTemplateRows,
} from "${ROOT}/src/lib/orgImport";
export {
  indicatorDocId, parseIndicatorDocId, indicatorCodeOf,
  isReviewerRole, isConvenerRole, isOfficerRole, hasSchedulePermission,
  isGroupScopedRole, isUnitLevelRole,
  parseMemberships, deriveGroupIds, deriveRoles, groupsForRoles,
  parseBasicSheet, validateBasicRows,
  parseResultSheet, validateResultSheet, parseReviewMonth, resultTemplateRows,
  parseUserSheet, validateUserRows, parseUnitSheet, validateUnitRows,
  userTemplateRows, unitTemplateRows,
};
`;
writeFileSync("/tmp/v121-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v121-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v121-test-bundle.cjs",
  logLevel: "silent",
  define: { "import.meta.env": "{}" },
});
const require2 = createRequire("/tmp/v121-test-bundle.cjs");
const L = require2("/tmp/v121-test-bundle.cjs");

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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- 1. 複合文件 ID ---------- */
assert(
  "docId：組別＋編號",
  L.indicatorDocId("g-ward", "QI-001") === "g-ward__QI-001",
);
assert(
  "docId：去空白",
  L.indicatorDocId(" g-ward ", " QI-001 ") === "g-ward__QI-001",
);
assert(
  "parse：複合 ID 拆回組別＋編號",
  eq(L.parseIndicatorDocId("g-ward__QI-001"), {
    groupId: "g-ward",
    code: "QI-001",
  }),
);
assert(
  "parse：編號含底線仍正確拆分（取第一個 __）",
  eq(L.parseIndicatorDocId("g1__QI_001"), { groupId: "g1", code: "QI_001" }),
);
assert("parse：舊格式→null", L.parseIndicatorDocId("QI-001") === null);
assert("parse：空組別→null", L.parseIndicatorDocId("__QI-001") === null);
assert(
  "codeOf：複合 ID 取編號",
  L.indicatorCodeOf("g-ward__QI-001") === "QI-001",
);
assert("codeOf：舊格式回傳原 ID", L.indicatorCodeOf("QI-001") === "QI-001");

/* ---------- 2. 角色身分新舊並認 ---------- */
assert("審查員：舊角色", L.isReviewerRole(["審查員"]) === true);
assert("審查員：品管組", L.isReviewerRole(["品管組審查員"]) === true);
assert("審查員：單位", L.isReviewerRole(["單位審查員"]) === true);
assert("審查員：一般人員→否", L.isReviewerRole(["一般人員"]) === false);
assert("審查員：空→否", L.isReviewerRole([]) === false);
assert("召集人：舊／各組／品管組／單位", 
  L.isConvenerRole(["召集人"]) === true &&
  L.isConvenerRole(["各組召集人"]) === true &&
  L.isConvenerRole(["品管組召集人"]) === true &&
  L.isConvenerRole(["單位召集人"]) === true,
);
assert("執行幹事：舊／品管組／單位",
  L.isOfficerRole(["執行幹事"]) === true &&
  L.isOfficerRole(["品管組執行幹事"]) === true &&
  L.isOfficerRole(["單位執行幹事"]) === true,
);
assert(
  "排程權限：組級召集人／執行幹事有；單位級無；審查員無",
  L.hasSchedulePermission(["品管組召集人"]) === true &&
  L.hasSchedulePermission(["品管組執行幹事"]) === true &&
  L.hasSchedulePermission(["召集人"]) === true &&
  L.hasSchedulePermission(["執行幹事"]) === true &&
  L.hasSchedulePermission(["單位召集人"]) === false &&
  L.hasSchedulePermission(["單位執行幹事"]) === false &&
  L.hasSchedulePermission(["審查員"]) === false,
);
assert(
  "群組範圍角色：召集人／執行幹事／審查員新舊皆是；一般人員否",
  L.isGroupScopedRole("品管組審查員") === true &&
  L.isGroupScopedRole("審查員") === true &&
  L.isGroupScopedRole("單位執行幹事") === true &&
  L.isGroupScopedRole("一般人員") === false &&
  L.isGroupScopedRole("指標負責人") === false,
);
assert(
  "單位級角色：僅三個單位級",
  L.isUnitLevelRole("單位審查員") === true &&
  L.isUnitLevelRole("品管組審查員") === false,
);

/* ---------- 3. 人員多群組模型 ---------- */
assert(
  "parseMemberships：正規化＋同群組合併",
  eq(
    L.parseMemberships([
      { groupId: "g1", roles: ["品管組審查員"] },
      { groupId: "g1", roles: ["單位執行幹事"] },
      { groupId: "g2", roles: ["品管組召集人"] },
      { groupId: "", roles: ["審查員"] },
    ]),
    [
      { groupId: "g1", roles: ["品管組審查員", "單位執行幹事"] },
      { groupId: "g2", roles: ["品管組召集人"] },
    ],
  ),
);
assert(
  "parseMemberships：無 memberships 時 fallback 舊欄位",
  eq(
    L.parseMemberships(undefined, {
      roles: ["審查員"],
      groupIds: ["g1", "g2"],
    }),
    [
      { groupId: "g1", roles: ["審查員"] },
      { groupId: "g2", roles: ["審查員"] },
    ],
  ),
);
assert(
  "parseMemberships：舊欄位缺一→空",
  eq(L.parseMemberships(undefined, { roles: ["審查員"], groupIds: [] }), []),
);
assert(
  "deriveGroupIds／deriveRoles：去重",
  eq(
    L.deriveGroupIds([
      { groupId: "g1", roles: ["審查員"] },
      { groupId: "g1", roles: ["執行幹事"] },
      { groupId: "g2", roles: ["審查員"] },
    ]),
    ["g1", "g2"],
  ) &&
    eq(
      L.deriveRoles([
        { groupId: "g1", roles: ["審查員"] },
        { groupId: "g2", roles: ["審查員", "執行幹事"] },
      ]),
      ["審查員", "執行幹事"],
    ),
);
assert(
  "groupsForRoles：組級角色取其群組",
  eq(
    L.groupsForRoles(
      [
        { groupId: "g1", roles: ["品管組召集人"] },
        { groupId: "g2", roles: ["品管組審查員"] },
      ],
      ["品管組召集人", "品管組執行幹事"],
    ),
    ["g1"],
  ),
);
assert(
  "groupsForRoles：單位級角色以單位所屬群組計",
  eq(
    L.groupsForRoles(
      [{ groupId: "g9", roles: ["單位執行幹事"] }],
      ["單位執行幹事", "品管組執行幹事"],
      "g-unit",
    ),
    ["g-unit"],
  ),
);
assert(
  "groupsForRoles：單位未知時退回 membership 群組",
  eq(
    L.groupsForRoles(
      [{ groupId: "g9", roles: ["單位執行幹事"] }],
      ["單位執行幹事"],
      undefined,
    ),
    ["g9"],
  ),
);

/* ---------- 4. 基本資料匯入：組別內唯一 ---------- */
const groupByName = new Map([
  ["病房組", "g1"],
  ["門診組", "g2"],
]);
const staffHas = (id) => ["A12345", "B23456"].includes(id);
const basicSheet = [
  ["組別", "編號", "指標名稱", "閾值(%)", "負責人"],
  ["病房組", "QI-001", "同編號不同組", "90", "A12345"],
  ["門診組", "QI-001", "同編號不同組", "90", "A12345"],
  ["病房組", "QI-001", "同組重複", "90", "A12345"],
  ["病房組", "QI-000", "已存在", "90", "A12345"],
  ["門診組", "QI-000", "他組已存在不算", "90", "A12345"],
];
const pb = L.parseBasicSheet(basicSheet);
const vb = L.validateBasicRows(pb.data, {
  groupByName,
  existingCodes: new Set(["g1__QI-000"]),
  staffHas,
  staffLoaded: true,
});
assert("組別內唯一：不同組別同編號皆通過", vb[0].ok === true && vb[1].ok === true);
assert("組別內唯一：同組重複有誤", vb[2].ok === false);
assert("組別內唯一：同組已存在有誤", vb[3].ok === false);
assert("組別內唯一：他組已存在不算", vb[4].ok === true);

/* ---------- 5. 人員匯入 ---------- */
const userCtx = {
  existingStaffIds: new Set(["A12345"]),
  groupByName: new Map([
    ["病房組", "g1"],
    ["加護組", "g2"],
  ]),
  roleNames: new Set([
    "一般人員",
    "審查員",
    "品管組審查員",
    "單位執行幹事",
    "指標負責人",
  ]),
  titleNames: new Set(["護理師", "護理長", "護理部主任"]),
  unitCodes: new Set(["9A", "9B", "ICU"]),
};
const userSheet = [
  ["職編", "姓名", "單位", "職稱", "群組1", "角色1", "群組2", "角色2"],
  ["A12345", "王小明", "9A", "護理師", "病房組", "品管組審查員", "", ""],
  ["B11111", "", "9B", "", "病房組", "審查員、單位執行幹事", "加護組", "單位執行幹事"],
  ["C22222", "陳小華", "9X", "護理師", "病房組", "審查員", "", ""],
  ["D33333", "林小明", "9A", "未知職稱", "病房組", "審查員", "", ""],
  ["E44444", "黃小華", "9A", "護理師", "未知組", "審查員", "", ""],
  ["F55555", "張小明", "9A", "護理師", "病房組", "未知角色", "", ""],
  ["", "無職編", "9A", "護理師", "", "", "", ""],
  ["G66666", "趙小華", "9A", "護理師", "", "審查員", "", ""],
];
const pu = L.parseUserSheet(userSheet);
assert("人員匯入：標題列無誤", pu.headerErrors.length === 0);
assert("人員匯入：8 筆資料列", pu.data.length === 8);
const vu = L.validateUserRows(pu.data, userCtx);
assert(
  "人員匯入：已存在職編→更新",
  vu[0].ok === true && vu[0].action === "update",
);
assert(
  "人員匯入：更新列 memberships 正確",
  vu[0].ok === true &&
    eq(vu[0].values.memberships, [{ groupId: "g1", roles: ["品管組審查員"] }]),
);
assert(
  "人員匯入：新進＋姓名未填（null）＋雙群組",
  vu[1].ok === true &&
    vu[1].action === "create" &&
    vu[1].values.name === null &&
    eq(vu[1].values.memberships, [
      { groupId: "g1", roles: ["審查員", "單位執行幹事"] },
      { groupId: "g2", roles: ["單位執行幹事"] },
    ]),
);
assert("人員匯入：單位不存在有誤", vu[2].ok === false);
assert("人員匯入：職稱不存在有誤", vu[3].ok === false);
assert("人員匯入：群組不存在有誤", vu[4].ok === false);
assert("人員匯入：角色不存在有誤", vu[5].ok === false);
assert("人員匯入：職編未填有誤", vu[6].ok === false);
assert("人員匯入：角色無群組有誤", vu[7].ok === false);
assert(
  "人員匯入：缺少職編欄報錯",
  L.parseUserSheet([["姓名", "單位"]]).headerErrors.length > 0,
);
assert(
  "人員範本標題",
  eq(L.userTemplateRows()[0], [
    "職編",
    "姓名",
    "單位",
    "職稱",
    "群組1",
    "角色1",
    "群組2",
    "角色2",
  ]),
);

/* ---------- 6. 單位匯入 ---------- */
const unitCtx = {
  existingCodes: new Set(["9A"]),
  groupByName: new Map([
    ["病房組", "g1"],
    ["加護組", "g2"],
  ]),
};
const unitSheet = [
  ["單位代號", "單位名稱", "所屬群組"],
  ["9A", "9A 病房改名", "病房組"],
  ["9C", "9C 病房", "病房組"],
  ["9D", "", ""],
  ["", "無代號", "病房組"],
  ["9E", "9E 病房", "未知組"],
];
const punit = L.parseUnitSheet(unitSheet);
assert("單位匯入：標題列無誤", punit.headerErrors.length === 0);
const vunit = L.validateUnitRows(punit.data, unitCtx);
assert(
  "單位匯入：已存在→更新",
  vunit[0].ok === true && vunit[0].action === "update",
);
assert(
  "單位匯入：新增",
  vunit[1].ok === true && vunit[1].action === "create",
);
assert(
  "單位匯入：未填欄位忽略（名稱／群組為 null）",
  vunit[2].ok === true &&
    vunit[2].values.name === null &&
    vunit[2].values.groupId === null,
);
assert("單位匯入：代號未填有誤", vunit[3].ok === false);
assert("單位匯入：群組不存在有誤", vunit[4].ok === false);
assert(
  "單位範本標題",
  eq(L.unitTemplateRows()[0], ["單位代號", "單位名稱", "所屬群組"]),
);

/* ---------- 7. 審查結果匯入 ---------- */
assert(
  "審查月份：2026-11／2026/11 皆接受",
  eq(L.parseReviewMonth("2026-11"), { year: 2026, month: 11 }) &&
    eq(L.parseReviewMonth("2026/11"), { year: 2026, month: 11 }),
);
assert("審查月份：13 月無效", L.parseReviewMonth("2026-13") === null);
assert("審查月份：無分隔符無效", L.parseReviewMonth("202611") === null);
assert(
  "結果範本：前 6 欄固定＋每題一欄",
  eq(L.resultTemplateRows("QI-001", ["題目一", "題目二"])[0], [
    "指標代號",
    "受審單位",
    "審查月份",
    "審查員",
    "受審人員職編",
    "床號",
    "題目一",
    "題目二",
  ]),
);
const resultCtx = {
  code: "QI-001",
  questionCount: 2,
  unitHas: (c) => ["9A", "9B"].includes(c),
  staffHas: (id) => ["A12345", "B67890"].includes(id),
  staffLoaded: true,
};
const resultSheet = [
  ["指標代號", "受審單位", "審查月份", "審查員", "受審人員職編", "床號", "題一", "題二"],
  ["QI-001", "9A", "2026-11", "A12345", "B67890", "9A-01", "是", "否"],
  ["QI-001", "9B", "2026/11", "", "", "", "", "不適用"],
  ["QI-001", "9X", "2026-11", "A12345", "", "", "是", "是"],
  ["QI-001", "9A", "2026-13", "A12345", "", "", "是", "是"],
  ["QI-001", "9A", "2026-11", "A12345", "", "", "是", "也許"],
  ["QI-001", "9A", "2026-11", "Z99999", "", "", "是", "是"],
];
const pr = L.parseResultSheet(resultSheet);
assert("結果匯入：標題列無誤", pr.headerErrors.length === 0);
const vr = L.validateResultSheet(pr.data, resultCtx);
assert("結果匯入：無檔案級錯誤", vr.fileErrors.length === 0);
assert("結果匯入：第 1 列通過", vr.rows[0].ok === true);
assert(
  "結果匯入：第 1 列值正確",
  vr.rows[0].values.year === 2026 &&
    vr.rows[0].values.month === 11 &&
    eq(vr.rows[0].values.answers, ["是", "否"]),
);
assert("結果匯入：第 2 列通過（未填留空）", vr.rows[1].ok === true);
assert("結果匯入：單位不存在該列跳過", vr.rows[2].ok === false);
assert("結果匯入：月份無效該列跳過", vr.rows[3].ok === false);
assert("結果匯入：非法答案該列跳過", vr.rows[4].ok === false);
assert("結果匯入：審查員不存在該列跳過", vr.rows[5].ok === false);

const badCodeSheet = [
  ["指標代號", "受審單位", "審查月份", "審查員", "受審人員職編", "床號", "題一", "題二"],
  ["QI-001", "9A", "2026-11", "", "", "", "是", "否"],
  ["QI-999", "9A", "2026-11", "", "", "", "是", "否"],
];
const vrBadCode = L.validateResultSheet(
  L.parseResultSheet(badCodeSheet).data,
  resultCtx,
);
assert(
  "結果匯入：指標代號不符→整檔中止",
  vrBadCode.fileErrors.length > 0 &&
    vrBadCode.rows.every((r) => r.ok === false),
);
const badCountSheet = [
  ["指標代號", "受審單位", "審查月份", "審查員", "受審人員職編", "床號", "題一"],
  ["QI-001", "9A", "2026-11", "", "", "", "是"],
];
const vrBadCount = L.validateResultSheet(
  L.parseResultSheet(badCountSheet).data,
  resultCtx,
);
assert(
  "結果匯入：題數不符→整檔中止",
  vrBadCount.fileErrors.length > 0 &&
    vrBadCount.rows.every((r) => r.ok === false),
);
assert(
  "結果匯入：缺少受審單位欄報錯",
  L.parseResultSheet([["指標代號", "審查月份"]]).headerErrors.length > 0,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
