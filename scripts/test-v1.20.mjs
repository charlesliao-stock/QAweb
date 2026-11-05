/**
 * v1.20.0 斷言測試：批次匯入解析與驗證（CSV／基本資料／審核表／範本）、
 * 頻次衍生區間 tile 全年、品管審查本月區間包含判定與篩選。
 * 用 esbuild 打包後在 node 執行（被測函式皆零依賴）。
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";

const ROOT = "/home/hatch/workspace/repos/QAweb";

const entry = `
import {
  parseCSV, normalizeSheetRows, toCSV, splitOwners, parseOptionSetLabel,
  parseBasicSheet, validateBasicRows, parseAuditSheet, validateAuditRows,
  basicTemplateRows, auditTemplateRows,
} from "${ROOT}/src/lib/import";
import {
  autoSelectMonths, intervalMonthsForFrequency,
} from "${ROOT}/src/lib/scheduling";
import {
  scheduleIntervals, containingInterval, auditRowMatches,
} from "${ROOT}/src/lib/reviewActive";
export {
  parseCSV, normalizeSheetRows, toCSV, splitOwners, parseOptionSetLabel,
  parseBasicSheet, validateBasicRows, parseAuditSheet, validateAuditRows,
  basicTemplateRows, auditTemplateRows,
  autoSelectMonths, intervalMonthsForFrequency,
  scheduleIntervals, containingInterval, auditRowMatches,
};
`;
writeFileSync("/tmp/v120-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v120-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v120-test-bundle.cjs",
  logLevel: "silent",
  define: { "import.meta.env": "{}" },
});
const require2 = createRequire("/tmp/v120-test-bundle.cjs");
const L = require2("/tmp/v120-test-bundle.cjs");

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

/* ---------- 1. CSV 解析 ---------- */
assert(
  "CSV：引號內逗號不切欄",
  eq(L.parseCSV('a,"b,c",d'), [["a", "b,c", "d"]]),
);
assert(
  "CSV：雙引號轉義",
  eq(L.parseCSV('"a""b",c'), [['a"b', "c"]]),
);
assert(
  "CSV：CRLF 與 LF 混用",
  eq(L.parseCSV("a,b\r\nc,d\ne,f"), [
    ["a", "b"],
    ["c", "d"],
    ["e", "f"],
  ]),
);
assert(
  "CSV：引號內換行保留",
  eq(L.parseCSV('"a\nb",c'), [["a\nb", "c"]]),
);
assert(
  "CSV：BOM 去除",
  eq(L.parseCSV("﻿a,b"), [["a", "b"]]),
);
assert(
  "CSV 序列化：含逗號加引號",
  L.toCSV([["a", "b,c"]]) === 'a,"b,c"',
);

/* ---------- 2. 負責人／選項解析 ---------- */
assert(
  "splitOwners：、 ， , ; 混用",
  eq(L.splitOwners("A1、A2，A3,A4;A5"), ["A1", "A2", "A3", "A4", "A5"]),
);
assert("splitOwners：空字串", eq(L.splitOwners(""), []));
assert("選項：是/否", L.parseOptionSetLabel("是/否") === "yes-no");
assert(
  "選項：是／否／不適用（全形斜線）",
  L.parseOptionSetLabel("是／否／不適用") === "yes-no-na",
);
assert("選項：無效→null", L.parseOptionSetLabel("是") === null);

/* ---------- 3. 基本資料匯入 ---------- */
const groupByName = new Map([
  ["病房組", "g1"],
  ["門診組", "g2"],
]);
const staffHas = (id) => ["A12345", "B23456"].includes(id);
const ctx = {
  groupByName,
  // v1.21：existingCodes 改為複合 ID 集合（`${groupId}__${code}`）
  existingCodes: new Set(["g1__QI-000"]),
  staffHas,
  staffLoaded: true,
};
const basicSheet = [
  ["組別", "編號", "指標名稱", "閾值(%)", "負責人"],
  ["病房組", "QI-001", "手部衛生遵從率", "90", "A12345"],
  ["門診組", "QI-002", "給藥正確率", "95", "A12345、B23456"],
  ["未知組", "QI-003", "錯的組別", "80", "A12345"],
  ["病房組", "QI-001", "重複編號", "80", "A12345"],
  ["病房組", "QI-000", "已存在編號", "80", "A12345"],
  ["病房組", "QI-004", "閾值為零", "0", "A12345"],
  ["病房組", "QI-005", "閾值非整數", "90.5", "A12345"],
  ["病房組", "QI-006", "職編不存在", "80", "Z99999"],
];
const pb = L.parseBasicSheet(basicSheet);
assert("基本資料：標題列無誤", pb.headerErrors.length === 0);
assert("基本資料：8 筆資料列", pb.data.length === 8);
const vb = L.validateBasicRows(pb.data, ctx);
assert("基本資料：第 1 列通過", vb[0].ok === true);
assert(
  "基本資料：第 1 列負責人解析",
  eq(vb[0].values.owners, ["A12345"]),
);
assert(
  "基本資料：第 2 列多位負責人",
  vb[1].ok === true && eq(vb[1].values.owners, ["A12345", "B23456"]),
);
assert("基本資料：未知組別有誤", vb[2].ok === false);
assert("基本資料：檔內編號重複有誤", vb[3].ok === false);
assert("基本資料：已存在編號有誤", vb[4].ok === false);
assert("基本資料：閾值 0 有誤", vb[5].ok === false);
assert("基本資料：閾值非整數有誤", vb[6].ok === false);
assert("基本資料：職編不存在有誤", vb[7].ok === false);
assert(
  "基本資料：缺少欄位報錯",
  L.parseBasicSheet([["組別", "編號"]]).headerErrors.length > 0,
);

/* ---------- 4. 審核表匯入（v1.22 欄位順序：組別、指標編號、分組、題目、選項、審核指引） ---------- */
const auditSheet = [
  ["組別", "指標編號", "分組", "題目", "選項", "審核指引"],
  ["病房組", "QI-001", "執行前", "接觸病人前執行手部衛生", "是/否/不適用", "查核"],
  ["病房組", "QI-001", "", "第二題", "是/否", ""],
  ["病房組", "QI-999", "", "編號不在批次", "是/否", ""],
  ["病房組", "QI-001", "", "選項錯誤", "好/不好", ""],
  ["病房組", "QI-001", "", "", "是/否", ""],
  ["加護組", "QI-001", "", "組別不符", "是/否", ""],
];
const pa = L.parseAuditSheet(auditSheet);
assert("審核表：標題列無誤", pa.headerErrors.length === 0);
const va = L.validateAuditRows(pa.data, {
  batchByCode: new Map([["QI-001", ["病房組"]]]),
});
assert("審核表：第 1 題通過", va[0].ok === true);
assert("審核表：第 1 題選項集", va[0].values.optionSet === "yes-no-na");
assert("審核表：第 1 題組別", va[0].values.indicatorGroup === "病房組");
assert("審核表：第 2 題通過（無分組）", va[1].ok === true);
assert("審核表：編號不在批次有誤", va[2].ok === false);
assert("審核表：選項錯誤有誤", va[3].ok === false);
assert("審核表：題目空白有誤", va[4].ok === false);
assert("審核表：組別與批次不符有誤", va[5].ok === false);
assert(
  "審核表：組別不符錯誤訊息含批次組別",
  va[5].errors.some((e) => e.includes("病房組") && e.includes("加護組")),
);

/* ---------- 5. 範本 ---------- */
assert(
  "基本資料範本標題",
  eq(L.basicTemplateRows()[0], ["組別", "編號", "指標名稱", "閾值(%)", "負責人"]),
);
assert("基本資料範本有範例列", L.basicTemplateRows().length === 2);
assert(
  "審核表範本標題",
  eq(L.auditTemplateRows()[0], [
    "組別",
    "指標編號",
    "分組",
    "題目",
    "選項",
    "審核指引",
  ]),
);

/* ---------- 6. 頻次衍生區間 tile 全年 ---------- */
assert("區間衍生：2次→6", L.intervalMonthsForFrequency(2) === 6);
const sched2 = {
  category: "year",
  period: "2026",
  months: [1, 7],
  frequency: 2,
  intervalMonths: 6,
  refYear: null,
};
const ivs2 = L.scheduleIntervals(sched2, new Date(2026, 0, 15));
assert(
  "2次/年：區間 [1-6]、[7-12] 覆蓋全年",
  ivs2.length === 2 &&
    ivs2[0].start.month === 1 &&
    ivs2[0].end.month === 6 &&
    ivs2[1].start.month === 7 &&
    ivs2[1].end.month === 12,
);
const schedAcad = {
  category: "academic",
  period: "115",
  months: [8, 2],
  frequency: 2,
  intervalMonths: 6,
  refYear: null,
};
const ivsA = L.scheduleIntervals(schedAcad, new Date(2026, 10, 15));
assert(
  "學年度 2次/年：區間 [2026/8-2027/1]、[2027/2-2027/7]",
  ivsA.length === 2 &&
    ivsA[0].start.year === 2026 &&
    ivsA[0].end.year === 2027 &&
    ivsA[0].end.month === 1 &&
    ivsA[1].end.month === 7,
);

/* ---------- 7. 本月區間包含判定 ---------- */
const t = (y, m, d = 15) => new Date(y, m - 1, d);
assert(
  "包含：11 月在 10-12 區間內",
  L.containingInterval(sched2, t(2026, 11)) !== null,
);
assert(
  "空隙：今天在區間空隙（手動月份）→ null",
  L.containingInterval(
    {
      category: "year",
      period: "2026",
      months: [1],
      frequency: 4,
      intervalMonths: 3,
      refYear: null,
    },
    t(2026, 6),
  ) === null,
);
assert(
  "早於第一區間 → null",
  L.containingInterval(sched2, t(2025, 12)) === null,
);
assert(
  "晚於最後區間 → null",
  L.containingInterval(sched2, t(2027, 1)) === null,
);

/* ---------- 8. 品管審查篩選 ---------- */
const row = { groupId: "g1", indicatorId: "QI-001", indicatorName: "手部衛生" };
assert(
  "篩選：全空→通過",
  L.auditRowMatches(row, { groupId: "", indicatorId: "", keyword: "" }) === true,
);
assert(
  "篩選：組別不符→擋",
  L.auditRowMatches(row, { groupId: "g2", indicatorId: "", keyword: "" }) === false,
);
assert(
  "篩選：指標不符→擋",
  L.auditRowMatches(row, { groupId: "", indicatorId: "QI-002", keyword: "" }) === false,
);
assert(
  "篩選：關鍵字命中名稱",
  L.auditRowMatches(row, { groupId: "", indicatorId: "", keyword: "手部" }) === true,
);
assert(
  "篩選：關鍵字命中編號",
  L.auditRowMatches(row, { groupId: "", indicatorId: "", keyword: "qi-001" }) === true,
);
assert(
  "篩選：關鍵字不符→擋",
  L.auditRowMatches(row, { groupId: "", indicatorId: "", keyword: "給藥" }) === false,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
