// 比對兩份渲染快照；有差異則列出第一個差異位置並以非 0 結束
import { readFileSync } from "node:fs";
const [a, b] = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, "utf8")));
const norm = (t) => (typeof t === "string" ? t.replace(/\/tmp\/snap\/bundle-[^:)]*/g, "BUNDLE").split("\n    at ")[0] : t);
for (const o of [a, b]) for (const k of Object.keys(o.snaps)) o.snaps[k] = norm(o.snaps[k]);
for (const k of Object.keys(b.snaps)) console.log(`  ${k}\t${b.snaps[k].length}${k.endsWith("例外") ? "\n    " + b.snaps[k].replace(/\n/g, "\n    ").slice(0, 700) : ""}`);
for (const e of b.errors) console.log("  console.error:", e);
if (process.env.DUMP) for (const k of (process.env.DUMP).split(",")) { const h = b.snaps[k] ?? ""; const btn = [...h.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim()).filter(Boolean); const sel = [...h.matchAll(/<select[^>]*>/g)].length; const txt = h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 500); console.log(`DUMP ${k}: buttons=${JSON.stringify(btn)} selects=${sel}\n   text=${txt}`); }
const keys = [...new Set([...Object.keys(a.snaps), ...Object.keys(b.snaps)])];
let bad = 0, same = 0, empty = 0;
for (const k of keys) {
  const x = a.snaps[k], y = b.snaps[k];
  if (x === undefined || y === undefined) { console.log(`✗ ${k}：只存在於${x === undefined ? "拆分後" : "拆分前"}`); bad++; continue; }
  if (x === y) { same++; if (x.length < 40) empty++; continue; }
  let i = 0; while (i < x.length && x[i] === y[i]) i++;
  console.log(`✗ ${k}：第 ${i} 字元起不同\n  前：${x.slice(Math.max(0, i - 60), i + 120)}\n  後：${y.slice(Math.max(0, i - 60), i + 120)}`);
  bad++;
}
const ea = a.errors.length, eb = b.errors.length;
console.log(`快照 ${keys.length} 個：相同 ${same}（其中近乎空白 ${empty}）、不同 ${bad}；console.error 前 ${ea} 筆／後 ${eb} 筆`);
if (JSON.stringify(a.errors) !== JSON.stringify(b.errors)) { console.log("console.error 內容不同"); console.log("前：", a.errors.slice(0, 5)); console.log("後：", b.errors.slice(0, 5)); bad++; }
process.exit(bad ? 1 : 0);
