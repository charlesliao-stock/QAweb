// 比對兩份渲染快照；有差異則列出第一個差異位置並以非 0 結束
import { readFileSync } from "node:fs";
const [a, b] = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, "utf8")));
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
