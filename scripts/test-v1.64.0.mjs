/**
 * v1.64.0 對拍測試：reviewSummary 由「摘要格」重算的結果，必須與
 * analysisRates 由「原始紀錄」算的結果完全一致（人次率、單位率、
 * 人次／單位分組計分、逐題錯誤排行）。隨機資料，固定種子。
 * 執行：node scripts/test-v1.64.0.mjs（需 esbuild）；
 * 或 SUMMARY_LIB_DIR=<tsc 輸出目錄> node scripts/test-v1.64.0.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let A, S;
if (process.env.SUMMARY_LIB_DIR) {
  const req = createRequire(join(process.env.SUMMARY_LIB_DIR, "x.js"));
  A = req("./analysisRates.js");
  S = req("./reviewSummary.js");
} else {
  const { buildSync } = await import("esbuild");
  const dir = join(ROOT, ".test-tmp");
  mkdirSync(dir, { recursive: true });
  const load = async (entry, out) => {
    buildSync({ entryPoints: [join(ROOT, entry)], bundle: true, format: "esm", platform: "node", outfile: join(dir, out) });
    return import(join(dir, out));
  };
  A = await load("src/lib/analysisRates.ts", "ar.mjs");
  S = await load("src/lib/reviewSummary.ts", "rs.mjs");
}

let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];

function makeQuestions(grouped) {
  return Array.from({ length: 6 }, (_, i) => ({
    id: `q${i}`, order: i, itemText: `題目${i}`,
    groupId: grouped ? (i < 3 ? "g1" : i < 5 ? "g2" : "") : "",
    groupName: grouped ? (i < 3 ? "組一" : i < 5 ? "組二" : "") : "",
  }));
}
function makeRecords(n, withSnap) {
  const units = ["U1", "U2", "U3", "U4"];
  const out = [];
  for (let i = 0; i < n; i++) {
    const answers = [];
    for (let q = 0; q < 6; q++) {
      if (rnd() < 0.05) continue;
      const r = rnd();
      answers.push({
        questionId: rnd() < 0.05 ? `old${q}` : `q${q}`,
        itemText: `題目${q}`,
        optionLabel: r < 0.65 ? "是" : r < 0.9 ? "否" : "不適用",
        score: 0, excluded: r >= 0.9,
      });
    }
    const yes = answers.filter((a) => !a.excluded && a.optionLabel === "是").length;
    const val = answers.filter((a) => !a.excluded).length;
    out.push({
      indicatorId: "I", unitId: pick(units), year: 2026, month: 1 + Math.floor(rnd() * 6),
      rate: val > 0 ? Math.round((yes / val) * 1000) / 10 : null,
      thresholdAtSchedule: withSnap ? pick([80, 90]) : undefined,
      indicatorVersion: pick(["v1.0", "v1.1"]),
      answers, personEmpNo: `E${i}`, personName: `P${i}`,
    });
  }
  return out;
}

let checks = 0;
for (const grouped of [true, false]) {
  const questions = makeQuestions(grouped);
  const records = makeRecords(300, true);
  const threshold = 85;
  const summary = S.buildReviewSummary({
    indicatorId: "I", scheduleCategory: "year", schedulePeriod: "2026",
    start: { year: 2026, month: 1 }, end: { year: 2026, month: 6 },
    records, questions, threshold,
  });
  assert.equal(summary.noSnapshotCount, 0);
  assert.ok(S.isSummaryUsable(summary, 99));
  const colSets = [
    [{ months: [{ year: 2026, month: 1 }] }, { months: [{ year: 2026, month: 2 }] }],
    [{ months: [1, 2, 3].map((m) => ({ year: 2026, month: m })) }, { months: [4, 5, 6].map((m) => ({ year: 2026, month: m })) }],
    [{ months: [1, 2, 3, 4, 5, 6].map((m) => ({ year: 2026, month: m })) }],
  ];
  for (const columns of colSets) {
    const allMonths = columns.flatMap((c) => c.months);
    const recs = A.recordsInMonths(records, allMonths);
    const cells = S.cellsInMonths(summary.cells, allMonths);
    assert.deepEqual(S.passRateFromCells(cells), A.passRateOf(recs, threshold)); checks++;
    for (const col of columns) {
      assert.deepEqual(
        S.unitPassRateFromCells(S.cellsInMonths(summary.cells, col.months), threshold),
        A.unitPassRate(A.recordsInMonths(records, col.months), threshold)); checks++;
    }
    assert.deepEqual(S.unitPeriodPassRateFromCells(summary.cells, columns, threshold),
      A.unitPeriodPassRate(records, columns, threshold)); checks++;
    const norm = (rows) => [...rows].sort((a, b) => a.key.localeCompare(b.key));
    assert.deepEqual(norm(S.personScoringRowsFromCells(cells, questions)),
      norm(A.personScoringBreakdownRows(recs, questions, threshold))); checks++;
    assert.deepEqual(S.unitScoringRowsFromCells(summary.cells, questions, columns, threshold),
      A.unitScoringBreakdownRows(records, questions, columns, threshold)); checks++;
    const fromSum = A.questionErrorRowsFromSummaries(S.questionSummariesFromCells(cells));
    const fromRaw = A.questionErrorRows(recs);
    const strip = (rows) => rows.map(({ itemText, yes, no, notApplicable, validCount, errorRate, sourceVersions }) =>
      ({ itemText, yes, no, notApplicable, validCount, errorRate, sourceVersions }));
    assert.deepEqual(strip(fromSum), strip(fromRaw)); checks++;
  }
}
// 無快照紀錄：閾值變動 → 摘要不可用
const s2 = S.buildReviewSummary({ indicatorId: "I", scheduleCategory: "year", schedulePeriod: "2026",
  start: { year: 2026, month: 1 }, end: { year: 2026, month: 6 },
  records: makeRecords(20, false), questions: makeQuestions(true), threshold: 85 });
assert.ok(s2.noSnapshotCount > 0);
assert.ok(S.isSummaryUsable(s2, 85));
assert.ok(!S.isSummaryUsable(s2, 90)); checks++;
console.log(`OK ${checks} checks`);

// 閾值：格閾值／欄閾值（眾數；全無快照退回 fallback；≤0 → null）
{
  const recs = [
    { thresholdAtSchedule: 80 }, { thresholdAtSchedule: 90 }, { thresholdAtSchedule: 90 }, {},
  ];
  assert.equal(A.columnThresholdOf(recs, 70), 90);
  assert.equal(A.columnThresholdOf([{}, {}], 70), 70);
  assert.equal(A.columnThresholdOf([{}], 0), null);
  assert.equal(A.columnThresholdOf([{ thresholdAtSchedule: 80 }, { thresholdAtSchedule: 90 }], 70), 90);
  const qs = makeQuestions(true);
  const rs = makeRecords(120, true);
  const sm = S.buildReviewSummary({ indicatorId: "I", scheduleCategory: "year", schedulePeriod: "2026",
    start: { year: 2026, month: 1 }, end: { year: 2026, month: 6 }, records: rs, questions: qs, threshold: 85 });
  for (let m = 1; m <= 6; m++) {
    const months = [{ year: 2026, month: m }];
    assert.equal(S.columnThresholdFromCells(S.cellsInMonths(sm.cells, months), 85),
      A.columnThresholdOf(A.recordsInMonths(rs, months), 85));
  }
  assert.ok(sm.cells.every((c) => c.indicatorVersions.length >= 1));
  console.log("OK threshold checks");
}
