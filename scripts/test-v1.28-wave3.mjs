/**
 * v1.28 階段 7 斷言：第三波——B7 複合索引＋伺服器端過濾；A3 結果分析矩陣索引化；
 * B3 Firestore 持久快取＋cache-first 讀法。
 * 執行：node scripts/test-v1.28-wave3.mjs（專案根目錄）
 *
 * 刻意收斂處（皆為正確性／風險考量，見程式註解與回報）：
 * - B7 限縮查詢只在「指標分析頁籤」與「單位分析選特定指標」時啟用；
 *   組別分析（整組指標）與選「全部」時維持按年查詢。
 * - B7 不動 firebase.ts 的 readReviewRecords：v1.14 測試 guard 要求該移植函式
 *   維持單一 where，且該函式目前無呼叫端。
 * - B3 cache-first 只走 refCache 漏斗的參考資料；reviewRecords／reviewTasks
 *   保持伺服器優先，不擴大範圍。
 */
import { build } from "esbuild";
import { createRequire } from "module";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
const ROOT = resolve(import.meta.dirname, "..");
writeFileSync(
  "/tmp/t128w3.ts",
  `export { buildRecordIndex, recordsForIndex } from "${ROOT}/src/lib/resultsMatrix";
export { passRateOf, unitPassRate, optionDetailRows, personOptionRows, recordsInMonths, unitsForDrill } from "${ROOT}/src/lib/analysisRates";
export { fetchYearDocs, isIndexMissingError } from "${ROOT}/src/lib/indexedRecords";
export { getCachedYears, setCachedYear, invalidateCachedYear, invalidateCachedYears, clearResultsCache, resultsCacheKey } from "${ROOT}/src/lib/resultsCache";
export { getDocsCacheFirst, getDocCacheFirst, setCacheFirstApi, resetCacheFirstApi, forceServerRefetch, clearServerOnly, isServerOnlyNow } from "${ROOT}/src/lib/cacheFirst";`,
);
await build({ entryPoints: ["/tmp/t128w3.ts"], bundle: true, format: "cjs", platform: "node", outfile: "/tmp/t128w3.cjs", logLevel: "silent" });
const L = createRequire("/tmp/t128w3.cjs")("/tmp/t128w3.cjs");
let f = 0;
const a = (n, c) => { if (!c) { f++; console.error("FAIL:", n); } };
const src = (p) => readFileSync(resolve(ROOT, p), "utf8");
const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);

// ================= A3：合成資料，新舊計算一致 =================
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const QUESTIONS = [
  { id: "q1", itemText: "題一", order: 1 },
  { id: "q2", itemText: "題二", order: 2 },
];
const LABELS = ["是", "否", "不適用"];
const records = [];
for (let i = 0; i < 3000; i++) {
  const ind = `IND${String(i % 30).padStart(2, "0")}`;
  records.push({
    indicatorId: ind,
    unitId: `U${String(i % 10).padStart(2, "0")}`,
    year: 2026,
    month: 1 + Math.floor(rnd() * 12),
    rate: rnd() < 0.1 ? null : Math.round(rnd() * 1000) / 10,
    answers: QUESTIONS.map((q) => ({
      questionId: q.id,
      itemText: q.itemText,
      optionLabel: LABELS[Math.floor(rnd() * 3)],
      score: 1,
      excluded: false,
    })),
    personEmpNo: `E${String(i % 50).padStart(3, "0")}`,
    personName: `人員${i % 50}`,
  });
}
const thresholds = new Map(
  Array.from({ length: 30 }, (_, i) => [`IND${String(i).padStart(2, "0")}`, 60 + (i % 5) * 5]),
);
const cols = [
  { label: "Q1", months: [1, 2, 3].map((m) => ({ year: 2026, month: m })) },
  { label: "Q2", months: [4, 5, 6].map((m) => ({ year: 2026, month: m })) },
  { label: "Q3", months: [7, 8, 9].map((m) => ({ year: 2026, month: m })) },
  { label: "Q4", months: [10, 11, 12].map((m) => ({ year: 2026, month: m })) },
  { label: "上半年", months: [1, 2, 3, 4, 5, 6].map((m) => ({ year: 2026, month: m })) },
  { label: "1月", months: [{ year: 2026, month: 1 }] },
  { label: "跨年", months: [{ year: 2025, month: 12 }, { year: 2026, month: 1 }, { year: 2026, month: 2 }] },
];
const index = L.buildRecordIndex(records);
{
  let total = 0;
  for (const byMonth of index.values()) for (const bucket of byMonth.values()) total += bucket.length;
  a("A3：索引桶內總數＝3000", total === 3000);
  a("A3：索引指標數＝30", index.size === 30);
  a("A3：未知指標查表為空", L.recordsForIndex(index, "IND99", cols[0].months).length === 0);
  // months 重複不重複計（與 recordsInMonths 的 Set 語義一致）
  const dup = L.recordsForIndex(index, "IND00", [{ year: 2026, month: 1 }, { year: 2026, month: 1 }]);
  const once = L.recordsForIndex(index, "IND00", [{ year: 2026, month: 1 }]);
  a("A3：months 重複不重複計", dup.length === once.length);
}
function oldCell(indicatorId, colMonths, unitId, mode) {
  let r = records.filter((x) => x.indicatorId === indicatorId);
  if (unitId) r = r.filter((x) => x.unitId === unitId);
  r = L.recordsInMonths(r, colMonths);
  return mode === "unit"
    ? L.unitPassRate(r, thresholds.get(indicatorId))
    : L.passRateOf(r, thresholds.get(indicatorId));
}
let cellsChecked = 0;
let cellsMismatch = 0;
for (const ind of thresholds.keys()) {
  for (const col of cols) {
    for (const mode of ["person", "unit"]) {
      for (const unitId of [undefined, "U00", "U07"]) {
        const oldV = oldCell(ind, col.months, unitId, mode);
        const newRecs = L.recordsForIndex(index, ind, col.months, unitId);
        const newV = mode === "unit"
          ? L.unitPassRate(newRecs, thresholds.get(ind))
          : L.passRateOf(newRecs, thresholds.get(ind));
        cellsChecked++;
        if (!eq(oldV, newV)) cellsMismatch++;
      }
    }
  }
}
a(`A3：矩陣格新舊一致（${cellsChecked} 格，人次／單位×全部指標×7 欄×3 單元）`, cellsMismatch === 0);
// 曲線圖逐欄重算：與矩陣格同一聚合，抽一支指標全部欄位比對
{
  const ind = "IND07";
  const oldSeries = cols.map((c) => oldCell(ind, c.months, undefined, "person"));
  const newSeries = cols.map((c) =>
    L.passRateOf(L.recordsForIndex(index, ind, c.months), thresholds.get(ind)),
  );
  a("A3：曲線數列新舊一致", eq(oldSeries, newSeries));
}
// 文件明細／指標選項明細：同一批紀錄的 optionDetailRows 一致
for (const ind of ["IND00", "IND13", "IND29"]) {
  const allMonths = cols.flatMap((c) => c.months);
  const oldRecs = L.recordsInMonths(records.filter((x) => x.indicatorId === ind), allMonths);
  const newRecs = L.recordsForIndex(index, ind, allMonths);
  a(`A3：選項明細新舊一致（${ind}）`, eq(L.optionDetailRows(oldRecs, QUESTIONS), L.optionDetailRows(newRecs, QUESTIONS)));
}
// 下探 L1／L2：單位清單＋人員列新舊一致
{
  const ind = "IND05";
  const colMonths = cols[1].months;
  const oldRecs = L.recordsInMonths(records.filter((x) => x.indicatorId === ind), colMonths);
  const newRecs = L.recordsForIndex(index, ind, colMonths);
  a("A3：下探 L1 單位清單一致", eq(L.unitsForDrill(oldRecs, colMonths), L.unitsForDrill(newRecs, colMonths)));
  const oldL2 = L.personOptionRows(L.recordsInMonths(records.filter((x) => x.indicatorId === ind && x.unitId === "U03"), colMonths), thresholds.get(ind));
  const newL2 = L.personOptionRows(L.recordsForIndex(index, ind, colMonths, "U03"), thresholds.get(ind));
  a("A3：下探 L2 人員列一致", eq(oldL2, newL2));
}

// ================= B7：索引查詢＋退化 =================
a("B7：isIndexMissingError 認得 failed-precondition", L.isIndexMissingError({ code: "failed-precondition" }) === true);
a("B7：isIndexMissingError 認得訊息版", L.isIndexMissingError(new Error("FAILED_PRECONDITION: The query requires an index")) === true);
a("B7：isIndexMissingError 不誤判其他錯誤", L.isIndexMissingError({ code: "permission-denied" }) === false && L.isIndexMissingError(new Error("boom")) === false);
function fakeApi(behavior) {
  const calls = [];
  return {
    calls,
    query: (ref, ...constraints) => ({ ref, constraints }),
    where: (field, op, value) => ({ field, op, value }),
    getDocs: async (q) => {
      calls.push(q);
      return behavior(q, calls.length);
    },
  };
}
const docOf = (indicatorId, year, month) => ({ id: `${indicatorId}-${year}-${month}`, data: () => ({ indicatorId, year, month }) });
{
  // (a) 窄查詢成功：兩個等號條件皆下推，不退化
  const api = fakeApi(async () => ({ docs: [docOf("IND01", 2026, 3)] }));
  const r = await L.fetchYearDocs(api, "reviewRecords", { indicatorId: "IND01", year: 2026 });
  a("B7：窄查詢成功不退化", r.fellBack === false && r.usedIndicatorFilter === true && r.docs.length === 1);
  a("B7：窄查詢下推兩個等號條件", api.calls.length === 1 && api.calls[0].constraints.length === 2 &&
    api.calls[0].constraints.some((c) => c.field === "indicatorId" && c.value === "IND01") &&
    api.calls[0].constraints.some((c) => c.field === "year" && c.value === 2026));
}
{
  // (b) 索引未就緒：退回按年查詢＋前端過濾，結果一致
  const all = [docOf("IND01", 2026, 1), docOf("IND02", 2026, 1), docOf("IND01", 2026, 2)];
  const api = fakeApi(async (q, n) => {
    if (n === 1) throw Object.assign(new Error("FAILED_PRECONDITION: The query requires an index"), { code: "failed-precondition" });
    return { docs: all };
  });
  const r = await L.fetchYearDocs(api, "reviewRecords", { indicatorId: "IND01", year: 2026 });
  a("B7：索引未就緒退化且結果一致", r.fellBack === true && r.docs.length === 2 && r.docs.every((d) => d.data().indicatorId === "IND01"));
  a("B7：退化第二次為單一按年查詢", api.calls.length === 2 && api.calls[1].constraints.length === 1 && api.calls[1].constraints[0].field === "year");
}
{
  // (c) 非索引錯誤不退化、直接重拋
  const api = fakeApi(async () => { throw Object.assign(new Error("denied"), { code: "permission-denied" }); });
  let threw = null;
  try { await L.fetchYearDocs(api, "reviewRecords", { indicatorId: "IND01", year: 2026 }); } catch (e) { threw = e; }
  a("B7：權限錯誤不退化、直接重拋", threw != null && threw.code === "permission-denied" && api.calls.length === 1);
}
{
  // (d) 無指標條件：維持舊的單一按年查詢
  const api = fakeApi(async () => ({ docs: [docOf("IND01", 2026, 1), docOf("IND02", 2026, 1)] }));
  const r = await L.fetchYearDocs(api, "reviewRecords", { year: 2026 });
  a("B7：無指標條件維持按年查詢", r.fellBack === false && r.usedIndicatorFilter === false && r.docs.length === 2 &&
    api.calls.length === 1 && api.calls[0].constraints.length === 1);
}
// B7：快取鍵指標限縮與全量分開；失效清掉同年同範圍的兩種鍵，不誤刪他人
{
  L.clearResultsCache();
  const admin = { kind: "admin" };
  const rev1 = { kind: "reviewer", staffId: "emp1" };
  const rev12 = { kind: "reviewer", staffId: "emp12" };
  L.setCachedYear("reviewRecords", 2026, admin, [{ id: "broad" }]);
  L.setCachedYear("reviewRecords", 2026, admin, [{ id: "narrow" }], "IND01");
  L.setCachedYear("reviewRecords", 2026, rev1, [{ id: "r1" }]);
  L.setCachedYear("reviewRecords", 2026, rev12, [{ id: "r12" }]);
  a("B7：指標鍵與全量鍵分開存放", L.resultsCacheKey("reviewRecords", 2026, admin, "IND01") !== L.resultsCacheKey("reviewRecords", 2026, admin));
  const hitNarrow = L.getCachedYears("reviewRecords", [2026], admin, "IND01");
  const hitBroad = L.getCachedYears("reviewRecords", [2026], admin);
  a("B7：窄／全量快取互不污染", hitNarrow.hits.get(2026)[0].id === "narrow" && hitBroad.hits.get(2026)[0].id === "broad");
  L.invalidateCachedYear("reviewRecords", 2026, rev1);
  a("B7：失效不誤刪其他範圍（emp12 仍在）", L.getCachedYears("reviewRecords", [2026], rev12).hits.has(2026));
  a("B7：失效清掉該範圍（emp1 已清）", L.getCachedYears("reviewRecords", [2026], rev1).missing.includes(2026));
  L.invalidateCachedYear("reviewRecords", 2026, admin);
  a("B7：失效同時清掉同年同範圍的窄鍵與全量鍵",
    L.getCachedYears("reviewRecords", [2026], admin).missing.includes(2026) &&
    L.getCachedYears("reviewRecords", [2026], admin, "IND01").missing.includes(2026));
}
// B7：索引檔與原始碼層面
{
  const idx = JSON.parse(readFileSync(resolve(ROOT, "firestore.indexes.json"), "utf8"));
  const hasIdx = (coll) => idx.indexes.some((i) =>
    i.collectionGroup === coll &&
    JSON.stringify(i.fields.map((f) => [f.fieldPath, f.order])) ===
      JSON.stringify([["indicatorId", "ASCENDING"], ["year", "ASCENDING"]]));
  a("B7：索引檔有 reviewRecords (indicatorId, year)", hasIdx("reviewRecords"));
  a("B7：索引檔有 reviewTasks (indicatorId, year)", hasIdx("reviewTasks"));
  a("B7：索引檔保留既有 (status, deadline)", idx.indexes.some((i) =>
    i.collectionGroup === "reviewTasks" &&
    i.fields.some((f) => f.fieldPath === "status") && i.fields.some((f) => f.fieldPath === "deadline")));
  const rp = src("src/features/ResultsPage.tsx");
  a("B7：ResultsPage 用指標限縮查詢", rp.includes("fetchYearDocs") && rp.includes("singleIndicatorId"));
  a("B7：ResultsPage 退化時有畫面提示", rp.includes("indexFallback") && rp.includes("複合索引"));
  a("B7：readReviewRecords 維持單一 where（v1.14 guard）", !src("src/lib/firebase.ts").includes('where("year", "==", year)'));
}

// ================= B3：cache-first 讀法 =================
function fakeCacheApi({ demo = false, cacheDocs = null, cacheExists = true, cacheThrows = false } = {}) {
  const calls = { fromCache: 0, fromServer: 0, fallback: 0, fallbackDoc: 0 };
  const docs = cacheDocs ?? [{ id: "a" }, { id: "b" }];
  return {
    calls,
    api: {
      isDemoMode: () => demo,
      getDocs: async () => { calls.fallback++; return { docs, empty: docs.length === 0, source: "fallback" }; },
      getDoc: async () => { calls.fallbackDoc++; return { exists: () => true, source: "fallbackDoc" }; },
      getDocsFromCache: async () => {
        calls.fromCache++;
        if (cacheThrows) throw new Error("cache unavailable");
        return { docs, empty: docs.length === 0, source: "cache" };
      },
      getDocsFromServer: async () => { calls.fromServer++; return { docs, empty: docs.length === 0, source: "server" }; },
      getDocFromCache: async () => {
        calls.fromCache++;
        if (cacheThrows) throw new Error("cache unavailable");
        return { exists: () => cacheExists, source: "cache" };
      },
      getDocFromServer: async () => { calls.fromServer++; return { exists: () => true, source: "server" }; },
    },
  };
}
{
  // (a) 快取命中：不問伺服器
  const { calls, api } = fakeCacheApi({ cacheDocs: [{ id: "a" }] });
  L.setCacheFirstApi(api);
  const snap = await L.getDocsCacheFirst("q");
  a("B3：快取命中不計費（不問伺服器）", snap.source === "cache" && calls.fromCache === 1 && calls.fromServer === 0);
  L.resetCacheFirstApi(); L.clearServerOnly();
}
{
  // (b) 快取未命中（空）：回伺服器
  const { calls, api } = fakeCacheApi({ cacheDocs: [] });
  L.setCacheFirstApi(api);
  const snap = await L.getDocsCacheFirst("q");
  a("B3：快取未命中回伺服器", snap.source === "server" && calls.fromCache === 1 && calls.fromServer === 1);
  L.resetCacheFirstApi(); L.clearServerOnly();
}
{
  // (c) 快取不可用：退回預設讀取，不拋錯
  const { calls, api } = fakeCacheApi({ cacheThrows: true });
  L.setCacheFirstApi(api);
  const snap = await L.getDocsCacheFirst("q");
  a("B3：快取拋錯退回預設讀取", snap.source === "fallback" && calls.fallback === 1 && calls.fromServer === 0);
  L.resetCacheFirstApi(); L.clearServerOnly();
}
{
  // (d) 強制走伺服器窗口：不讀快取；清除後恢復快取優先
  const { calls, api } = fakeCacheApi({ cacheDocs: [{ id: "a" }] });
  L.setCacheFirstApi(api);
  L.forceServerRefetch(30);
  const snap = await L.getDocsCacheFirst("q");
  a("B3：重新整理窗口內強制走伺服器", snap.source === "server" && calls.fromCache === 0 && calls.fromServer === 1);
  L.clearServerOnly();
  const snap2 = await L.getDocsCacheFirst("q");
  a("B3：清除窗口後恢復快取優先", snap2.source === "cache" && calls.fromCache === 1);
  L.resetCacheFirstApi(); L.clearServerOnly();
}
{
  // (e) demo 模式：絕不碰 SDK
  const { calls, api } = fakeCacheApi({ demo: true, cacheDocs: [{ id: "a" }] });
  L.setCacheFirstApi(api);
  const snap = await L.getDocsCacheFirst("q");
  const doc = await L.getDocCacheFirst("ref");
  a("B3：demo 模式不碰 SDK（只走記憶體實作）", snap.source === "fallback" && doc.source === "fallbackDoc" && calls.fromCache === 0 && calls.fromServer === 0);
  L.resetCacheFirstApi(); L.clearServerOnly();
}
{
  // (f) 單一文件：命中／未命中／拋錯
  const hit = fakeCacheApi({ cacheExists: true });
  L.setCacheFirstApi(hit.api);
  const d1 = await L.getDocCacheFirst("ref");
  a("B3：單一文件快取命中", d1.source === "cache" && hit.calls.fromServer === 0);
  const miss = fakeCacheApi({ cacheExists: false });
  L.setCacheFirstApi(miss.api);
  const d2 = await L.getDocCacheFirst("ref");
  a("B3：單一文件快取未命中回伺服器", d2.source === "server" && miss.calls.fromServer === 1);
  const bad = fakeCacheApi({ cacheThrows: true });
  L.setCacheFirstApi(bad.api);
  const d3 = await L.getDocCacheFirst("ref");
  a("B3：單一文件快取拋錯退回預設讀取", d3.source === "fallbackDoc" && bad.calls.fallbackDoc === 1);
  L.resetCacheFirstApi(); L.clearServerOnly();
}
// B3：原始碼層面
{
  const fb = src("src/lib/firebase.ts");
  a("B3：initializeFirestore 啟用持久快取", fb.includes("persistentLocalCache") && fb.includes("initializeFirestore"));
  a("B3：多分頁共用（persistentMultipleTabManager）", fb.includes("persistentMultipleTabManager"));
  a("B3：初始化失敗退回預設 getFirestore", fb.includes("getFirestore(app)") && fb.includes("firestoreCacheStatus"));
  const cf = src("src/lib/cacheFirst.ts");
  a("B3：demo 模式先於 SDK 判斷", cf.includes("if (api.isDemoMode()) return api.getDocs(q)"));
  const resultsPage = src("src/features/ResultsPage.tsx");
  a(
    "B3：按查詢使所選年月 reviewRecords／reviewTasks 快取失效後重載",
    resultsPage.includes('invalidateCachedYears("reviewRecords", queryYears, cacheScope)') &&
      resultsPage.includes('invalidateCachedYears("reviewTasks", queryYears, cacheScope)'),
  );
  const allSrc = ["src/app/App.tsx", "src/features/AdminPage.tsx", "src/features/DashboardPage.tsx", "src/features/GroupsPage.tsx", "src/features/IndicatorsPage.tsx", "src/features/ResultsPage.tsx", "src/features/AuditPage.tsx", "src/features/SchedulePage.tsx", "src/features/ReviewOverviewPage.tsx", "src/features/ReviewExecutePage.tsx", "src/features/dashboard/useDashboardData.ts", "src/lib/firebase.ts", "src/lib/usePermissions.ts"]
    .map((p) => src(p)).join("\n");
  a("B3：參考資料走 cache-first（13 處漏斗皆已遷移）", (allSrc.match(/getDocsCacheFirst\(/g) || []).length >= 20 && (allSrc.match(/getDocCacheFirst\(/g) || []).length >= 5);
  a("B3：任務／紀錄查詢未走 cache-first（保持伺服器優先）",
    !allSrc.includes('getDocsCacheFirst(collection(db, "reviewRecords")') &&
    !allSrc.includes('getDocsCacheFirst(collection(db, "reviewTasks")'));
}

if (f > 0) { console.error(`test-v1.28-wave3: ${f} 項失敗`); process.exit(1); }
console.log("test-v1.28-wave3: 全部通過");
