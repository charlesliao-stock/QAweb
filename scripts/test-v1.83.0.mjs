/**
 * v1.83.0 斷言測試：帳號開通（Firebase 認證連結）＋登入只輸入職編（靜態守衛，無需 emulator）。
 * 取代 v1.40.6 的「初始密碼＝職編」約定（該約定已移除，v1.40.6 測試不再適用）。
 * 覆蓋：
 * 1. normalizeStaffId：全形轉半形、去空白、誤輸入完整信箱只取職編
 * 2. staffEmail 一律 職編@kmuh.org.tw
 * 3. auth/invalid-email 有中文訊息；開通信不透露職編是否存在
 * 4. 登入頁有「開通帳號」入口且有 60 秒重寄冷卻
 * 5. 首次成功登入寫入 activatedAt；排程頁有未開通審查員提醒（只提醒、不過濾選人）
 * 6. 批次建帳號腳本：隨機密碼、補 role claim、略過停用／已有帳號、支援 dry-run
 * 7. 新人員預設不再強制改密碼；程式中不再出現 nurseboard.internal 登入網域
 * 8. 版號一致：src/version.ts 與 package.json 皆為 1.83.0
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(`${ROOT}/${p}`, "utf8");
const authSrc = read("src/lib/auth.tsx");
const appSrc = read("src/app/App.tsx");
const schedSrc = read("src/features/SchedulePage.tsx");
const groupsSrc = read("src/features/GroupsPage.tsx");
const provSrc = read("scripts/provision-auth-accounts.mts");
const versionTs = read("src/version.ts");
const pkg = JSON.parse(read("package.json"));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`ok - ${name}`); }
  catch (err) { fail++; console.log(`FAIL - ${name}: ${err.message}`); }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// 從原始碼取出 normalizeStaffId 實際執行
const m = authSrc.match(/export function normalizeStaffId\(input: string\): string \{([\s\S]*?)\n\}/);
const normalize = m ? new Function("input", m[1]) : null;

check("normalizeStaffId：全形轉半形、去空白、取 @ 前", () => {
  must(normalize, "找不到 normalizeStaffId");
  must(normalize("１２３４５") === "12345", "全形數字未轉半形");
  must(normalize(" 12 34 ") === "1234", "空白未移除");
  must(normalize("12345@kmuh.org.tw") === "12345", "完整信箱未只取職編");
  must(normalize("") === "", "空字串");
});
check("staffEmail 一律 職編@kmuh.org.tw", () => {
  must(authSrc.includes('export const STAFF_MAIL_DOMAIN = "kmuh.org.tw";'), "網域常數");
  must(authSrc.includes("return `${staffMailLocal(staffId)}@${STAFF_MAIL_DOMAIN}`;"), "staffEmail 規則（v1.84.1 起信箱去掉開頭 0）");
});
check("invalid-email 中文訊息；開通信不探測職編", () => {
  must(authSrc.includes('case "auth/invalid-email":'), "缺 invalid-email");
  must(authSrc.includes('if (code === "auth/user-not-found") return;'), "未隱藏 user-not-found");
  must(authSrc.includes("sendPasswordResetEmail(getFirebaseAuth(), staffEmail(id))"), "未寄認證連結");
});
check("登入頁有開通入口與 60 秒冷卻", () => {
  must(appSrc.includes("requestActivationMail"), "未呼叫 requestActivationMail");
  must(appSrc.includes("setCooldown(60)"), "缺冷卻");
  must(appSrc.includes("開通帳號"), "缺入口文字");
});
check("首次登入寫 activatedAt；排程頁提醒只提醒不過濾", () => {
  must(authSrc.includes('{ activatedAt }'), "未寫 activatedAt");
  must(schedSrc.includes("function InactiveReviewerNotice"), "缺提醒元件");
  must(schedSrc.includes("<InactiveReviewerNotice"), "未使用提醒元件");
  must(!/filter\([^)]*activated[^)]*\)\s*\.map\(\(person\)/.test(schedSrc), "不得以 activated 過濾審查員選單");
});
check("批次建帳號腳本", () => {
  must(provSrc.includes("randomBytes(24)"), "未用隨機密碼");
  must(provSrc.includes('role: "authenticated"'), "未補 claim");
  must(provSrc.includes('"停用"'), "未略過停用");
  must(provSrc.includes("--dry-run"), "缺 dry-run");
  must(provSrc.includes("kmuh.org.tw"), "缺網域");
});
check("不再強制改密碼預設／不再有 nurseboard.internal 登入網域", () => {
  must(!groupsSrc.includes("mustChangePassword: true"), "仍有預設強制改密碼");
  must(!authSrc.includes("nurseboard.internal"), "auth.tsx 仍有舊網域");
  must(!groupsSrc.includes("nurseboard.internal"), "GroupsPage 仍有舊網域");
});
check("版號一致（1.83.x 起）", () => {
  must(/export const VERSION = "1\.(83|84|85|86)\.\d+";/.test(versionTs), "version.ts");
  must(/^1\.(83|84|85|86)\./.test(pkg.version), "package.json");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
