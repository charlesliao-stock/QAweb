/**
 * v1.27.0 斷言測試：結果分析下探功能——
 * - 單位率新定義（達閾值單位數／總審查單位數；單位達閾值＝該單位率 ≥ 閾值）
 * - unit-period 彙總（一個單位在兩個期間欄受審＝兩筆審查）
 * - 格格式 75%(3/4)／75% (3/4)／無資料 —
 * - 下探 L1 單位清單（該期間欄內有紀錄的單位）
 * - 下探 L2 人員各選項結果（依職編、年月排序；達閾值標示）
 * 用 esbuild 打包後在 node 執行（被測函式皆零依賴／純函式）。
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";

const ROOT = "/home/hatch/workspace/repos/QAweb";

const entry = `
import {
  isPassing,
  isUnitPassing,
  passRateOf,
  unitPassRate,
  unitPeriodPassRate,
  unitsForDrill,
  personOptionRows,
  formatPassRate,
} from "${ROOT}/src/lib/analysisRates";
export {
  isPassing,
  isUnitPassing,
  passRateOf,
  unitPassRate,
  unitPeriodPassRate,
  unitsForDrill,
  personOptionRows,
  formatPassRate,
};
`;
writeFileSync("/tmp/v127-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v127-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v127-test-bundle.cjs",
  logLevel: "silent",
  define: { "import.meta.env": "{}" },
});
const require2 = createRequire("/tmp/v127-test-bundle.cjs");
const L = require2("/tmp/v127-test-bundle.cjs");

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

const mkRec = (unitId, rate, year = 2026, month = 1, emp = "E001", name = "王小明") => ({
  indicatorId: "ind1",
  unitId,
  year,
  month,
  rate,
  answers: [],
  personEmpNo: emp,
  personName: name,
});

/* ---- 單位是否達閾值 ---- */
{
  assert("單位率達閾值", L.isUnitPassing(80, 80) === true);
  assert("單位率未達閾值", L.isUnitPassing(79.9, 80) === false);
  assert("單位率 null 未達標", L.isUnitPassing(null, 80) === false);
  assert("閾值未設定單位不達標", L.isUnitPassing(100, 0) === false);
}

/* ---- 單位率＝達閾值單位數／總審查單位數 ---- */
{
  const r = L.unitPassRate(
    [mkRec("U1", 90), mkRec("U1", 70), mkRec("U2", 100)],
    80,
  );
  assert("單位率 1/2（U1 50% 未達標、U2 達標）", r.pass === 1 && r.total === 2);
  assert("單位率 50%", r.rate === 50);
  const all = L.unitPassRate([mkRec("U1", 90), mkRec("U2", 100)], 80);
  assert("單位全達標 100%", all.pass === 2 && all.rate === 100);
  const none = L.unitPassRate([mkRec("U1", 70), mkRec("U2", 60)], 80);
  assert("單位全未達標 0%", none.pass === 0 && none.rate === 0);
  const zero = L.unitPassRate([mkRec("U1", 100)], 0);
  assert("閾值 0 單位不達標", zero.pass === 0 && zero.total === 1);
  const empty = L.unitPassRate([], 80);
  assert("單位率無資料", empty.rate === null && empty.total === 0);
  const nullRates = L.unitPassRate([mkRec("U1", null)], 80);
  assert("全 null 率單位不達標", nullRates.pass === 0 && nullRates.total === 1);
}

/* ---- unit-period 彙總 ---- */
{
  const cols = [
    { months: [{ year: 2026, month: 1 }] },
    { months: [{ year: 2026, month: 2 }] },
  ];
  const recs = [
    mkRec("U1", 90, 2026, 1),
    mkRec("U1", 70, 2026, 1),
    mkRec("U1", 100, 2026, 2),
    mkRec("U2", 100, 2026, 2),
  ];
  const r = L.unitPeriodPassRate(recs, cols, 80);
  // 欄1：U1 未達標 0/1；欄2：U1、U2 達標 2/2；合計 2/3
  assert("unit-period 2/3", r.pass === 2 && r.total === 3);
  assert("unit-period 66.7%", r.rate === 66.7);
  const empty = L.unitPeriodPassRate([], cols, 80);
  assert("unit-period 無資料", empty.rate === null && empty.total === 0);
}

/* ---- 格格式 ---- */
{
  assert(
    "75%(3/4)",
    L.formatPassRate({ pass: 3, total: 4, rate: 75 }) === "75%(3/4)",
  );
  assert(
    "75% (3/4) 空格版",
    L.formatPassRate({ pass: 3, total: 4, rate: 75 }, true) === "75% (3/4)",
  );
  assert(
    "小數一位 66.7%(2/3)",
    L.formatPassRate({ pass: 2, total: 3, rate: 66.7 }) === "66.7%(2/3)",
  );
  assert(
    "無資料 —",
    L.formatPassRate({ pass: 0, total: 0, rate: null }) === "—",
  );
}

/* ---- 下探 L1 單位清單 ---- */
{
  const recs = [
    mkRec("U2", 90, 2026, 1),
    mkRec("U1", 90, 2026, 1),
    mkRec("U1", 90, 2026, 2),
    mkRec("U3", 90, 2026, 3),
  ];
  const got = L.unitsForDrill(recs, [
    { year: 2026, month: 1 },
    { year: 2026, month: 2 },
  ]);
  assert(
    "L1 單位清單依代號排序去重",
    JSON.stringify(got) === JSON.stringify(["U1", "U2"]),
  );
  assert(
    "L1 空期間無單位",
    L.unitsForDrill(recs, [{ year: 2025, month: 1 }]).length === 0,
  );
}

/* ---- 下探 L2 人員各選項結果 ---- */
{
  const recs = [
    {
      ...mkRec("U1", 90, 2026, 2, "E002", "李大華"),
      answers: [
        { questionId: "q1", itemText: "題一", optionLabel: "是", score: 1 },
        { questionId: "q2", itemText: "題二", optionLabel: "否", score: 0 },
      ],
    },
    {
      ...mkRec("U1", 70, 2026, 1, "E001", "王小明"),
      answers: [
        { questionId: "q1", itemText: "題一", optionLabel: "否", score: 0 },
        { questionId: "q2", itemText: "題二", optionLabel: "是", score: 1 },
      ],
    },
    {
      ...mkRec("U1", 100, 2026, 1, "E001", "王小明"),
      answers: [
        { questionId: "q1", itemText: "題一", optionLabel: "是", score: 1 },
      ],
    },
  ];
  const rows = L.personOptionRows(recs, 80);
  assert("L2 依職編、年月排序", rows[0].personEmpNo === "E001" && rows[0].month === 1);
  assert("L2 同人多筆各列一行", rows.filter((r) => r.personEmpNo === "E001").length === 2);
  assert("L2 達閾值標示", rows[0].passing === false && rows[1].passing === true);
  assert(
    "L2 題目作答對應",
    rows[0].answers.get("q1") === "否" && rows[0].answers.get("q2") === "是",
  );
  assert("L2 缺題回 undefined", rows[1].answers.get("q2") === undefined);
  assert("L2 空紀錄", L.personOptionRows([], 80).length === 0);
}

console.log(`pass ${passed}, fail ${failed}`);
if (failed) process.exit(1);
