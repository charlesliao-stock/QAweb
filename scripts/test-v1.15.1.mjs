/**
 * v1.15.1 斷言測試：指標清單搜尋過濾、排序切換、閾值顯示與 fallback。
 * 用 esbuild 將純函式打包後在 node 執行（不走 jsdom）。
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";

const ROOT = "/home/hatch/workspace/repos/QAweb";
const entry = `
import { displayThreshold, indicatorDisplayThreshold, filterIndicators, compareIndicatorRows } from "${ROOT}/src/lib/indicators";
export { displayThreshold, indicatorDisplayThreshold, filterIndicators, compareIndicatorRows };
`;
writeFileSync("/tmp/v1151-test-entry.ts", entry);
await build({
  entryPoints: ["/tmp/v1151-test-entry.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/v1151-test-bundle.cjs",
  logLevel: "silent",
});
const require2 = createRequire("/tmp/v1151-test-bundle.cjs");
const L = require2("/tmp/v1151-test-bundle.cjs");

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

const R = (code, name, groupId, mainThreshold, basicThreshold, status = "啟用", version = "v1.0") => ({
  code, name, groupId, mainThreshold, basicThreshold, status, version,
});
const gname = (id) => ({ g1: "內科組", g2: "外科組" }[id] || "");

// ── 1. 閾值顯示與 fallback ──
assert("基本資料閾值優先", L.displayThreshold(90, 80) === 90);
assert("null fallback 主閾值", L.displayThreshold(null, 80) === 80);
assert("undefined fallback 主閾值", L.displayThreshold(undefined, 80) === 80);
assert("0 為有效值不 fallback", L.displayThreshold(0, 80) === 0);
assert("indicatorDisplayThreshold 取列值", L.indicatorDisplayThreshold(R("A", "n", "g1", 80, 95)) === 95);
assert("indicatorDisplayThreshold fallback", L.indicatorDisplayThreshold(R("A", "n", "g1", 80, null)) === 80);

// ── 2. 搜尋過濾（編號＋名稱） ──
{
  const rows = [
    R("QI-001", "手部衛生遵從率", "g1", 90, null),
    R("QI-002", "給藥作業正確率", "g2", 95, null),
    R("FALL-01", "跌倒發生率", "g1", 5, null),
  ];
  assert("編號搜尋", L.filterIndicators(rows, "QI-00").length === 2);
  assert("名稱搜尋", L.filterIndicators(rows, "給藥").length === 1);
  assert("大小寫不敏感", L.filterIndicators(rows, "qi-001").length === 1);
  assert("空白關鍵字回全部", L.filterIndicators(rows, "   ").length === 3);
  assert("無符合回空陣列", L.filterIndicators(rows, "不存在").length === 0);
  assert("不搜尋其他欄位（組別名）", L.filterIndicators(rows, "內科").length === 0);
}

// ── 3. 排序切換 ──
{
  const rows = [
    R("QI-002", "給藥作業正確率", "g2", 95, null, "啟用", "v1.0"),
    R("QI-001", "手部衛生遵從率", "g1", 90, 88, "草稿", "v2.0"),
    R("FALL-01", "跌倒發生率", "g1", 5, null, "啟用", "v1.0"),
  ];
  const sort = (key, dir) =>
    [...rows].sort((a, b) => L.compareIndicatorRows(a, b, key, dir, gname)).map((r) => r.code);

  assert("編號升冪", JSON.stringify(sort("code", 1)) === '["FALL-01","QI-001","QI-002"]');
  assert("編號降冪", JSON.stringify(sort("code", -1)) === '["QI-002","QI-001","FALL-01"]');
  assert("閾值升冪（含 fallback：88/95/5）", JSON.stringify(sort("threshold", 1)) === '["FALL-01","QI-001","QI-002"]');
  assert("閾值降冪", JSON.stringify(sort("threshold", -1)) === '["QI-002","QI-001","FALL-01"]');
  assert("組別升冪（內科組＜外科組，組內保序）", JSON.stringify(sort("group", 1)) === '["QI-001","FALL-01","QI-002"]');
  const stDesc = sort("status", -1);
  assert("狀態降冪：草稿排在最後", stDesc[2] === "QI-001");
  // v1.17：版本欄自清單移除，不再支援版本排序
  assert("名稱排序不炸", sort("name", 1).length === 3);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
