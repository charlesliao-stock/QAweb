/**
 * v1.84.2 斷言測試：資料清理一律保留 admin 帳號（靜態守衛，無需 emulator）。
 * 覆蓋：
 * 1. 人員清理保護規則含 admin（不論角色），並保留原有「自己」「系統管理員角色」保護
 * 2. 說明文字寫明保留 admin
 * 3. 版號 1.84.2（src/version.ts 與 package.json 一致）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(`${ROOT}/${p}`, "utf8");
const src = read("src/features/AdminCleanupSection.tsx");
const versionTs = read("src/version.ts");
const pkg = JSON.parse(read("package.json"));

let pass = 0, fail = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
function check(name, fn) {
  try { fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.log(`FAIL - ${name}: ${e.message}`); }
}

check("人員清理一律保留 admin，原保護仍在", () => {
  must(src.includes('const ADMIN_STAFF_ID = "admin";'), "缺常數");
  must(src.includes("id === ADMIN_STAFF_ID ||"), "protect 未含 admin");
  must(src.includes("id === me.staffId ||"), "缺保護自己");
  must(src.includes('includes("系統管理員")'), "缺保護系統管理員角色人員");
});
check("說明文字寫明保留 admin", () => {
  must(src.includes("一律保留 admin 帳號"), "note");
});
check("版號 1.84.x 起", () => {
  must(/export const VERSION = "1\.(84|85|86)\.\d+";/.test(versionTs), "version.ts");
  must(/^1\.(84|85|86)\./.test(pkg.version), "package.json");
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
