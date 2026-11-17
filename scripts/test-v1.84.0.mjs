/**
 * v1.84.0 斷言測試：開通信「最近寄送記錄」（前端回報，靜態守衛，無需 emulator）。
 * 覆蓋：
 * 1. 寄信時回報 mailLogs（成功／失敗代碼），失敗不影響寄信，且直接寫 Firestore（不走雙寫層）
 * 2. firestore.rules：mailLogs 只收固定欄位與長度、時間用伺服器時間；僅管理員可讀與刪除；不可修改
 * 3. 系統管理有「寄信記錄」分頁，僅系統管理員可見；手動載入最近 50 筆，不自動讀取
 * 4. 版號 1.84.0（src/version.ts 與 package.json 一致）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(`${ROOT}/${p}`, "utf8");
const authSrc = read("src/lib/auth.tsx");
const rules = read("firestore.rules");
const adminSrc = read("src/features/AdminPage.tsx");
const secSrc = read("src/features/MailLogSection.tsx");
const versionTs = read("src/version.ts");
const pkg = JSON.parse(read("package.json"));

let pass = 0, fail = 0;
const must = (c, m) => { if (!c) throw new Error(m); };
function check(name, fn) {
  try { fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.log(`FAIL - ${name}: ${e.message}`); }
}

check("寄信回報 mailLogs，直接寫 Firestore", () => {
  must(authSrc.includes('from "firebase/firestore"'), "未直接引用 firebase/firestore");
  must(authSrc.includes('logMailAttempt(id, "accepted")'), "成功未回報");
  must(authSrc.includes('code.replace(/^auth\\//, "")'), "失敗代碼未回報");
  must(authSrc.includes(".catch(() => undefined)"), "回報失敗不應丟錯");
});
check("firestore.rules：mailLogs 限制", () => {
  const m = rules.match(/match \/mailLogs\/\{id\} \{([\s\S]*?)\n    \}/);
  must(m, "找不到 mailLogs 規則");
  const r = m[1];
  must(r.includes("hasOnly(['staffId', 'result', 'source', 'at'])"), "未限制欄位");
  must(r.includes("request.resource.data.at == request.time"), "時間未用伺服器時間");
  must(r.includes("allow read, delete: if isAdmin();"), "讀／刪須限管理員");
  must(r.includes("allow update: if false;"), "不可修改");
});
check("系統管理有寄信記錄分頁（僅管理員）；手動載入", () => {
  must(adminSrc.includes('id: "mail-log" as const, label: "寄信記錄"'), "缺分頁");
  must(adminSrc.includes('activeTab === "mail-log" && isAdmin'), "未限管理員");
  must(secSrc.includes("limit(50)"), "未限 50 筆");
  must(!/useEffect/.test(secSrc), "不應自動讀取");
});
check("版號 1.84.x 起", () => {
  must(/export const VERSION = "1\.(84|85|86)\.\d+";/.test(versionTs), "version.ts");
  must(/^1\.(84|85|86)\./.test(pkg.version), "package.json");
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
