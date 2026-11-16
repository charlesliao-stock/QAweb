/**
 * 替所有 Firebase 帳號加上 Supabase 需要的自訂標記 role=authenticated（沿用 Firebase 登入的前置作業）。
 * 已有標記的帳號會略過，所以「新增帳號後再跑一次」是安全的；其他既有標記一律保留。
 *
 * 在「你自己的電腦」執行（需要 Firebase 管理員金鑰，絕對不要提交或貼給別人）：
 *   npm install --no-save firebase-admin tsx
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *   npx tsx scripts/set-supabase-claims.mts --dry-run     # 先看會改誰
 *   npx tsx scripts/set-supabase-claims.mts               # 真的寫入
 * 這支腳本只打 Firebase Auth，不讀 Firestore，不耗 Spark 的讀取額度。
 * 已登入的人下次載入頁面時，前端會自動換發一次新憑證。
 */
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const dry = process.argv.includes("--dry-run");
initializeApp({ credential: applicationDefault() });
const auth = getAuth();

let seen = 0, changed = 0, already = 0;
let token: string | undefined;
do {
  const page = await auth.listUsers(1000, token);
  for (const u of page.users) {
    seen++;
    const claims = (u.customClaims ?? {}) as Record<string, unknown>;
    if (claims.role === "authenticated") { already++; continue; }
    changed++;
    console.log(`${dry ? "[dry-run] " : ""}${u.email ?? u.uid} ${claims.role ? `（原 role=${String(claims.role)}，將改為 authenticated）` : ""}`);
    if (!dry) await auth.setCustomUserClaims(u.uid, { ...claims, role: "authenticated" });
  }
  token = page.pageToken;
} while (token);

console.log(`\n帳號 ${seen} 個：已有標記 ${already}，${dry ? "將新增" : "已新增"} ${changed}。`);
if (dry && changed > 0) console.log("確認無誤後，拿掉 --dry-run 再執行一次。");
