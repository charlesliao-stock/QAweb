/**
 * v1.17.0 lib 斷言測試：審核表選項集（optionSet）＋基本資料閾值驗證
 * ＋新計分（是=1／否=0／不適用=不計入）＋達標判定改吃基本資料閾值
 * ＋清單排序移除版本欄。
 * 用 esbuild 打包後在 jsdom 全域環境下執行。
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";

const ROOT = "/home/hatch/workspace/repos/QAweb";

// 先建立 jsdom 全域環境，再載入被測 bundle
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.sessionStorage = dom.window.sessionStorage;

const entry = `
import { normalizeQuestions, optionLabelsOf, OPTION_SET_LABELS, asOptionSet, validateBasicThreshold, displayThreshold, effectiveThreshold, primaryThreshold, indicatorSortValue, compareIndicatorRows } from "${ROOT}/src/lib/indicators";
import { computeOptionSetScore } from "${ROOT}/src/lib/reviewRecords";
import { weakTop3, recentAlerts, paretoTop3 } from "${ROOT}/src/lib/dashboardStats";
export { normalizeQuestions, optionLabelsOf, OPTION_SET_LABELS, asOptionSet, validateBasicThreshold, displayThreshold, effectiveThreshold, primaryThreshold, indicatorSortValue, compareIndicatorRows, computeOptionSetScore, weakTop3, recentAlerts, paretoTop3 };
`;
writeFileSync("/tmp/v117-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v117-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v117-test-bundle.cjs",
  logLevel: "silent",
});
const require2 = createRequire("/tmp/v117-test-bundle.cjs");
const L = require2("/tmp/v117-test-bundle.cjs");

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

// ── 1. 選項集 helpers ──
assert("選項集標籤 是／否", L.OPTION_SET_LABELS["yes-no"] === "是／否");
assert(
  "選項集標籤 是／否／不適用",
  L.OPTION_SET_LABELS["yes-no-na"] === "是／否／不適用",
);
assert("optionLabelsOf yes-no", eq(L.optionLabelsOf("yes-no"), ["是", "否"]));
assert(
  "optionLabelsOf yes-no-na",
  eq(L.optionLabelsOf("yes-no-na"), ["是", "否", "不適用"]),
);
assert("asOptionSet 合法值保留", L.asOptionSet("yes-no") === "yes-no");
assert("asOptionSet 缺值→yes-no-na", L.asOptionSet(undefined) === "yes-no-na");
assert("asOptionSet 非法→yes-no-na", L.asOptionSet("abc") === "yes-no-na");

// ── 2. normalizeQuestions：optionSet ──
{
  // 舊格式（text/optionSet/group）→ optionSet 保留
  const nq = L.normalizeQuestions([
    { text: "Q1", optionSet: "yes-no", guidance: "g", group: "A" },
    { text: "Q2", optionSet: "yes-no-na", guidance: "", group: "A" },
  ]);
  assert("舊格式 yes-no 保留", nq.questions[0].optionSet === "yes-no");
  assert("舊格式 yes-no-na 保留", nq.questions[1].optionSet === "yes-no-na");
  assert("舊 group 轉分組", nq.useGroups === true && nq.groups.length === 1);
}
{
  // v1.16 格式（itemText＋options 陣列、無 optionSet）→ 一律 yes-no-na
  const nq = L.normalizeQuestions([
    {
      id: "q1",
      itemText: "Q1",
      options: [
        { label: "0 分", score: 0 },
        { label: "1 分", score: 1 },
      ],
      guidance: "",
      groupId: null,
      groupName: "",
      order: 0,
    },
  ]);
  assert("v1.16 無 optionSet→yes-no-na", nq.questions[0].optionSet === "yes-no-na");
}
{
  // v1.17 新格式直通
  const nq = L.normalizeQuestions([
    {
      id: "q9",
      itemText: "Q9",
      optionSet: "yes-no",
      guidance: "",
      groupId: null,
      groupName: "",
      order: 0,
    },
  ]);
  assert("新格式 optionSet 直通", nq.questions[0].optionSet === "yes-no");
}

// ── 3. 基本資料閾值驗證 ──
assert("閾值空→錯誤", L.validateBasicThreshold("") === "請填寫閾值（%）");
assert("閾值 0→錯誤", L.validateBasicThreshold(0) !== "");
assert("閾值負數→錯誤", L.validateBasicThreshold(-5) !== "");
assert("閾值小數→錯誤", L.validateBasicThreshold(1.5) !== "");
assert("閾值 101→錯誤", L.validateBasicThreshold(101) !== "");
assert("閾值 1→通過", L.validateBasicThreshold(1) === "");
assert("閾值 100→通過", L.validateBasicThreshold(100) === "");
assert("閾值 90→通過", L.validateBasicThreshold(90) === "");

// ── 4. 達標判定閾值：基本資料優先、缺值 fallback 主閾值 ──
{
  const ind = {
    basicThreshold: 90,
    tenSteps: { step5: { thresholds: [{ name: "主", value: 80 }] } },
  };
  assert("基本資料閾值優先", L.effectiveThreshold(ind) === 90);
  const old = {
    basicThreshold: null,
    tenSteps: { step5: { thresholds: [{ name: "主", value: 80 }] } },
  };
  assert("缺值 fallback 主閾值", L.effectiveThreshold(old) === 80);
  assert("primaryThreshold 仍可用", L.primaryThreshold(old) === 80);
  assert("displayThreshold 0 有效", L.displayThreshold(0, 80) === 0);
}

// ── 5. 新計分：是=1／否=0／不適用=不計入 ──
{
  const r = L.computeOptionSetScore([
    { score: 1, excluded: false },
    { score: 0, excluded: false },
    { score: 0, excluded: true },
  ]);
  assert("計分 totalScore=1", r.totalScore === 1);
  assert("計分 maxScore=2（排除不適用）", r.maxScore === 2);
  assert("計分 rate=50", r.rate === 50);
}
{
  const r = L.computeOptionSetScore([
    { score: 0, excluded: true },
    { score: 0, excluded: true },
  ]);
  assert("全不適用→rate null", r.rate === null && r.maxScore === 0);
}
{
  const r = L.computeOptionSetScore([
    { score: 1, excluded: false },
    { score: 1, excluded: false },
    { score: 1, excluded: false },
  ]);
  assert("全是→rate 100", r.rate === 100);
}

// ── 6. 缺失統計排除不適用 ──
{
  const recs = [
    {
      reviewedPersonEmpNo: "A1",
      unitId: "9A",
      indicatorId: "QI-001",
      submittedAt: { toDate: () => new Date() },
      answers: [
        { itemText: "Q1", optionLabel: "否", score: 0 },
        { itemText: "Q2", optionLabel: "不適用", score: 0, excluded: true },
      ],
    },
  ];
  const w = L.weakTop3(recs, "A1");
  assert("weakTop3 只計否", w.length === 1 && w[0].itemText === "Q1");
  const p = L.paretoTop3(recs);
  assert("paretoTop3 排除不適用", p.length === 1 && p[0].itemText === "Q1");
  const al = L.recentAlerts(recs, "9A", 48, Date.now());
  assert(
    "recentAlerts 排除不適用",
    al.length === 1 && al[0].items.length === 1 && al[0].items[0].itemText === "Q1",
  );
}

// ── 7. 清單排序：版本欄移除，其餘鍵正常 ──
{
  const row = {
    code: "QI-001",
    name: "測試",
    groupId: "g",
    status: "啟用",
    version: "v1.0",
    mainThreshold: 80,
    basicThreshold: 90,
  };
  assert("排序 threshold 吃基本資料閾值", L.indicatorSortValue(row, "threshold", "組") === 90);
  assert("排序 code", L.indicatorSortValue(row, "code", "組") === "QI-001");
  assert("排序 status", L.indicatorSortValue(row, "status", "組") === "啟用");
  const b = { ...row, code: "QI-002" };
  const g = () => "組";
  assert(
    "compareIndicatorRows code 升冪",
    L.compareIndicatorRows(row, b, "code", 1, g) < 0,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
