/**
 * 登入帳號對帳（v1.85.0）：以 Supabase 的人員名單（docs.col='users'）為準，讓 Firebase 登入帳號
 * 與名單一致。Spark 沒有後端，網頁刪不了別人的登入帳號，所以由 GitHub Actions 每小時對帳一次。
 *
 * 做的事（登入 email＝職編去掉開頭 0＋@kmuh.org.tw，與 src/lib/auth.tsx 的 staffEmail 同一規則）：
 * 1. 建立：名單有、Firebase 沒有帳號者 → 建立帳號（隨機密碼、無人知道）並寫入 role＝authenticated、
 *    staffId 標記；人員再於登入頁按「開通帳號」收認證連結自設密碼。已有帳號但缺標記者補標記。
 * 2. 停用／啟用：名單 status 為「停用」→ 停用登入帳號；改回在職 → 重新啟用。
 * 3. 刪除：Firebase 帳號（@kmuh.org.tw）對不到名單上的任何人 → 刪除，並刪除對應的
 *    Firestore users 文件。信箱開頭有 0 的舊格式帳號也會因此被清掉。
 * 4. --prune-firestore（手動，會逐筆讀 Firestore）：Firestore users 中名單沒有的文件一併刪除。
 *
 * 保護：admin@kmuh.org.tw 與環境變數 KEEP_EMAILS（逗號分隔）永遠保留；非 @kmuh.org.tw 的帳號不動。
 * 安全上限：名單讀取失敗或為空 → 什麼都不做並失敗；一次要刪的帳號超過 --max-delete（預設 20）
 * → 整批都不刪並失敗，需人工確認後以更大的 --max-delete 手動執行。
 * 沒有 SUPABASE_URL／SUPABASE_SERVICE_ROLE_KEY 時改讀 Firestore users，且「只建立不刪除」。
 *
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *   export SUPABASE_URL=https://<ref>.supabase.co  SUPABASE_SERVICE_ROLE_KEY=<service_role>
 *   npx tsx scripts/provision-auth-accounts.mts --dry-run            # 先預覽
 *   選項：--max=N 單次最多建立（預設 500）、--max-delete=N 單次最多刪除（預設 20）、--prune-firestore
 */
import { randomBytes } from "node:crypto";
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth, type UserRecord } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const MAIL_DOMAIN = "kmuh.org.tw";
const ADMIN_EMAIL = `admin@${MAIL_DOMAIN}`;
const dry = process.argv.includes("--dry-run");
const pruneFirestore = process.argv.includes("--prune-firestore");
const num = (name: string, dflt: number) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  const n = a ? Number(a.slice(name.length + 3)) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
const max = num("max", 500);
const maxDelete = num("max-delete", 20);
const keep = new Set(
  [ADMIN_EMAIL, ...(process.env.KEEP_EMAILS ?? "").split(",")]
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

initializeApp({ credential: applicationDefault() });
const auth = getAuth();
const db = getFirestore();

/** 與前端 staffMailLocal 一致：職編去掉開頭的 0；全是 0 時保留原值。 */
function mailLocal(id: string): string {
  const stripped = id.replace(/^0+/, "");
  return stripped === "" ? id : stripped;
}
/** 與前端 normalizeStaffId 一致：全形轉半形、去空白、取 @ 前。 */
function normalize(input: string): string {
  const folded = input.normalize("NFKC").replace(/\s+/g, "");
  const at = folded.indexOf("@");
  return at >= 0 ? folded.slice(0, at) : folded;
}

interface Person { id: string; status: string }

// ---------- 1) 讀名單（Supabase 為準；無金鑰時退回 Firestore，且不刪除） ----------
async function loadRosterFromSupabase(url: string, key: string): Promise<Person[]> {
  const out: Person[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(
      `${url}/rest/v1/docs?col=eq.users&deleted=eq.false&select=id,data&order=id&limit=${PAGE}&offset=${offset}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (!res.ok) throw new Error(`Supabase 讀取失敗 HTTP ${res.status}`);
    const rows = (await res.json()) as { id: string; data: { status?: string } | null }[];
    for (const r of rows) out.push({ id: r.id, status: String(r.data?.status ?? "") });
    if (rows.length < PAGE) break;
  }
  return out;
}
async function loadRosterFromFirestore(): Promise<Person[]> {
  const snap = await db.collection("users").select("status").get();
  return snap.docs.map((d) => ({ id: d.id, status: String(d.get("status") ?? "") }));
}

const sbUrl = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const authoritative = Boolean(sbUrl && sbKey);
let roster: Person[];
try {
  roster = authoritative ? await loadRosterFromSupabase(sbUrl, sbKey) : await loadRosterFromFirestore();
} catch (err) {
  console.error(`讀取人員名單失敗，不做任何變更：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
if (roster.length === 0) {
  console.error("人員名單是空的（或讀取不到），為避免誤刪全部帳號，不做任何變更。");
  process.exit(1);
}
if (!authoritative) console.log("⚠ 未設定 SUPABASE_URL／SUPABASE_SERVICE_ROLE_KEY：改讀 Firestore，只建立、不刪除。");

// ---------- 2) 現有 Firebase 帳號 ----------
const existing = new Map<string, UserRecord>();
let token: string | undefined;
do {
  const page = await auth.listUsers(1000, token);
  for (const u of page.users) if (u.email) existing.set(u.email.toLowerCase(), u);
  token = page.pageToken;
} while (token);

// 去掉開頭 0 後信箱相同者（衝突）
const byMail = new Map<string, string[]>();
for (const p of roster) {
  const k = mailLocal(p.id.trim());
  byMail.set(k, [...(byMail.get(k) ?? []), p.id]);
}

let created = 0, failed = 0, already = 0, backfilled = 0, disabled = 0, enabled = 0,
  invalid = 0, conflicts = 0, skippedInactive = 0;
const wanted = new Set<string>(); // 名單上每個人對應的信箱（小寫）

for (const p of roster) {
  const staffId = normalize(p.id);
  if (!staffId || staffId !== p.id.trim() || /[^\x21-\x7e]/.test(staffId)) {
    invalid++;
    console.log(`略過（職編格式不適合當信箱）：${p.id}`);
    continue;
  }
  const local = mailLocal(staffId);
  const clash = byMail.get(local) ?? [];
  if (clash.length > 1) {
    conflicts++;
    console.log(`略過（去掉開頭 0 後信箱相同，請確認職編）：${clash.join("、")}`);
    continue;
  }
  const email = `${local}@${MAIL_DOMAIN}`;
  wanted.add(email.toLowerCase());
  const found = existing.get(email.toLowerCase());
  const inactive = p.status === "停用";

  if (found) {
    already++;
    const claims = (found.customClaims ?? {}) as Record<string, unknown>;
    if (claims.staffId !== staffId || claims.role !== "authenticated") {
      backfilled++;
      console.log(`${dry ? "[dry-run] 將補標記" : "補標記"} ${staffId}`);
      if (!dry) await auth.setCustomUserClaims(found.uid, { ...claims, role: "authenticated", staffId });
    }
    if (inactive && !found.disabled) {
      disabled++;
      console.log(`${dry ? "[dry-run] 將停用" : "停用"} ${staffId}`);
      if (!dry) await auth.updateUser(found.uid, { disabled: true });
    } else if (!inactive && found.disabled) {
      enabled++;
      console.log(`${dry ? "[dry-run] 將啟用" : "啟用"} ${staffId}`);
      if (!dry) await auth.updateUser(found.uid, { disabled: false });
    }
    continue;
  }
  if (inactive) { skippedInactive++; continue; }
  if (created >= max) { console.log(`已達單次建立上限 ${max}，其餘留待下次執行`); continue; }
  if (dry) { created++; console.log(`[dry-run] 將建立 ${staffId}`); continue; }
  try {
    const user = await auth.createUser({
      email,
      password: randomBytes(24).toString("base64url"),
      emailVerified: false,
    });
    await auth.setCustomUserClaims(user.uid, { role: "authenticated", staffId });
    created++;
    console.log(`已建立 ${staffId}`);
  } catch (err) {
    failed++;
    console.log(`建立失敗 ${staffId}：${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------- 3) 刪除名單已不存在的帳號（只在名單來源可靠時） ----------
let deleted = 0, firestoreDeleted = 0, abortedDelete = false;
if (authoritative) {
  const orphans = [...existing.entries()].filter(
    ([email]) => email.endsWith(`@${MAIL_DOMAIN}`) && !keep.has(email) && !wanted.has(email),
  );
  if (orphans.length > maxDelete) {
    abortedDelete = true;
    console.error(
      `\n要刪除的帳號有 ${orphans.length} 個，超過安全上限 ${maxDelete}，整批都不刪。` +
        `請確認名單沒有被誤清空；確定無誤再手動執行並調高 --max-delete。`,
    );
    for (const [e] of orphans.slice(0, 30)) console.error(`  ${e}`);
    if (orphans.length > 30) console.error(`  …其餘 ${orphans.length - 30} 個`);
  } else {
    for (const [email, u] of orphans) {
      const claims = (u.customClaims ?? {}) as Record<string, unknown>;
      const sid = typeof claims.staffId === "string" && claims.staffId ? claims.staffId : (email.split("@")[0] ?? "");
      console.log(`${dry ? "[dry-run] 將刪除帳號" : "刪除帳號"} ${email}`);
      deleted++;
      if (dry) continue;
      try {
        await auth.deleteUser(u.uid);
        // 對應的 Firestore users 文件（名單已沒有這個人，才刪）
        if (sid && !roster.some((p) => p.id === sid)) {
          const ref = db.collection("users").doc(sid);
          if ((await ref.get()).exists) { await ref.delete(); firestoreDeleted++; }
        }
      } catch (err) {
        failed++;
        console.log(`刪除失敗 ${email}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ---------- 4) 手動：清掉 Firestore users 中名單沒有的文件 ----------
  if (pruneFirestore) {
    const rosterIds = new Set(roster.map((p) => p.id));
    const refs = await db.collection("users").listDocuments();
    const stale = refs.filter((r) => !rosterIds.has(r.id) && r.id !== "admin");
    if (stale.length > maxDelete * 10) {
      abortedDelete = true;
      console.error(`Firestore users 有 ${stale.length} 筆名單沒有的文件，超過安全上限，不刪除。`);
    } else {
      for (const r of stale) {
        console.log(`${dry ? "[dry-run] 將刪除" : "刪除"} Firestore users/${r.id}`);
        if (!dry) await r.delete();
        firestoreDeleted++;
      }
    }
  }
}

console.log(
  `\n名單 ${roster.length} 人：已有帳號 ${already}（${dry ? "將補標記" : "已補標記"} ${backfilled}），` +
    `${dry ? "將停用" : "已停用"} ${disabled}、${dry ? "將啟用" : "已啟用"} ${enabled}，` +
    `停用者不建立 ${skippedInactive}，格式不適合 ${invalid}，信箱衝突 ${conflicts}，` +
    `${dry ? "將建立" : "已建立"} ${created}，${dry ? "將刪除帳號" : "已刪除帳號"} ${deleted}，` +
    `Firestore users ${dry ? "將刪除" : "已刪除"} ${firestoreDeleted}，失敗 ${failed}。`,
);
if (dry) console.log("確認無誤後，拿掉 --dry-run 再執行一次。");
if (failed > 0 || abortedDelete) process.exitCode = 1;
