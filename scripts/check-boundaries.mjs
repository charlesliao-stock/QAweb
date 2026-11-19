/**
 * 依賴邊界檢查（純 node，無外部套件）。
 *
 * 規則：
 *  R1 三個業務領域（groups／results／schedule）彼此不得 import。
 *     領域成員：GroupsPage.tsx＋features/groups/**；ResultsPage.tsx＋features/results/**；
 *     SchedulePage.tsx、ScheduleDetailPage.tsx＋features/schedule/**。
 *  R2 lib/ 不得 import features/、components/、app/。
 *  R3 components/ 不得 import features/、app/。
 *  R4 features/ 不得 import app/。
 *
 * 既有且已知的例外列在 scripts/boundary-allowlist.json（需註明原因）；
 * 新增違規會使本腳本以非 0 結束。同時偵測 allowlist 中已不存在的項目並提示清理。
 *
 * 用法：node scripts/check-boundaries.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ROOT } from "./lib/paths.mjs";

const SRC = join(ROOT, "src");
const EXTS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|js|jsx|mjs)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

// import x from "..."／import "..."／export ... from "..."／import("...")，含 type-only 與多行
const IMPORT_RE =
  /(?:^|[\s;{}])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith(".")) return null; // 外部套件不檢查
  const base = resolve(dirname(fromFile), spec);
  const tries = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => join(base, "index" + e))];
  for (const t of tries) {
    if (existsSync(t) && statSync(t).isFile()) return t;
  }
  return undefined; // 解析不到（資源檔等）
}

function domainOf(rel) {
  const seg = rel.split("/");
  if (seg[0] !== "features") return null;
  const file = seg[1] ?? "";
  if (file === "GroupsPage.tsx" || file === "groups") return "groups";
  if (file === "ResultsPage.tsx" || file === "results") return "results";
  if (file === "SchedulePage.tsx" || file === "ScheduleDetailPage.tsx" || file === "schedule") return "schedule";
  return null;
}
const layerOf = (rel) => rel.split("/")[0];

const allowlist = JSON.parse(readFileSync(join(ROOT, "scripts", "boundary-allowlist.json"), "utf8")).allow;
const allowKey = (from, to) => `${from} -> ${to}`;
const allowed = new Map(allowlist.map((a) => [allowKey(a.from, a.to), a]));
const usedAllow = new Set();

const violations = [];
for (const file of walk(SRC)) {
  const rel = relative(SRC, file).replace(/\\/g, "/");
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2];
    const target = resolveSpec(file, spec);
    if (!target) continue;
    const trel = relative(SRC, target).replace(/\\/g, "/");
    if (trel.startsWith("..")) continue;
    const reasons = [];
    const dFrom = domainOf(rel);
    const dTo = domainOf(trel);
    if (dFrom && dTo && dFrom !== dTo) reasons.push(`R1 領域 ${dFrom} 不得 import 領域 ${dTo}`);
    const lFrom = layerOf(rel);
    const lTo = layerOf(trel);
    if (lFrom === "lib" && ["features", "components", "app"].includes(lTo)) reasons.push(`R2 lib 不得 import ${lTo}`);
    if (lFrom === "components" && ["features", "app"].includes(lTo)) reasons.push(`R3 components 不得 import ${lTo}`);
    if (lFrom === "features" && lTo === "app") reasons.push("R4 features 不得 import app");
    for (const reason of reasons) {
      const key = allowKey(rel, trel);
      if (allowed.has(key)) usedAllow.add(key);
      else violations.push({ rel, trel, reason });
    }
  }
}

const stale = [...allowed.keys()].filter((k) => !usedAllow.has(k));
if (stale.length) {
  console.log("提示：以下 allowlist 項目已不再需要，請移除：");
  for (const k of stale) console.log("  - " + k);
}
if (violations.length) {
  console.error(`依賴邊界檢查失敗：${violations.length} 項違規`);
  for (const v of violations) console.error(`  ${v.rel} -> ${v.trel}\n    ${v.reason}`);
  process.exit(1);
}
console.log(`依賴邊界檢查通過（掃描 ${walk(SRC).length} 個檔案，allowlist ${usedAllow.size} 項）`);
