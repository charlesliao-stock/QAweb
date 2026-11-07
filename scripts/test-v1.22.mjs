/**
 * v1.22.0 斷言測試：指標管理審核表調整（7 項）
 * - 新增分組不產生「未分組」群組（未分組只是虛擬顯示區）
 * - 分組改名、刪除分組（題目移回未分組，不刪題）
 * - 新題選項預設「是/否」
 * - 新符合啟用條件的判定函式
 * - 題目移動／排序（分組內、跨分組）
 * - 批次審核表範本欄位順序與組別＋編號匯入對應
 * 用 esbuild 打包後在 node 執行（被測函式皆零依賴）。
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";

const ROOT = process.cwd();

const entry = `
import {
  defaultOptionSet, emptyAuditQuestion, asOptionSet,
  createQuestionGroup, renameQuestionGroupInList,
  moveQuestionInList, moveQuestionToGroupInList,
  removeQuestionGroupFromList,
  isBasicCompleteFor, hasAuditQuestionFor, meetsEnableConditions,
  normalizeQuestions, mergeQuestionGroups,
} from "${ROOT}/src/lib/indicators";
import {
  auditTemplateRows, parseAuditSheet, validateAuditRows,
} from "${ROOT}/src/lib/import";
export {
  defaultOptionSet, emptyAuditQuestion, asOptionSet,
  createQuestionGroup, renameQuestionGroupInList,
  moveQuestionInList, moveQuestionToGroupInList,
  removeQuestionGroupFromList,
  isBasicCompleteFor, hasAuditQuestionFor, meetsEnableConditions,
  normalizeQuestions, mergeQuestionGroups,
  auditTemplateRows, parseAuditSheet, validateAuditRows,
};
`;
writeFileSync("/tmp/v122-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v122-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v122-test-bundle.cjs",
  logLevel: "silent",
  define: { "import.meta.env": "{}" },
});
const require2 = createRequire("/tmp/v122-test-bundle.cjs");
const L = require2("/tmp/v122-test-bundle.cjs");

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

/* ---------- 1. 新題選項預設「是/否」 ---------- */
assert("新題預設是/否", L.defaultOptionSet() === "yes-no");
assert(
  "emptyAuditQuestion 預設是/否",
  L.emptyAuditQuestion(null, "").optionSet === "yes-no",
);
assert(
  "舊資料缺值仍視為是/否/不適用",
  L.asOptionSet("") === "yes-no-na" && L.asOptionSet(undefined) === "yes-no-na",
);

/* ---------- 2. 新增分組不產生未分組群組 ---------- */
const g1 = L.createQuestionGroup([]);
assert("新增分組：第 1 個命名分組 1", g1.name === "分組 1");
assert("新增分組：order 0", g1.order === 0);
const g2 = L.createQuestionGroup([g1]);
assert("新增分組：第 2 個命名分組 2", g2.name === "分組 2");
assert("新增分組：order 1", g2.order === 1);
assert(
  "新增分組只產生一個新分組（無未分組群組）",
  ![g1, g2].some((g) => g.name.includes("未分組")),
);
const nqUngrouped = L.normalizeQuestions([
  { id: "q1", itemText: "題目一", optionSet: "yes-no", groupId: null, groupName: "", order: 0 },
]);
assert(
  "未分組題目不衍生任何分組",
  nqUngrouped.groups.length === 0 && nqUngrouped.useGroups === false,
);
assert(
  "mergeQuestionGroups：無儲存分組＋無衍生分組＝空",
  L.mergeQuestionGroups([], nqUngrouped.groups).length === 0,
);

/* ---------- 3. 分組改名 ---------- */
const groups3 = [
  { id: "ga", name: "執行前", order: 0 },
  { id: "gb", name: "執行後", order: 1 },
];
const qs3 = [
  { id: "q1", itemText: "題一", optionSet: "yes-no", guidance: "", groupId: "ga", groupName: "執行前", order: 0 },
  { id: "q2", itemText: "題二", optionSet: "yes-no", guidance: "", groupId: "gb", groupName: "執行後", order: 0 },
];
const renamed = L.renameQuestionGroupInList(groups3, qs3, "ga", "準備階段");
assert(
  "改名：分組表同步",
  renamed.questionGroups.find((g) => g.id === "ga").name === "準備階段",
);
assert(
  "改名：其下題目 groupName 同步",
  renamed.questions.find((q) => q.id === "q1").groupName === "準備階段",
);
assert(
  "改名：他組題目不受影響",
  renamed.questions.find((q) => q.id === "q2").groupName === "執行後",
);

/* ---------- 4. 刪除分組：題目移回未分組，不刪題 ---------- */
const removed = L.removeQuestionGroupFromList(groups3, qs3, "ga");
assert("刪分組：分組表剩 1 組", removed.questionGroups.length === 1);
assert(
  "刪分組：其餘分組 order 重排",
  removed.questionGroups[0].id === "gb" && removed.questionGroups[0].order === 0,
);
assert("刪分組：題目總數不變", removed.questions.length === 2);
const movedBack = removed.questions.find((q) => q.id === "q1");
assert(
  "刪分組：其下題目移回未分組",
  movedBack.groupId === null && movedBack.groupName === "",
);
assert(
  "刪分組：他組題目歸屬不變",
  removed.questions.find((q) => q.id === "q2").groupId === "gb",
);

/* ---------- 5. 題目移動／排序 ---------- */
const qs5 = [
  { id: "q1", itemText: "一", optionSet: "yes-no", guidance: "", groupId: "ga", groupName: "A", order: 0 },
  { id: "q2", itemText: "二", optionSet: "yes-no", guidance: "", groupId: "ga", groupName: "A", order: 1 },
  { id: "q3", itemText: "三", optionSet: "yes-no", guidance: "", groupId: "ga", groupName: "A", order: 2 },
  { id: "q4", itemText: "四", optionSet: "yes-no", guidance: "", groupId: null, groupName: "", order: 3 },
];
const down = L.moveQuestionInList(qs5, "q1", 1);
assert(
  "下移：同分組內交換",
  down[0].id === "q2" && down[1].id === "q1" && down[2].id === "q3",
);
const up = L.moveQuestionInList(qs5, "q3", -1);
assert("上移：同分組內交換", up[1].id === "q3" && up[2].id === "q2");
const topNoop = L.moveQuestionInList(qs5, "q1", -1);
assert("上移頂端不動", eq(topNoop.map((q) => q.id), ["q1", "q2", "q3", "q4"]));
const ungroupedNoop = L.moveQuestionInList(qs5, "q4", 1);
assert(
  "未分組唯一題目移動不動",
  eq(ungroupedNoop.map((q) => q.id), ["q1", "q2", "q3", "q4"]),
);
const cross = L.moveQuestionToGroupInList(qs5, groups3, "q4", "gb");
const q4moved = cross.find((q) => q.id === "q4");
assert(
  "跨分組移動：歸屬改為目標分組",
  q4moved.groupId === "gb" && q4moved.groupName === "執行後",
);
assert("跨分組移動：移入目標分組尾端", cross[cross.length - 1].id === "q4");
const toUngrouped = L.moveQuestionToGroupInList(qs5, groups3, "q2", null);
const q2moved = toUngrouped.find((q) => q.id === "q2");
assert(
  "移回未分組：groupId／groupName 清空",
  q2moved.groupId === null && q2moved.groupName === "",
);

/* ---------- 6. 新符合啟用條件的判定 ---------- */
const basicFull = {
  groupId: "g-ward",
  code: "QI-001",
  name: "手部衛生遵從率",
  basicThreshold: 90,
  owners: ["E001"],
};
const oneQ = [
  { id: "q1", itemText: "題目一", optionSet: "yes-no", guidance: "", groupId: null, groupName: "", order: 0 },
];
assert(
  "啟用條件：六欄全填＋至少一題＝符合",
  L.meetsEnableConditions(basicFull, oneQ, false) === true,
);
assert(
  "啟用條件：無題目＝不符合",
  L.meetsEnableConditions(basicFull, [], false) === false,
);
assert(
  "啟用條件：空白題目不計",
  L.meetsEnableConditions(basicFull, [
    { id: "q1", itemText: "   ", optionSet: "yes-no", guidance: "", groupId: null, groupName: "", order: 0 },
  ], false) === false,
);
assert(
  "啟用條件：組別未選＝不符合",
  L.meetsEnableConditions({ ...basicFull, groupId: "" }, oneQ, false) === false,
);
assert(
  "啟用條件：名稱未填＝不符合",
  L.meetsEnableConditions({ ...basicFull, name: "  " }, oneQ, false) === false,
);
assert(
  "啟用條件：閾值無效＝不符合",
  L.meetsEnableConditions({ ...basicFull, basicThreshold: 0 }, oneQ, false) === false,
);
assert(
  "啟用條件：負責人未選＝不符合",
  L.meetsEnableConditions({ ...basicFull, owners: [] }, oneQ, false) === false,
);
assert(
  "啟用條件：新增時編號未填＝不符合",
  L.meetsEnableConditions({ ...basicFull, code: "" }, oneQ, true) === false,
);
assert(
  "啟用條件：編輯時編號由文件 ID 帶入（不看 code）",
  L.meetsEnableConditions({ ...basicFull, code: "" }, oneQ, false) === true,
);
assert(
  "isBasicCompleteFor：六欄全填有效",
  L.isBasicCompleteFor(basicFull, true) === true,
);
assert(
  "hasAuditQuestionFor：有題目文字",
  L.hasAuditQuestionFor(oneQ) === true,
);

/* ---------- 7. 批次審核表範本欄位順序與匯入對應 ---------- */
assert(
  "範本欄位順序：組別、指標編號、分組、題目、選項、審核指引",
  eq(L.auditTemplateRows()[0], [
    "組別",
    "指標編號",
    "分組",
    "題目",
    "選項",
    "審核指引",
  ]),
);
assert(
  "範本範例列組別＋編號",
  L.auditTemplateRows()[1][0] === "病房組" &&
    L.auditTemplateRows()[1][1] === "QI-001",
);
const sheet7 = [
  ["組別", "指標編號", "分組", "題目", "選項", "審核指引"],
  ["病房組", "QI-001", "執行前", "接觸病人前執行手部衛生", "是/否", "查核"],
  ["病房組", "QI-001", "", "第二題", "是/否/不適用", ""],
  ["加護組", "QI-001", "", "組別不符", "是/否", ""],
  ["病房組", "QI-999", "", "編號不在批次", "是/否", ""],
  ["病房組", "QI-001", "", "選項錯誤", "好/不好", ""],
];
const pa7 = L.parseAuditSheet(sheet7);
assert("匯入：新標題列無誤", pa7.headerErrors.length === 0);
assert("匯入：解析出組別", pa7.data[0].indicatorGroup === "病房組");
const va7 = L.validateAuditRows(pa7.data, {
  batchByCode: new Map([["QI-001", ["病房組"]]]),
});
assert("匯入：組別＋編號對應通過", va7[0].ok === true);
assert("匯入：無分組題目通過", va7[1].ok === true);
assert("匯入：組別不符失敗", va7[2].ok === false);
assert(
  "匯入：組別不符訊息含雙方組別",
  va7[2].errors.some((e) => e.includes("病房組") && e.includes("加護組")),
);
assert("匯入：編號不在批次失敗", va7[3].ok === false);
assert("匯入：選項錯誤失敗", va7[4].ok === false);
assert(
  "匯入：缺組別欄位標題報錯",
  L.parseAuditSheet([["指標編號", "題目", "選項"]]).headerErrors.length > 0,
);

console.log(`v1.22: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
