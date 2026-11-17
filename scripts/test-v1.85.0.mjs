/**
 * v1.85.0 斷言測試：登入帳號對帳（靜態守衛；行為已用模擬的 Firebase／Supabase 另外驗證過）。
 * 覆蓋：
 * 1. 對帳腳本：以 Supabase 名單為準；建立／補標記／停用／啟用／刪除；保護 admin 與 KEEP_EMAILS；
 *    名單為空或讀取失敗不動作；超過 max-delete 整批不刪；無金鑰時只建立不刪除；--prune-firestore
 * 2. workflow：每小時排程＋手動、有 max_delete 與 prune_firestore 輸入、帶 service_role secret
 * 3. 說明文字：人員刪除／停用時帳號一併處理
 * 4. 版號 1.85.0（src/version.ts 與 package.json 一致）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(`${ROOT}/${p}`, "utf8");
const prov = read("scripts/provision-auth-accounts.mts");
const wf = read(".github/workflows/provision-auth-accounts.yml");
const groups = read("src/features/GroupsPage.tsx");
const versionTs = read("src/version.ts");
const pkg = JSON.parse(read("package.json"));

let pass = 0, fail = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
function check(name, fn) {
  try { fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.log(`FAIL - ${name}: ${e.message}`); }
}

check("名單以 Supabase 為準，來源不可靠就不動作", () => {
  must(prov.includes("col=eq.users&deleted=eq.false"), "未讀 Supabase 未刪除的 users");
  must(prov.includes("roster.length === 0"), "缺空名單保護");
  must(prov.includes("process.exit(1)"), "讀取失敗未中止");
  must(prov.includes("if (authoritative) {"), "刪除未限定在可靠來源");
});
check("建立／補標記／停用／啟用／刪除", () => {
  must(prov.includes('role: "authenticated", staffId'), "缺標記");
  must(prov.includes("disabled: true") && prov.includes("disabled: false"), "缺停用／啟用");
  must(prov.includes("auth.deleteUser(u.uid)"), "缺刪除帳號");
  must(prov.includes('db.collection("users").doc(sid)'), "缺刪除對應 Firestore users");
});
check("保護與安全上限", () => {
  must(prov.includes("const ADMIN_EMAIL = `admin@${MAIL_DOMAIN}`;"), "缺 admin 保護");
  must(prov.includes("KEEP_EMAILS"), "缺 KEEP_EMAILS");
  must(prov.includes("orphans.length > maxDelete"), "缺刪除上限");
  must(prov.includes('num("max-delete", 20)'), "預設上限應為 20");
  must(prov.includes("--prune-firestore"), "缺 prune 選項");
});
check("workflow：每小時＋手動，帶 secret", () => {
  must(/cron: "\d+ \* \* \* \*"/.test(wf), "缺每小時排程");
  must(wf.includes("max_delete:") && wf.includes("prune_firestore:"), "缺輸入");
  must(wf.includes("secrets.SUPABASE_SERVICE_ROLE_KEY"), "缺 service_role secret");
  must(wf.includes("secrets.FIREBASE_SERVICE_ACCOUNT"), "缺 Firebase secret");
});
check("管理頁說明：刪除或停用人員時帳號一併處理", () => {
  must(groups.includes("刪除或停用人員時，登入帳號也會一併刪除或停用"), "說明文字");
});
check("版號 1.85.0", () => {
  must(versionTs.includes('export const VERSION = "1.85.0";'), "version.ts");
  must(pkg.version === "1.85.0", "package.json");
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
