/**
 * 測試執行器：逐支執行 scripts/test-v*.mjs，並與 tests/test-baseline.json 的基準線逐項比對。
 *
 * 為何不用「通過總數」：一項新失敗可能被另一項修復抵銷。這裡每支腳本各自有預期結果。
 *
 * 分類（suite，依腳本實際 import 判定，見 tests/test-inventory.md）：
 *   static  只讀檔案做字串／結構斷言，不需任何外部套件
 *   bundle  用 esbuild 打包 src 後在 node 執行斷言（需 esbuild）
 *   dom     需要 jsdom（亦需 esbuild）
 * 需要外部服務的測試（rules／RLS／雙寫）不在此執行器內：見 package.json 的 test:rules 等。
 *
 * 判定：
 *   預期 pass，實際 fail         → 新失敗，整體失敗（exit 1）
 *   預期 fail，實際 pass         → 已修復，提示更新基準線（不失敗）
 *   預期 fail，實際 fail         → 已知失敗，列出但不失敗
 *   預期 unknown                 → 只回報，不失敗（尚未取得基準）
 *   缺少 esbuild／jsdom 套件      → skip；加 --require-deps 則視為失敗（CI 用）
 *   腳本存在但未登記於基準線     → 視為預期 pass 並警告
 *
 * 用法：
 *   node scripts/run-tests.mjs [--suite static,bundle,dom] [--require-deps] [--update-baseline] [--only <substr>]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/paths.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const suites = new Set((opt("--suite") ?? "static,bundle,dom").split(",").map((s) => s.trim()));
const requireDeps = flag("--require-deps");
const updateBaseline = flag("--update-baseline");
const only = opt("--only");
const TIMEOUT_MS = 180_000;

const baselinePath = join(ROOT, "tests", "test-baseline.json");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const entries = baseline.scripts;

const scripts = readdirSync(join(ROOT, "scripts"))
  .filter((f) => /^test-v.*\.mjs$/.test(f))
  .sort()
  .map((f) => `scripts/${f}`);

const results = [];
const unregistered = [];
for (const script of scripts) {
  const entry = entries[script];
  if (!entry) unregistered.push(script);
  const suite = entry?.suite ?? "static";
  if (!suites.has(suite)) continue;
  if (only && !script.includes(only)) continue;
  const expect = entry?.expect ?? "pass";
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  // 缺少已安裝的套件（esbuild／jsdom／node_modules 內的任何套件）→ 視為環境不足而非測試失敗
  const missingDep =
    /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (?:package|module) '[^'.\/][^']*'|(?:ENOENT|scandir)[^\n]*node_modules/.test(out);
  let actual;
  if (r.error?.code === "ETIMEDOUT") actual = "fail";
  else if (r.status === 0) actual = "pass";
  else if (missingDep) actual = "skip";
  else actual = "fail";
  results.push({
    script,
    suite,
    expect,
    actual,
    ms: Date.now() - t0,
    tail: actual === "fail" ? out.trim().split("\n").slice(-6).join("\n") : "",
    reason: r.error?.code === "ETIMEDOUT" ? "timeout" : "",
  });
}

let failed = false;
const line = (tag, r) => console.log(`${tag.padEnd(8)} ${r.script}  [${r.suite}] ${r.ms}ms${r.reason ? " (" + r.reason + ")" : ""}`);
for (const r of results) {
  if (r.actual === "skip") {
    line(requireDeps ? "MISSDEP" : "skip", r);
    if (requireDeps) failed = true;
  } else if (r.expect === "pass" && r.actual === "pass") line("ok", r);
  else if (r.expect === "pass" && r.actual === "fail") {
    line("NEWFAIL", r);
    console.log(r.tail.replace(/^/gm, "    | "));
    failed = true;
  } else if (r.expect === "fail" && r.actual === "fail") line("known", r);
  else if (r.expect === "fail" && r.actual === "pass") line("FIXED", r);
  else if (r.expect === "unknown") line(r.actual === "pass" ? "u-pass" : "u-fail", r);
}
for (const u of unregistered) console.log(`WARN     ${u} 未登記於 tests/test-baseline.json（以預期 pass 處理，請補登）`);

const count = (p) => results.filter(p).length;
console.log(
  `\n合計 ${results.length}：ok ${count((r) => r.expect === "pass" && r.actual === "pass")}、` +
    `新失敗 ${count((r) => r.expect === "pass" && r.actual === "fail")}、` +
    `已知失敗 ${count((r) => r.expect === "fail" && r.actual === "fail")}、` +
    `已修復待更新 ${count((r) => r.expect === "fail" && r.actual === "pass")}、` +
    `未定基準 ${count((r) => r.expect === "unknown")}、略過 ${count((r) => r.actual === "skip")}`,
);

// 機器可讀結果（CI 日誌擷取用，亦供 --update-baseline 使用）
const summary = Object.fromEntries(results.map((r) => [r.script, r.actual]));
console.log("::results-json::" + JSON.stringify(summary));

if (updateBaseline) {
  for (const r of results) {
    if (r.actual === "skip") continue;
    entries[r.script] = { ...(entries[r.script] ?? { suite: r.suite }), expect: r.actual };
  }
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
  console.log("已更新 tests/test-baseline.json");
}
if (failed) process.exit(1);
