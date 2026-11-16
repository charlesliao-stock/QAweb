/**
 * v1.84.1 斷言測試：院內信箱＝職編去掉開頭的 0（靜態守衛，無需 emulator）。
 * 覆蓋：
 * 1. staffMailLocal：0930462 → 930462；930462 不變；全 0 保留；非數字開頭不動
 * 2. staffEmail 用 staffMailLocal；登入與還原登入者職編改讀自訂標記 staffId（無標記退回信箱）
 * 3. Firestore 規則與 Supabase staff_id() 都優先讀 staffId 標記、無標記退回信箱（向下相容）
 * 4. 建立帳號腳本：信箱去掉開頭 0、寫入 staffId 標記、補標記、偵測衝突、列出舊格式帳號
 * 5. 版號 1.84.1（src/version.ts 與 package.json 一致）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(`${ROOT}/${p}`, "utf8");
const authSrc = read("src/lib/auth.tsx");
const rules = read("firestore.rules");
const rls = read("supabase/03-rls.sql");
const sql5 = read("supabase/05-staff-id-claim.sql");
const prov = read("scripts/provision-auth-accounts.mts");
const versionTs = read("src/version.ts");
const pkg = JSON.parse(read("package.json"));

let pass = 0, fail = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
function check(name, fn) {
  try { fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.log(`FAIL - ${name}: ${e.message}`); }
}

const norm = authSrc.match(/export function normalizeStaffId\(input: string\): string \{([\s\S]*?)\n\}/);
const loc = authSrc.match(/export function staffMailLocal\(staffId: string\): string \{([\s\S]*?)\n\}/);
check("staffMailLocal 去掉開頭的 0", () => {
  must(norm && loc, "找不到函式");
  const normalizeStaffId = new Function("input", norm[1]);
  const f = new Function("normalizeStaffId", "staffId", loc[1]);
  const mail = (id) => f(normalizeStaffId, id);
  must(mail("0930462") === "930462", "0930462");
  must(mail("930462") === "930462", "930462");
  must(mail(" 0930462 ") === "930462", "空白");
  must(mail("000") === "000", "全 0 保留");
  must(mail("A0123") === "A0123", "非數字開頭不動");
});
check("登入與還原職編讀 staffId 標記", () => {
  must(authSrc.includes("return `${staffMailLocal(staffId)}@${STAFF_MAIL_DOMAIN}`;"), "staffEmail");
  must(authSrc.includes("token.claims.staffId"), "未讀標記");
  must(authSrc.includes('return (user.email ?? "").split("@")[0] ?? "";'), "缺退回信箱");
  must(authSrc.includes("await resolveStaffId(cred.user, true)"), "登入未用標記");
  must(authSrc.includes("const staffId = await resolveStaffId(current);"), "還原登入未用標記");
});
check("Firestore 規則與 Supabase 向下相容讀標記", () => {
  must(rules.includes("request.auth.token.get('staffId', '')"), "規則未讀標記");
  must(rules.includes("request.auth.token.email.split('@')[0]"), "規則缺退回信箱");
  for (const t of [rls, sql5]) {
    must(t.includes("nullif(auth.jwt()->>'staffId', '')"), "SQL 未讀標記");
    must(t.includes("split_part(coalesce(auth.jwt()->>'email', ''), '@', 1)"), "SQL 缺退回信箱");
  }
});
check("建立帳號腳本", () => {
  must(prov.includes("function mailLocal"), "缺 mailLocal");
  must(prov.includes('{ role: "authenticated", staffId }'), "未寫 staffId 標記");
  must(prov.includes("補標記"), "缺補標記");
  must(prov.includes("信箱相同"), "缺衝突偵測");
  must(prov.includes("舊格式帳號"), "缺舊格式帳號提示");
});
check("版號 1.84.1", () => {
  must(versionTs.includes('export const VERSION = "1.84.1";'), "version.ts");
  must(pkg.version === "1.84.1", "package.json");
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
