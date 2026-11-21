/**
 * v1.88.45 斷言：結果分析區間制——曲線圖一點一區間（點在第一個月）、
 * 矩陣維持一張表、表頭一個月一欄、每列依自己的排程區間 colspan 合併。
 * 執行：node scripts/test-v1.88.45-interval-matrix.mjs（專案根目錄）
 * 用戶定案（2026-11-21）：區間＞1 個月時呈現區間改成審查區間，區間內合併
 * 計算；起點以排程起始月往後切；多指標各依自己的設定；卡片不動。
 * 用戶示意圖（2026-11-21）：矩陣不拆表，維持一張表、月欄表頭；
 * 區間結果為合併格、內容置於合併格中間；曲線一個區間一個點、點在第一個月。
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";
import { resolve } from "path";
const ROOT = resolve(import.meta.dirname, "..");
writeFileSync(
  "/tmp/t18845.ts",
  `export { buildRowSpans, firstMonthLabel, scheduleIntervalsInRange } from "${ROOT}/src/lib/analysisSpans";
   export { buildReviewIntervals } from "${ROOT}/src/lib/scheduleIntervals";`,
);
await build({ entryPoints: ["/tmp/t18845.ts"], bundle: true, format: "cjs", platform: "node", outfile: "/tmp/t18845.cjs", logLevel: "silent", define: { "import.meta.env": JSON.stringify({ VITE_FIREBASE_API_KEY: "x", VITE_FIREBASE_AUTH_DOMAIN: "x", VITE_FIREBASE_PROJECT_ID: "demo-project", VITE_FIREBASE_APP_ID: "1:1:web:1", VITE_DB_MODE: "firebase" }) } });
const L = createRequire("/tmp/t18845.cjs")("/tmp/t18845.cjs");
let f = 0;
const a = (n, c) => { if (!c) { f++; console.error("FAIL:", n); } };
const months = (y0, m0, n) => Array.from({ length: n }, (_, i) => {
  const t = (y0 * 12 + (m0 - 1) + i);
  return { year: Math.floor(t / 12), month: (t % 12) + 1 };
});

// 使用者範例：每年 4 次、一次 3 個月，從 9 月開始
const iv26 = L.buildReviewIntervals({ category: "year", period: "2026", months: [9, 12], frequency: 4, intervalMonths: 3 });
a("範例：2026 排程切出 9-11、12-2 兩區間", iv26.length === 2);
a("範例：第一區間 2026/9-2026/11", iv26[0]?.label === "2026/9-2026/11" && iv26[0]?.months.length === 3);
a("範例：第二區間跨年 2026/12-2027/2", iv26[1]?.label === "2026/12-2027/2" && iv26[1]?.months.length === 3 && iv26[1]?.months[2].year === 2027 && iv26[1]?.months[2].month === 2);
const iv27 = L.buildReviewIntervals({ category: "year", period: "2027", months: [3, 6], frequency: 4, intervalMonths: 3 });
a("範例：2027 排程切出 3-5、6-8 兩區間", iv27.length === 2 && iv27[0]?.label === "2027/3-2027/5" && iv27[1]?.label === "2027/6-2027/8");

// 區間裁切到查詢範圍：範圍從 10 月起，9-11 區間只留 10、11 月
const range = months(2026, 9, 6); // 2026-09 ~ 2027-02
const clipped = L.scheduleIntervalsInRange(
  { category: "year", period: "2026", months: [9, 12], frequency: 4, intervalMonths: 3 },
  months(2026, 10, 5),
);
a("裁切：範圍內只留 10-11、12-2", clipped.length === 2 && clipped[0].months.length === 2 && clipped[1].months.length === 3);

// 列 spans：3 個月區間合併成一格，1 個月維持單月格
const spans3 = L.buildRowSpans(range, [...iv26], new Set());
a("spans：3 個月區間合併為 2 格", spans3.length === 2 && spans3.every((s) => s.kind === "interval"));
a("spans：標籤為區間起訖", spans3[0].label === "2026/9–2026/11" && spans3[1].label === "2026/12–2027/2");
const iv1 = L.buildReviewIntervals({ category: "year", period: "2026", months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], frequency: 4, intervalMonths: 1 });
const spans1 = L.buildRowSpans(range, iv1, new Set());
a("spans：1 個月區間維持 6 個單月格", spans1.length === 6 && spans1.every((s) => s.kind === "single"));

// 單表：切法不同的列共用同一組月欄，各列 spans 恰好覆蓋全部月份一次
// （colspan 總和＝月欄總數，欄位對齊；不拆表）。
const spanMonths = (spans) => spans.flatMap((s) => s.months.map((m) => `${m.year}-${m.month}`));
a("單表：3 個月列 spans 覆蓋 6 個月恰一次", spanMonths(spans3).join(",") === spanMonths(spans1).join(","));
a("單表：3 個月列 colspan 總和＝6", spans3.reduce((n, s) => n + s.months.length, 0) === 6);
a("單表：1 個月列 colspan 總和＝6", spans1.reduce((n, s) => n + s.months.length, 0) === 6);

// colspan：合併格橫跨區間月數（3 個月格＝3，單月格＝1）
a("colspan：3 個月合併格為 3", spans3[0].months.length === 3);
a("colspan：單月格為 1", spans1[0].months.length === 1);

// 曲線圖：一個區間一個點，點以區間第一個月為主
a("曲線：9-11 月區間的點在 9 月", L.firstMonthLabel(spans3[0]) === "2026/9");
a("曲線：跨年 12-2 月區間的點在 12 月", L.firstMonthLabel(spans3[1]) === "2026/12");
a("曲線：單月格的點在該月", L.firstMonthLabel(spans1[0]) === "2026/9" && L.firstMonthLabel(spans1[5]) === "2027/2");

if (f > 0) { console.error(`共 ${f} 項失敗`); process.exit(1); }
console.log("v1.88.45 區間矩陣（單表＋曲線第一個月）：全部通過");
