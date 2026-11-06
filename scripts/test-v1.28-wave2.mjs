/**
 * v1.28 階段 6 斷言：第二波——A1 路由懶載入＋manualChunks；B5＋B6 查詢合併；
 * B8 狀態校正寫入節流。
 * 執行：node scripts/test-v1.28-wave2.mjs（專案根目錄，需先跑過 vite build）
 *
 * 兩處刻意偏離任務書字面建議處（皆為正確性修正，見程式註解）：
 * - B6 年份不用 where("year", "==", 當年)：學年度區間橫跨兩曆年，當年等號會漏掉
 *   去年月份紀錄、進度算少；改用 where("year", ">=", 去年)，前端仍以區間月份過濾。
 * - B5 不加年份 where：排程頁可切換檢視年份（filterYear）且臨時排程可屬任何年份；
 *   單次全量查詢與改前讀取文件數相同。
 */
import { build } from "esbuild";
import { createRequire } from "module";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { resolve } from "path";
const ROOT = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
let f = 0;
const a = (n, c) => {
  if (!c) {
    f++;
    console.error("FAIL:", n);
  }
};
const src = (p) => readFileSync(resolve(ROOT, p), "utf8");
const sizeOf = (p) => statSync(resolve(ROOT, p)).size;

// ---------- A1：原始碼層面 ----------
const app = src("src/app/App.tsx");
const LAZY_PAGES = [
  "AdminPage",
  "AuditPage",
  "CapaPage",
  "GroupsPage",
  "IndicatorsPage",
  "ResultsPage",
  "SchedulePage",
];
a(
  "A1：7 頁皆為 React.lazy",
  LAZY_PAGES.every((p) => new RegExp(`const ${p} = lazy\\(`).test(app)),
);
a(
  "A1：無靜態 import 7 頁",
  !/import \{ (AdminPage|AuditPage|CapaPage|GroupsPage|IndicatorsPage|ResultsPage|SchedulePage) \} from/.test(
    app,
  ),
);
a(
  "A1：儀表板仍靜態 import（登入後首頁）",
  /import \{ DashboardPage \} from/.test(app),
);
a(
  "A1：切頁有 Suspense fallback 載入中（不空白卡住）",
  app.includes("Suspense") && app.includes("頁面載入中"),
);
const vc = src("vite.config.ts");
a(
  "A1：manualChunks 拆 firebase（含 @firebase 子包）",
  vc.includes("node_modules/firebase/") && vc.includes("node_modules/@firebase/"),
);
a("A1：manualChunks 拆 lucide-react", vc.includes("node_modules/lucide-react/"));
a(
  "A1：manualChunks 不碰 xlsx（階段 5 動態 import 自成 chunk）",
  !/xlsx/.test(vc.replace(/\/\/.*$/gm, "")),
);

// ---------- A1：產物層面 ----------
const assets = readdirSync(resolve(ROOT, "dist/assets"));
const jsOf = (re) => assets.find((n) => re.test(n));
const entryJs = jsOf(/^index-.*\.js$/);
const fvJs = jsOf(/^firebase-vendor-.*\.js$/);
const lvJs = jsOf(/^lucide-vendor-.*\.js$/);
const xlsxJs = jsOf(/^xlsx-.*\.js$/);
a("A1 產物：入口 chunk 存在", !!entryJs);
a("A1 產物：firebase-vendor chunk 存在", !!fvJs);
a("A1 產物：lucide-vendor chunk 存在", !!lvJs);
a("A1 產物：xlsx chunk 仍獨立", !!xlsxJs);
a("A1 產物：xlsx chunk hash 不變（與 manualChunks 無衝突）", xlsxJs === "xlsx-CbTSpprj.js");
const entrySize = entryJs ? sizeOf(`dist/assets/${entryJs}`) : Infinity;
const fvSize = fvJs ? sizeOf(`dist/assets/${fvJs}`) : 0;
const lvSize = lvJs ? sizeOf(`dist/assets/${lvJs}`) : 0;
a(`A1 產物：入口 JS ${entrySize} < 400,000（改前 1,068,099）`, entrySize < 400000);
a(
  `A1 產物：首屏三 chunk 合計 ${entrySize + fvSize + lvSize} < 950,000（改前 1,068,099；B3 持久快取使 firebase-vendor 膨脹，門檻由 900,000 放寬至 950,000，Charles 選項 A 批准）`,
  entrySize + fvSize + lvSize < 950000,
);
for (const p of LAZY_PAGES) {
  a(`A1 產物：${p} 獨立 chunk 存在`, !!jsOf(new RegExp(`^${p}-.*\\.js$`)));
}
a(
  "A1 產物：每個 JS chunk < 500,000（無 Vite 大 chunk 警告門檻），firebase-vendor 例外放寬至 600,000（B3 持久快取代價，Charles 選項 A 批准）",
  assets
    .filter((n) => n.endsWith(".js"))
    .every(
      (n) =>
        sizeOf(`dist/assets/${n}`) <
        (/^firebase-vendor-/.test(n) ? 600000 : 500000),
    ),
);
const entryText = entryJs ? readFileSync(resolve(ROOT, "dist/assets", entryJs), "utf8") : "";
a("A1 產物：入口不含 SheetJS（xlsx 未包進首屏）", !entryText.includes("SheetJS"));
const indexHtml = readFileSync(resolve(ROOT, "dist/index.html"), "utf8");
const htmlRefs = [...indexHtml.matchAll(/\/assets\/([^"'\s]+)/g)].map((m) => m[1]);
a(
  "A1 產物：index.html 只引用入口＋vendors＋css",
  htmlRefs.length > 0 &&
    htmlRefs.every(
      (r) =>
        r === entryJs ||
        r === fvJs ||
        r === lvJs ||
        /^index-.*\.css$/.test(r),
    ),
);
a(
  "A1 產物：index.html 不直接引用頁面 chunk（切頁才載）",
  LAZY_PAGES.every((p) => !indexHtml.includes(`${p}-`)),
);
a(
  "A1 產物：index.html 引用的檔案皆存在於 dist",
  htmlRefs.every((r) => existsSync(resolve(ROOT, "dist/assets", r))),
);

// ---------- B5：原始碼層面 ----------
const schedPage = src("src/features/SchedulePage.tsx");
a(
  "B5：任務索引單次全量查詢",
  schedPage.includes('getDocs(collection(db, "reviewTasks"))'),
);
a(
  "B5：不再每指標查 reviewTasks（N+1 已移除）",
  !/where\("indicatorId", "==", ind\.id\)/.test(schedPage),
);
a("B5：分組走 buildTaskIndex 純函式", schedPage.includes("buildTaskIndex("));
const scheduling = src("src/lib/scheduling.ts");
a(
  "B5：舊集合只在新集合為空時 fallback",
  /if \(newSnap\.empty\)/.test(scheduling),
);
a(
  "B5：不再雙集合 Promise.all 並讀",
  !/const \[newSnap, oldSnap\] = await Promise\.all/.test(scheduling),
);

// ---------- B5：功能對照（buildTaskIndex vs 改前演算法＋手算期望值） ----------
writeFileSync(
  "/tmp/t128w-ti.ts",
  `export { buildTaskIndex } from "${ROOT}/src/lib/taskIndex";`,
);
await build({
  entryPoints: ["/tmp/t128w-ti.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/t128w-ti.cjs",
  logLevel: "silent",
});
const TI = require("/tmp/t128w-ti.cjs");
// 合成任務：跨年（2025／2026／2027，含學年度 2026-08..2027-07）、
// 多指標、done／pending／locked／其他狀態、缺欄位文件
const taskDocs = [
  { indicatorId: "IND-A", year: 2026, month: 8, status: "done" },
  { indicatorId: "IND-A", year: 2026, month: 8, status: "pending" },
  { indicatorId: "IND-A", year: 2026, month: 8, status: "locked" },
  { indicatorId: "IND-A", year: 2027, month: 7, status: "done" },
  { indicatorId: "IND-A", year: 2027, month: 7, status: "done" },
  { indicatorId: "IND-A", year: 2025, month: 12, status: "pending" },
  { indicatorId: "IND-B", year: 2026, month: 1, status: "done" },
  { indicatorId: "IND-B", year: 2026, month: 1, status: "weird" },
  { indicatorId: "", year: 2026, month: 1, status: "done" },
  { indicatorId: "IND-B", month: 1, status: "done" },
  { indicatorId: "IND-B", year: 2026, status: "done" },
  { indicatorId: "IND-C", year: 2026, month: 3, status: "done" },
];
const idx = TI.buildTaskIndex(taskDocs.map((d) => ({ data: () => d })));
const get = (iid, k) => idx.get(iid)?.get(k);
a("B5 對照：IND-A 2026-8＝1 done／2 pending（含 locked 計 pending）", get("IND-A", "2026-8")?.done === 1 && get("IND-A", "2026-8")?.pending === 2);
a("B5 對照：IND-A 2027-7 跨年月份正確", get("IND-A", "2027-7")?.done === 2 && get("IND-A", "2027-7")?.pending === 0);
a("B5 對照：IND-A 2025-12 舊年任務仍在索引內（不加年份 where）", get("IND-A", "2025-12")?.pending === 1);
a("B5 對照：IND-B 未知狀態計 pending", get("IND-B", "2026-1")?.done === 1 && get("IND-B", "2026-1")?.pending === 1);
a("B5 對照：缺欄位文件不計入（IND-B 無 2026-3、空指標無索引）", !idx.get("IND-B")?.get("2026-3") && !idx.get(""));
a("B5 對照：共 3 支指標有索引", idx.size === 3);
// 改前演算法（每指標一次查詢、同一分組規則）逐筆重算，必須完全一致
function oldBuild(all, ids) {
  const out = new Map();
  for (const id of ids) {
    const m = new Map();
    for (const v of all.filter((d) => d.indicatorId === id)) {
      const y = Number(v.year ?? 0);
      const mo = Number(v.month ?? 0);
      if (!y || !mo) continue;
      const k = `${y}-${mo}`;
      const e = m.get(k) ?? { pending: 0, done: 0 };
      if (v.status === "done") e.done += 1;
      else e.pending += 1;
      m.set(k, e);
    }
    if (m.size) out.set(id, m);
  }
  return out;
}
const canon = (m) =>
  JSON.stringify(
    [...m.entries()].map(([iid, inner]) => [iid, [...inner.entries()].sort()]).sort(),
  );
a(
  "B5 對照：新單查分組與改前逐指標查詢結果完全一致",
  canon(idx) === canon(oldBuild(taskDocs, ["IND-A", "IND-B", "IND-C"])),
);

// ---------- B5：功能對照（listSchedules fallback，demo 後端實跑） ----------
writeFileSync(
  "/tmp/t128w-sched.ts",
  `(globalThis as any).sessionStorage = {
  getItem: (k: string) => (k === "nurseboard-demo-mode" ? "1" : null),
  setItem: () => {},
  removeItem: () => {},
};
export { listSchedules } from "${ROOT}/src/lib/scheduling";
export * as demo from "${ROOT}/src/lib/demoStore";`,
);
await build({
  entryPoints: ["/tmp/t128w-sched.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/t128w-sched.cjs",
  logLevel: "silent",
});
const SCH = require("/tmp/t128w-sched.cjs");
{
  const newColl = SCH.demo.collection("indicatorSchedules");
  const oldColl = SCH.demo.collection("indicatorYearSchedules");
  SCH.demo.setDoc(SCH.demo.docOf(newColl, "IND-A__year__2026"), {
    indicatorId: "IND-A",
    category: "year",
    period: "2026",
    months: [1, 2, 3],
    unitIds: [],
  });
  SCH.demo.setDoc(SCH.demo.docOf(oldColl, "IND-B__2026"), {
    indicatorId: "IND-B",
    year: 2026,
    months: [4, 5, 6],
  });
  const r1 = await SCH.listSchedules({});
  a(
    "B5 fallback：新集合非空時舊集合殘留排程不再併入",
    r1.map((s) => s.indicatorId).join() === "IND-A",
  );
  // 清空新集合 → 舊集合 fallback 生效
  SCH.demo.deleteDoc(SCH.demo.docOf(newColl, "IND-A__year__2026"));
  const r2 = await SCH.listSchedules({});
  a(
    "B5 fallback：新集合為空時舊集合排程回補",
    r2.map((s) => s.indicatorId).join() === "IND-B" &&
      r2[0].category === "year" &&
      r2[0].period === "2026",
  );
}

// ---------- B6：原始碼層面 ----------
const auditPage = src("src/features/AuditPage.tsx");
a("B6：品管審查走 fetchAllPaged 單一查詢", auditPage.includes("fetchAllPaged("));
a(
  "B6：年份下限為去年（不用當年等號，防學年度漏去年月份）",
  auditPage.includes('where("year", ">=", today.getFullYear() - 1)'),
);
a(
  "B6：AuditPage 僅剩 units 查詢用 limit(2000)，紀錄查詢已無截斷",
  (() => {
    const lines = auditPage
      .replace(/\/\/.*$/gm, "")
      .split("\n")
      .filter((l) => l.includes("limit(2000)"));
    return lines.length === 1 && lines[0].includes('"units"');
  })(),
);
a(
  "B6：截斷有可見提示（狀態＋文案）",
  auditPage.includes("recordsTruncated") &&
    auditPage.includes("審查紀錄未完整載入"),
);
const fb = src("src/lib/firebase.ts");
a(
  "B6：readReviewRecords 走 fetchAllPaged，維持單一 where（v1.14  guard：避免複合索引）",
  fb.includes("fetchAllPaged(") &&
    !fb.includes('where("year", "==", year)'),
);
a(
  "B6：readReviewRecords 未拉完拋錯（不回傳不完整統計）",
  fb.includes("審查紀錄未完整載入（分頁中斷）"),
);
a(
  "B6：readReviewRecords 的 reviewRecords 查詢不再 limit(2000)",
  !/limit\(2000\)/.test(
    fb
      .split("readReviewRecords")[1]
      .split("let allowedUnitIds")[0]
      .replace(/\/\/.*$/gm, ""),
  ),
);

// ---------- B6：功能對照（fetchAllPaged，demo 後端實跑 2,500 筆） ----------
writeFileSync(
  "/tmp/t128w-paged.ts",
  `export { fetchAllPaged, PAGED_QUERY_PAGE_SIZE, PAGED_QUERY_MAX_PAGES } from "${ROOT}/src/lib/pagedQuery";
export * as demo from "${ROOT}/src/lib/demoStore";`,
);
await build({
  entryPoints: ["/tmp/t128w-paged.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/t128w-paged.cjs",
  logLevel: "silent",
});
const PG = require("/tmp/t128w-paged.cjs");
const demoApi = {
  query: PG.demo.query,
  orderBy: PG.demo.orderBy,
  limit: PG.demo.limit,
  startAfter: PG.demo.startAfter,
  getDocs: (q) => Promise.resolve(PG.demo.getDocs(q)),
};
{
  const coll = PG.demo.collection("reviewRecords");
  // 2,500 筆跨年紀錄（2025：500／2026：1,200／2027：800）＋10 筆 2024（應被預篩掉）
  for (let i = 0; i < 2500; i++) {
    const year = i < 500 ? 2025 : i < 1700 ? 2026 : 2027;
    PG.demo.setDoc(PG.demo.docOf(coll, `rec-${String(i).padStart(4, "0")}`), {
      indicatorId: ["IND-A", "IND-B", "IND-C"][i % 3],
      year,
      month: (i % 12) + 1,
      rate: 80,
    });
  }
  for (let i = 0; i < 10; i++) {
    PG.demo.setDoc(PG.demo.docOf(coll, `old-${i}`), {
      indicatorId: "IND-A",
      year: 2024,
      month: 1,
      rate: 80,
    });
  }
  const res = await PG.fetchAllPaged(
    coll,
    [PG.demo.where("year", ">=", 2025)],
    demoApi,
    { pageSize: 500 },
  );
  a(
    `B6 分頁：2,500 筆全取回（舊 limit(2000) 會少 500），truncated=false、pages=6（5 滿頁＋1 空頁確認）`,
    res.docs.length === 2500 && res.truncated === false && res.pages === 6,
  );
  const ids = res.docs.map((d) => d.id);
  a("B6 分頁：無重複 id", new Set(ids).size === 2500);
  const years = res.docs.map((d) => d.data().year);
  a(
    "B6 分頁：依 year 升序回傳（游標順序正確）",
    years.every((y, i) => i === 0 || y >= years[i - 1]),
  );
  a(
    "B6 分頁：2024 舊年紀錄被預篩排除",
    !ids.some((id) => id.startsWith("old-")),
  );
  // 分組對照：分頁結果按指標分組＝整批一次讀取的分組
  const full = PG.demo.getDocs(PG.demo.query(coll, PG.demo.where("year", ">=", 2025)));
  const group = (docs) => {
    const m = new Map();
    for (const d of docs) {
      const iid = d.data().indicatorId;
      m.set(iid, (m.get(iid) ?? 0) + 1);
    }
    return JSON.stringify([...m.entries()].sort());
  };
  a("B6 分頁：按指標分組數與整批讀取一致", group(res.docs) === group(full.docs));
  // 上限：頁數跑滿回報 truncated，不無聲少算
  const capped = await PG.fetchAllPaged(
    coll,
    [PG.demo.where("year", ">=", 2025)],
    demoApi,
    { pageSize: 500, maxPages: 2 },
  );
  a(
    "B6 分頁：觸及頁數上限回報 truncated=true、只取 1,000 筆",
    capped.truncated === true && capped.docs.length === 1000,
  );
  // 小集合：一頁完成、不截斷
  const small = await PG.fetchAllPaged(
    coll,
    [PG.demo.where("year", ">=", 2027)],
    demoApi,
    { pageSize: 500 },
  );
  a(
    "B6 分頁：800 筆兩頁取完、truncated=false",
    small.docs.length === 800 && small.truncated === false && small.pages === 2,
  );
}

// ---------- B8：原始碼層面 ----------
const dash = src("src/features/dashboard/useDashboardData.ts");
a("B8：校正節流走 correctionThrottle", dash.includes("shouldWriteCorrection(") && dash.includes("markCorrectionWritten("));
a("B8：寫入失敗有可見狀態 correctionFailed", dash.includes("correctionFailed") && dash.includes("setCorrectionFailed(true)"));
a("B8：靜默 catch 已移除（batch.commit 不再無聲吞錯）", !/batch\.commit\(\)\.catch\(\(\) => \{\s*\/\* 下次載入再試 \*\//.test(dash));
const dashPage = src("src/features/DashboardPage.tsx");
a("B8：寫入失敗有畫面提示文案", dashPage.includes("correctionFailed") && dashPage.includes("自動校正寫入失敗"));
const throttle = src("src/lib/correctionThrottle.ts");
a("B8：節流為每小時一次（CORRECTION_THROTTLE_MS＝3600000）", throttle.includes("60 * 60 * 1000"));
a("B8：目標狀態變了仍寫（不因節流漏校正）", /prev\.status !== status/.test(throttle));
// B8(a)：校正呼叫點全站唯一（useDashboardData）
{
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = resolve(dir, e);
      if (statSync(p).isDirectory()) {
        if (e !== "node_modules") walk(p);
      } else if (/\.(ts|tsx)$/.test(e)) files.push(p);
    }
  };
  walk(resolve(ROOT, "src"));
  let calls = 0;
  for (const fpath of files) {
    const text = readFileSync(fpath, "utf8");
    for (const line of text.split("\n")) {
      if (/correctTaskStatus\(/.test(line) && !/import|export function/.test(line)) calls++;
    }
  }
  a("B8(a)：correctTaskStatus 呼叫點全站唯一（useDashboardData，無漏網）", calls === 1);
}

// ---------- B8：功能對照（節流語意，時間可注入） ----------
writeFileSync(
  "/tmp/t128w-thr.ts",
  `export { shouldWriteCorrection, markCorrectionWritten, clearCorrectionThrottle, CORRECTION_THROTTLE_MS } from "${ROOT}/src/lib/correctionThrottle";`,
);
await build({
  entryPoints: ["/tmp/t128w-thr.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: "/tmp/t128w-thr.cjs",
  logLevel: "silent",
});
const TH = require("/tmp/t128w-thr.cjs");
TH.clearCorrectionThrottle();
a("B8 節流：首次校正放行", TH.shouldWriteCorrection("t1", "done", 1000) === true);
TH.markCorrectionWritten("t1", "done", 1000);
a("B8 節流：一小時內同狀態不重寫", TH.shouldWriteCorrection("t1", "done", 1000 + 30 * 60 * 1000) === false);
a("B8 節流：目標狀態變了仍放行", TH.shouldWriteCorrection("t1", "locked", 1000 + 30 * 60 * 1000) === true);
a("B8 節流：一小時後同狀態再度放行", TH.shouldWriteCorrection("t1", "done", 1000 + 60 * 60 * 1000 + 1) === true);
a("B8 節流：不同任務互不干擾", TH.shouldWriteCorrection("t2", "done", 1000 + 30 * 60 * 1000) === true);
a("B8 節流：常數＝1 小時", TH.CORRECTION_THROTTLE_MS === 3600000);

console.log(f === 0 ? "WAVE2 ALL PASS" : `WAVE2 FAILURES: ${f}`);
process.exit(f === 0 ? 0 : 1);
