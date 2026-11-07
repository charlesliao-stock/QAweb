/**
 * v1.28 階段 4 斷言：記憶體快取參考資料（B2）。
 * 執行：node scripts/test-v1.28-refcache.mjs（專案根目錄）
 */
import { build } from "esbuild";
import { writeFileSync } from "fs";
import { createRequire } from "module";
import { resolve } from "path";
const ROOT = resolve(import.meta.dirname, "..");
writeFileSync(
  "/tmp/t128c.ts",
  `export { clearRefCache, getCachedRef, getCachedRefCollection, getRefCacheFetchedAt, invalidateRefCollection, invalidateRefConfig, invalidateRefForDocPath, SYSTEM_CONFIG_KEY, REF_COLLECTIONS } from "${ROOT}/src/lib/refCache";`,
);
await build({ entryPoints: ["/tmp/t128c.ts"], bundle: true, format: "cjs", platform: "node", outfile: "/tmp/t128c.cjs", logLevel: "silent" });
const L = createRequire("/tmp/t128c.cjs")("/tmp/t128c.cjs");
let f = 0;
const a = (n, c) => { if (!c) { f++; console.error("FAIL:", n); } };

// 範圍：六個參考集合＋systemParams/config
a("範圍：七集合（v1.32.0 加 uiThemes）", JSON.stringify(L.REF_COLLECTIONS) === JSON.stringify(["indicators", "groups", "units", "users", "roles", "titles", "uiThemes"]));
a("範圍：config 鍵", L.SYSTEM_CONFIG_KEY === "systemParams/config");

// 命中／未命中：同一集合第二次不重查
L.clearRefCache();
{
  let calls = 0;
  const fetcher = async () => { calls++; return [{ id: "u1" }]; };
  const first = await L.getCachedRefCollection("users", fetcher);
  const second = await L.getCachedRefCollection("users", fetcher);
  a("命中：第二次不重查", calls === 1 && first === second && second.length === 1);
  a("資料時間：命中後有 fetchedAt", typeof L.getRefCacheFetchedAt("users") === "number" && L.getRefCacheFetchedAt("users") > 0);
}

// 並行去重：同時發出的同一集合讀取只查一次
L.clearRefCache();
{
  let calls = 0;
  const fetcher = async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return [{ id: "g1" }]; };
  const [r1, r2, r3] = await Promise.all([
    L.getCachedRefCollection("groups", fetcher),
    L.getCachedRefCollection("groups", fetcher),
    L.getCachedRefCollection("groups", fetcher),
  ]);
  a("去重：三路並行只查一次", calls === 1 && r1 === r2 && r2 === r3);
  // 去重後已入快取，後續再查仍不重查
  await L.getCachedRefCollection("groups", fetcher);
  a("去重：後續命中不重查", calls === 1);
}

// 不同集合互不干擾
L.clearRefCache();
{
  let u = 0, r = 0;
  await L.getCachedRefCollection("users", async () => { u++; return []; });
  await L.getCachedRefCollection("roles", async () => { r++; return []; });
  await L.getCachedRefCollection("users", async () => { u++; return []; });
  await L.getCachedRefCollection("roles", async () => { r++; return []; });
  a("隔離：集合間快取獨立", u === 1 && r === 1);
}

// 失效：只失效指定集合，其他集合不受影響
{
  L.invalidateRefCollection("users");
  let u = 0, r = 0;
  await L.getCachedRefCollection("users", async () => { u++; return []; });
  await L.getCachedRefCollection("roles", async () => { r++; return []; });
  a("失效：指定集合重查、其他仍命中", u === 1 && r === 0);
}

// 失敗不入快取：下次重查
L.clearRefCache();
{
  let calls = 0;
  const bad = async () => { calls++; throw new Error("boom"); };
  await L.getCachedRefCollection("units", bad).catch(() => {});
  await L.getCachedRefCollection("units", bad).catch(() => {});
  a("失敗不快取：每次都重查", calls === 2);
  const ok = await L.getCachedRefCollection("units", async () => [{ id: "x" }]);
  a("失敗後成功可入快取", ok.length === 1);
}

// config 單一文件：與集合鍵獨立
L.clearRefCache();
{
  let c = 0, u = 0;
  await L.getCachedRef("systemParams/config", async () => { c++; return { theme: "a" }; });
  await L.getCachedRefCollection("users", async () => { u++; return []; });
  await L.getCachedRef("systemParams/config", async () => { c++; return { theme: "a" }; });
  a("config：命中不重查", c === 1 && u === 1);
  L.invalidateRefConfig();
  await L.getCachedRef("systemParams/config", async () => { c++; return { theme: "a" }; });
  await L.getCachedRefCollection("users", async () => { u++; return []; });
  a("config：失效只影響 config", c === 2 && u === 1);
}

// 路徑失效解析（db.ts 寫入出口用）：首段集合／config／非參考集合
L.clearRefCache();
{
  let u = 0, ind = 0, g = 0;
  await L.getCachedRefCollection("users", async () => { u++; return []; });
  await L.getCachedRefCollection("indicators", async () => { ind++; return []; });
  await L.getCachedRefCollection("groups", async () => { g++; return []; });
  L.invalidateRefForDocPath("users/EMP001");
  await L.getCachedRefCollection("users", async () => { u++; return []; });
  await L.getCachedRefCollection("indicators", async () => { ind++; return []; });
  a("路徑失效：users 文件寫入只失效 users", u === 2 && ind === 1 && g === 1);
  L.invalidateRefForDocPath("indicators/GRP__001/versions/v1.0");
  await L.getCachedRefCollection("indicators", async () => { ind++; return []; });
  await L.getCachedRefCollection("groups", async () => { g++; return []; });
  a("路徑失效：子集合寫入失效首段集合", ind === 2 && g === 1);
  L.invalidateRefForDocPath("reviewTasks/2026-01");
  L.invalidateRefForDocPath("reviewRecords/r1");
  await L.getCachedRefCollection("groups", async () => { g++; return []; });
  a("路徑失效：任務／紀錄寫入不碰參考快取", g === 1);
  let c = 0;
  await L.getCachedRef("systemParams/config", async () => { c++; return {}; });
  L.invalidateRefForDocPath("systemParams/config");
  await L.getCachedRef("systemParams/config", async () => { c++; return {}; });
  a("路徑失效：config 寫入失效 config", c === 2);
  L.invalidateRefForDocPath("");
  L.invalidateRefForDocPath("bogus");
  a("路徑失效：空路徑／未知集合不報錯", true);
}

// clear：全部清空
{
  L.clearRefCache();
  a("清空：fetchedAt 歸 null", L.getRefCacheFetchedAt("users") === null && L.getRefCacheFetchedAt("systemParams/config") === null);
}

if (f > 0) { console.error(`test-v1.28-refcache: ${f} 項失敗`); process.exit(1); }
console.log("test-v1.28-refcache: 全部通過");
