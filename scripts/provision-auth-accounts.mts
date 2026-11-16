/**
 * 為「人員檔（users）有、但 Firebase Auth 還沒有登入帳號」的人員建立帳號（v1.83.0）。
 *
 * - 登入 email＝職編@kmuh.org.tw（與 src/lib/auth.tsx 的 staffEmail 同一規則）。
 * - 密碼是隨機值、不會被任何人看到；人員必須在登入頁按「開通帳號」，
 *   由 Firebase 內建信寄認證連結到該信箱，自己設定密碼。
 * - 同時補上 Supabase 需要的 role=authenticated 標記。
 * - 已有帳號者一律略過；status 為「停用」者不建立。重複執行是安全的。
 * - 只在手動觸發時讀 Firestore users（每人一次讀取），避免耗 Spark 的每日讀取額度。
 *
 * 在 GitHub Actions 或自己的電腦執行（需要 Firebase 管理員金鑰，絕對不要提交）：
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *   npx tsx scripts/provision-auth-accounts.mts --dry-run   # 先看會建立誰
 *   npx tsx scripts/provision-auth-accounts.mts             # 真的建立
 *   選項：--max=N 單次最多建立 N 個（預設 500）
 */
import { randomBytes } from "node:crypto";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const MAIL_DOMAIN = "kmuh.org.tw";
const dry = process.argv.includes("--dry-run");
const maxArg = process.argv.find((a) => a.startsWith("--max="));
const max = maxArg ? Math.max(1, Number(maxArg.slice(6)) || 500) : 500;

initializeApp({ credential: applicationDefault() });
const auth = getAuth();
const db = getFirestore();

/** 與前端 normalizeStaffId 一致：全形轉半形、去空白、取 @ 前。 */
function normalize(input: string): string {
  const folded = input.normalize("NFKC").replace(/\s+/g, "");
  const at = folded.indexOf("@");
  return at >= 0 ? folded.slice(0, at) : folded;
}

// 1) 現有 Firebase 帳號的 email 集合（小寫）
const existing = new Set<string>();
let token: string | undefined;
do {
  const page = await auth.listUsers(1000, token);
  for (const u of page.users) if (u.email) existing.add(u.email.toLowerCase());
  token = page.pageToken;
} while (token);

// 2) 人員檔（只取需要的欄位）
const snap = await db.collection("users").select("status").get();

let seen = 0, already = 0, skippedInactive = 0, invalid = 0, created = 0, failed = 0;
for (const d of snap.docs) {
  seen++;
  const staffId = normalize(d.id);
  if (!staffId || staffId !== d.id.trim() || /[^\x21-\x7e]/.test(staffId)) {
    invalid++;
    console.log(`略過（職編格式不適合當信箱）：${d.id}`);
    continue;
  }
  if (d.get("status") === "停用") { skippedInactive++; continue; }
  const email = `${staffId}@${MAIL_DOMAIN}`;
  if (existing.has(email.toLowerCase())) { already++; continue; }
  if (created >= max) { console.log(`已達單次上限 ${max}，其餘留待下次執行`); break; }
  if (dry) { created++; console.log(`[dry-run] 將建立 ${staffId}`); continue; }
  try {
    const user = await auth.createUser({
      email,
      password: randomBytes(24).toString("base64url"),
      emailVerified: false,
    });
    await auth.setCustomUserClaims(user.uid, { role: "authenticated" });
    created++;
    console.log(`已建立 ${staffId}`);
  } catch (err) {
    failed++;
    console.log(`建立失敗 ${staffId}：${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(
  `\n人員檔 ${seen} 人：已有帳號 ${already}，停用略過 ${skippedInactive}，格式不適合 ${invalid}，` +
    `${dry ? "將建立" : "已建立"} ${created}，失敗 ${failed}。`,
);
if (dry && created > 0) console.log("確認無誤後，拿掉 --dry-run 再執行一次。");
if (failed > 0) process.exitCode = 1;
