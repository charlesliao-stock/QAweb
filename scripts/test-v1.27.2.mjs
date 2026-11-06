/**
 * v1.27.2 斷言：correctTaskStatus 冪等（已鎖定未完成維持 locked）。
 * 執行：node scripts/test-v1.27.2.mjs（專案根目錄）
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";
import { resolve } from "path";
const ROOT = resolve(import.meta.dirname, "..");
writeFileSync("/tmp/t1272.ts", `export { correctTaskStatus } from "${ROOT}/src/lib/reviewProgress";`);
await build({ entryPoints: ["/tmp/t1272.ts"], bundle: true, format: "cjs", platform: "node", outfile: "/tmp/t1272.cjs", logLevel: "silent" });
const L = createRequire("/tmp/t1272.cjs")("/tmp/t1272.cjs");
let f = 0;
const a = (n, c) => { if (!c) { f++; console.error("FAIL:", n); } };
a("已鎖定+未完成+逾期 → 維持 locked", L.correctTaskStatus(2, 5, "2026-10-10", "locked", "2026-11-04") === "locked");
a("冪等：連續兩次結果相同", (() => { const x = L.correctTaskStatus(2, 5, "2026-10-10", "pending", "2026-11-04"); return L.correctTaskStatus(2, 5, "2026-10-10", x, "2026-11-04") === x; })());
a("已完成的 locked → done", L.correctTaskStatus(5, 5, "2026-10-10", "locked", "2026-11-04") === "done");
a("未逾期 pending 維持 pending", L.correctTaskStatus(2, 5, "2026-11-10", "pending", "2026-11-04") === "pending");
console.log(f ? `failed ${f}` : "v1.27.2：4 項通過");
process.exit(f ? 1 : 0);
