/**
 * v1.28 階段 3 斷言：結果分析查詢按鈕＋按年份快取（第一階段）。
 * 執行：node scripts/test-v1.28-results.mjs（專案根目錄）
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";
import { resolve } from "path";
const ROOT = resolve(import.meta.dirname, "..");
writeFileSync(
  "/tmp/t128r.ts",
  `export { clearResultsCache, getCachedYears, invalidateCachedYear, invalidateCachedYears, mergeYearDocs, resultsCacheKey, resultsScopeKey, setCachedYear } from "${ROOT}/src/lib/resultsCache";`,
);
await build({ entryPoints: ["/tmp/t128r.ts"], bundle: true, format: "cjs", platform: "node", outfile: "/tmp/t128r.cjs", logLevel: "silent" });
const L = createRequire("/tmp/t128r.cjs")("/tmp/t128r.cjs");
let f = 0;
const a = (n, c) => { if (!c) { f++; console.error("FAIL:", n); } };
const admin = { kind: "admin" };
const reviewer = { kind: "reviewer", staffId: "empNo123" };
const reviewer2 = { kind: "reviewer", staffId: "empNo999" };
const staff = { kind: "staff", unitCode: "UNIT01" };

// 快取鍵格式：{collection}:{year}:{scopeKind}:{scopeId}
a("鍵：管理員", L.resultsCacheKey("reviewRecords", 2026, admin) === "reviewRecords:2026:admin");
a("鍵：審查員含職編", L.resultsCacheKey("reviewRecords", 2026, reviewer) === "reviewRecords:2026:reviewer:empNo123");
a("鍵：一般人員含單位", L.resultsCacheKey("reviewRecords", 2026, staff) === "reviewRecords:2026:staff:UNIT01");
a("鍵：任務集合不同", L.resultsCacheKey("reviewTasks", 2026, admin) === "reviewTasks:2026:admin");
a("範圍鍵：三種範圍互不相同", new Set([L.resultsScopeKey(admin), L.resultsScopeKey(reviewer), L.resultsScopeKey(staff)]).size === 3);

// 命中／缺失：同一年、不同範圍不共用（防越權）
L.clearResultsCache();
L.setCachedYear("reviewRecords", 2026, admin, [{ id: "r1" }]);
{
  const got = L.getCachedYears("reviewRecords", [2026], admin);
  a("命中：管理員查過的年份命中", got.hits.get(2026)?.length === 1 && got.missing.length === 0);
  const other = L.getCachedYears("reviewRecords", [2026], reviewer);
  a("隔離：審查員拿不到管理員的快取", other.hits.size === 0 && other.missing.length === 1 && other.missing[0] === 2026);
  const other2 = L.getCachedYears("reviewRecords", [2026], reviewer2);
  a("隔離：不同審查員互不共用", other2.hits.size === 0);
}

// 缺的年份才查：2026 命中、2025 缺失
L.setCachedYear("reviewRecords", 2025, reviewer, [{ id: "a" }]);
{
  const got = L.getCachedYears("reviewRecords", [2025, 2026], reviewer);
  a("缺年：只列未命中的年份", got.missing.length === 1 && got.missing[0] === 2026);
  a("命中：已快取年份不重查", got.hits.has(2025) && !got.hits.has(2026));
  a("資料時間：命中年份有 fetchedAt", typeof got.fetchedAt === "number" && got.fetchedAt > 0);
}

// 合併：年份由小到大，命中＋新查併回
{
  const merged = L.mergeYearDocs(new Map([[2025, [{ id: "a" }]]]), new Map([[2026, [{ id: "b" }, { id: "c" }]]]));
  a("合併：年份升序、筆數相加", merged.length === 3 && merged[0].id === "a" && merged[2].id === "c");
}

// 失效：只失效指定年份＋指定範圍，其他年份／範圍不受影響
{
  L.invalidateCachedYear("reviewRecords", 2025, reviewer);
  const got = L.getCachedYears("reviewRecords", [2025, 2026], reviewer);
  a("失效：指定年份失效", got.missing.includes(2025));
  const adm = L.getCachedYears("reviewRecords", [2026], admin);
  a("失效：其他範圍不受影響", adm.hits.get(2026)?.length === 1);
  L.invalidateCachedYears("reviewRecords", [2026], admin);
  a("失效：批次失效", L.getCachedYears("reviewRecords", [2026], admin).missing.length === 1);
  // 任務快取獨立於紀錄快取
  L.setCachedYear("reviewTasks", 2026, reviewer, [{ id: "t1" }]);
  L.invalidateCachedYear("reviewRecords", 2026, reviewer);
  a("隔離：紀錄失效不動任務快取", L.getCachedYears("reviewTasks", [2026], reviewer).hits.get(2026)?.length === 1);
}

console.log(f ? `failed ${f}` : "v1.28-results：15 項通過");
process.exit(f ? 1 : 0);
