import { createRequire } from "node:module";
import { readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const esbuildPackage = readdirSync(resolve(root, "node_modules/.pnpm")).find(
  (entry) => entry.startsWith("esbuild@"),
);
if (!esbuildPackage) throw new Error("pnpm esbuild package not found");
const { build } = await import(
  pathToFileURL(
    resolve(root, "node_modules/.pnpm", esbuildPackage, "node_modules/esbuild/lib/main.js"),
  ).href,
);
writeFileSync(
  "/tmp/review-summaries-test.ts",
  `export { buildReviewSummaries } from "${root}/src/lib/reviewSummaries";\nexport { questionErrorRows, questionErrorRowsFromSummaries } from "${root}/src/lib/analysisRates";`,
);
await build({
  entryPoints: ["/tmp/review-summaries-test.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/review-summaries-test.cjs",
  logLevel: "silent",
});
const lib = createRequire("/tmp/review-summaries-test.cjs")(
  "/tmp/review-summaries-test.cjs",
);
let failures = 0;
const assert = (label, condition) => {
  if (!condition) {
    failures += 1;
    console.error(`FAIL: ${label}`);
  }
};

const record = (overrides = {}) => ({
  recordId: "r1",
  indicatorId: "ind-1",
  scheduleStartYear: 2026,
  scheduleStartMonth: 8,
  indicatorVersion: "v1.0",
  thresholdAtSchedule: 90,
  thresholdRuleAtSchedule: ">=",
  unitId: "U1",
  rate: 90,
  answers: [
    { questionId: "q1", itemText: "題目甲", optionLabel: "否" },
    { questionId: "q2", itemText: "題目乙", optionLabel: "不適用" },
  ],
  ...overrides,
});
const summaries = lib.buildReviewSummaries(
  [
    record(),
    record({ recordId: "r2", unitId: "U2", rate: 89 }),
    // 同筆重覆輸入時以最後一份紀錄為準，不重複計數。
    record({ rate: 91 }),
    // 無效結果不納入總審查數。
    record({ recordId: "r3", rate: null }),
    // 不同版本必須分開摘要。
    record({ recordId: "r4", indicatorVersion: "v1.1", rate: 95 }),
  ],
  "test-time",
);
const find = (scope, version = "v1.0", unitId = null) =>
  summaries.find(
    (summary) =>
      summary.scope === scope &&
      summary.indicatorVersion === version &&
      summary.unitId === unitId,
  );
const allV1 = find("all");
const u1V1 = find("unit", "v1.0", "U1");
assert("全院 v1.0 計兩筆有效紀錄", allV1?.totalCount === 2);
assert("排程快照閾值 >= 判定達標數", allV1?.passedCount === 1);
assert("單位摘要依單位隔離", u1V1?.totalCount === 1 && u1V1.passedCount === 1);
assert("摘要保留建立時間", allV1?.precomputedAt === "test-time");
assert("題目否/不適用選項統計", allV1?.questionOptions[0]?.no === 2 && allV1.questionOptions[1]?.notApplicable === 2);
assert("原因統計空間先行保留", Object.keys(allV1?.questionOptions[0]?.reasonCounts ?? {}).length === 0);
assert("v1.1 獨立彙總", find("all", "v1.1")?.totalCount === 1);

const errors = lib.questionErrorRows([
  {
    indicatorId: "ind-1",
    unitId: "U1",
    year: 2026,
    month: 8,
    rate: 80,
    indicatorVersion: "v1.0",
    personEmpNo: "",
    personName: "",
    answers: [
      { questionId: "q1", itemText: "題目甲", optionLabel: "否", score: 0 },
      { questionId: "q1", itemText: "題目甲", optionLabel: "是", score: 1 },
      { questionId: "q2", itemText: "題目乙", optionLabel: "不適用", score: 0 },
    ],
  },
  {
    indicatorId: "ind-1",
    unitId: "U2",
    year: 2026,
    month: 9,
    rate: 90,
    indicatorVersion: "v1.1",
    personEmpNo: "",
    personName: "",
    answers: [
      { questionId: "q1", itemText: "題目甲", optionLabel: "否", score: 0 },
    ],
  },
]);
assert("同筆同題以最後答案計一次並跨版本合併", errors.find((r) => r.itemText === "題目甲")?.yes === 1 && errors.find((r) => r.itemText === "題目甲")?.no === 1);
assert("相同題目文字跨版本合併排行並標註版本", errors.find((r) => r.itemText === "題目甲")?.sourceVersions?.length === 2);
assert("錯誤率排除不適用", errors.find((r) => r.questionId === "q2")?.errorRate === null);
assert("錯誤排行以否數降序", errors[0]?.indicatorVersion === "跨版本（v1.0、v1.1）" && errors[0]?.no === 1);
const summaryErrors = lib.questionErrorRowsFromSummaries([
  { indicatorVersion: "v1.0", questionOptions: [{ questionId: "q1", itemText: "共同題", yes: 2, no: 3, notApplicable: 1 }] },
  { indicatorVersion: "v1.1", questionOptions: [{ questionId: "q2", itemText: "共同題", yes: 1, no: 4, notApplicable: 0 }] },
]);
assert("摘要錯題跨版本合併且不納入不適用", summaryErrors[0]?.no === 7 && summaryErrors[0]?.validCount === 10 && summaryErrors[0]?.sourceVersions?.length === 2);

if (failures) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("PASS: review summary and question error analysis assertions");
