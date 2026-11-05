/**
 * v1.24.0 斷言測試：審查畫面版面優化——
 * - 分組方框：一個組別一段、未分組自成一段、showGroups=false 時不分組
 * - 檢視逐題明細：按指標題目順序、備註（note）保留、指引取自當前題目、
 *   無對應題目者排最後歸未分組
 * 用 esbuild 打包後在 node 執行（被測函式皆零依賴／純函式）。
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";

const ROOT = "/home/hatch/workspace/repos/QAweb";

const entry = `
import { groupQuestionsIntoSections } from "${ROOT}/src/lib/indicators";
import { resolveReviewViewSections } from "${ROOT}/src/lib/reviewRecords";
export { groupQuestionsIntoSections, resolveReviewViewSections };
`;
writeFileSync("/tmp/v124-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v124-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v124-test-bundle.cjs",
  logLevel: "silent",
  define: { "import.meta.env": "{}" },
});
const require2 = createRequire("/tmp/v124-test-bundle.cjs");
const L = require2("/tmp/v124-test-bundle.cjs");

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

const q = (id, groupId, groupName, order, guidance = "") => ({
  id,
  itemText: `題目${id}`,
  optionSet: "yes-no",
  guidance,
  groupId,
  groupName,
  order,
});
const a = (questionId, optionLabel, note) => ({
  questionId,
  itemText: `題目${questionId}`,
  optionLabel,
  score: optionLabel === "是" ? 1 : 0,
  ...(note !== undefined ? { note } : {}),
});

/* ---------- 1. 分組方框：同一組別合併為一段 ---------- */
{
  const qs = [
    q("q1", "g1", "甲組", 0),
    q("q2", "g1", "甲組", 1),
    q("q3", null, "", 2),
    q("q4", "g2", "乙組", 3),
    q("q5", "g1", "甲組", 4),
  ];
  const secs = L.groupQuestionsIntoSections(qs, true);
  assert(
    "同一組別合併：3 段（甲組／未分組／乙組）",
    eq(
      secs.map((s) => s.groupId),
      ["g1", null, "g2"],
    ),
  );
  assert(
    "甲組含 q1、q2、q5（非連續也合併）",
    eq(
      secs[0].questions.map((x) => x.id),
      ["q1", "q2", "q5"],
    ),
  );
  assert(
    "未分組一段、不掛組別名稱",
    secs[1].groupId === null &&
      secs[1].groupName === "" &&
      eq(
        secs[1].questions.map((x) => x.id),
        ["q3"],
      ),
  );
  assert("乙組名稱保留", secs[2].groupName === "乙組");
}

/* ---------- 2. showGroups=false：全部一段、不分組 ---------- */
{
  const qs = [q("q1", "g1", "甲組", 0), q("q2", null, "", 1)];
  const secs = L.groupQuestionsIntoSections(qs, false);
  assert(
    "不分組：一段、5 題全在內",
    secs.length === 1 &&
      secs[0].groupId === null &&
      secs[0].groupName === "" &&
      secs[0].questions.length === 2,
  );
  assert("空題目：零段", L.groupQuestionsIntoSections([], true).length === 0);
}

/* ---------- 3. 分組名缺值 → 未命名分組 ---------- */
{
  const secs = L.groupQuestionsIntoSections(
    [q("q1", "g9", "", 0)],
    true,
  );
  assert("分組名缺值顯示未命名分組", secs[0].groupName === "未命名分組");
}

/* ---------- 4. 檢視明細：按題號排序、備註保留、指引取自題目 ---------- */
{
  const qs = [
    q("q1", "g1", "甲組", 0, "指引一"),
    q("q2", "g1", "甲組", 1),
    q("q3", null, "", 2, "指引三"),
  ];
  const ans = [
    a("q2", "否", "備註二"),
    a("q1", "是", " 備註一 "),
    a("qX", "是"),
  ];
  const secs = L.resolveReviewViewSections(qs, ans, true);
  assert(
    "檢視：2 段（甲組／未分組）",
    eq(
      secs.map((s) => s.groupId),
      ["g1", null],
    ),
  );
  assert(
    "甲組內依題號排：q1、q2",
    eq(
      secs[0].rows.map((r) => r.questionId),
      ["q1", "q2"],
    ) &&
      eq(
        secs[0].rows.map((r) => r.num),
        [1, 2],
      ),
  );
  assert("備註保留且去空白", secs[0].rows[0].note === "備註一");
  assert("備註二保留", secs[0].rows[1].note === "備註二");
  assert("指引取自當前題目", secs[0].rows[0].guidance === "指引一");
  assert(
    "無對應題目：排最後、歸未分組、題號 0、文字取快照",
    secs[1].rows.length === 1 &&
      secs[1].rows[0].questionId === "qX" &&
      secs[1].rows[0].num === 0 &&
      secs[1].rows[0].itemText === "題目qX",
  );
  assert("無備註：note 為空字串", secs[1].rows[0].note === "");
}

/* ---------- 5. 檢視：showGroups=false、空作答 ---------- */
{
  const qs = [q("q1", "g1", "甲組", 0), q("q2", null, "", 1)];
  const secs = L.resolveReviewViewSections(qs, [a("q1", "是", "x")], false);
  assert(
    "檢視不分組：一段、無組別名稱",
    secs.length === 1 && secs[0].groupId === null && secs[0].groupName === "",
  );
  assert(
    "空作答：零段",
    L.resolveReviewViewSections(qs, [], true).length === 0,
  );
}

console.log(`v1.24: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
