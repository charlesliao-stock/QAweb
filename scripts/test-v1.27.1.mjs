/**
 * v1.27.1 斷言測試：下探 L2 人員矩陣轉置——
 * - 直向＝題目（每列一題）、橫向＝人員姓名（每欄一人）
 * - 欄位標頭遮罩（王小明→王O明）；無姓名顯示職編
 * - 人員順序維持 personOptionRows 的順序（職編、年月）
 * - 中間＝審查結果（無作答顯示 —）
 * - 最下方「正確率」列（每人得分＋達閾值標示）
 * 用 esbuild 打包後在 node 執行（被測函式皆零依賴／純函式）。
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";

const ROOT = "/home/hatch/workspace/repos/QAweb";

const entry = `
import {
  personOptionRows,
  transposePersonOptionRows,
} from "${ROOT}/src/lib/analysisRates";
export { personOptionRows, transposePersonOptionRows };
`;
writeFileSync("/tmp/v1271-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v1271-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v1271-test-bundle.cjs",
  logLevel: "silent",
  define: { "import.meta.env": "{}" },
});
const require2 = createRequire("/tmp/v1271-test-bundle.cjs");
const L = require2("/tmp/v1271-test-bundle.cjs");

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

const questions = [
  { id: "q1", itemText: "題一" },
  { id: "q2", itemText: "題二" },
];

/* ---- 下探 L2 轉置 ---- */
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
    {
      ...mkRec("U1", 80, 2026, 1, "E003", ""),
      answers: [
        { questionId: "q1", itemText: "題一", optionLabel: "是", score: 1 },
        { questionId: "q2", itemText: "題二", optionLabel: "是", score: 1 },
      ],
    },
  ];
  const rows = L.personOptionRows(recs, 80);
  const m = L.transposePersonOptionRows(rows, questions);
  assert(
    "欄位標頭遮罩／順序維持",
    JSON.stringify(m.headers) ===
      JSON.stringify(["王O明", "王O明", "李O華", "E003"]),
  );
  assert(
    "無姓名顯示職編",
    m.headers[3] === "E003",
  );
  assert(
    "直向為題目（列順序與題目順序一致）",
    m.rows.length === 2 &&
      m.rows[0].questionId === "q1" &&
      m.rows[0].itemText === "題一" &&
      m.rows[1].questionId === "q2",
  );
  assert(
    "題一作答轉置正確",
    JSON.stringify(m.rows[0].values) === JSON.stringify(["否", "是", "是", "是"]),
  );
  assert(
    "題二缺作答顯示 —",
    JSON.stringify(m.rows[1].values) === JSON.stringify(["是", "—", "否", "是"]),
  );
  assert(
    "正確率列得分與達閾值標示",
    JSON.stringify(m.rates) ===
      JSON.stringify([
        { rate: 70, passing: false },
        { rate: 100, passing: true },
        { rate: 90, passing: true },
        { rate: 80, passing: true },
      ]),
  );
  assert(
    "空紀錄轉置為空",
    (() => {
      const e = L.transposePersonOptionRows([], questions);
      return (
        e.headers.length === 0 &&
        e.rates.length === 0 &&
        e.rows.length === 2 &&
        e.rows[0].values.length === 0
      );
    })(),
  );
}

console.log(`pass ${passed}, fail ${failed}`);
if (failed) process.exit(1);
