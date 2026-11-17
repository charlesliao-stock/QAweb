/**
 * 一次性搬遷：Firestore 全部文件 → Supabase public.docs。可重複執行（冪等，不會蓋掉較新的資料）。
 *
 * 在「你自己的電腦」執行（需要金鑰，絕對不要提交或貼給別人）：
 *   npm install --no-save firebase-admin tsx
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/firebase-service-account.json
 *   export SUPABASE_URL=https://<project-ref>.supabase.co
 *   export SUPABASE_SERVICE_ROLE_KEY=<後台 Project Settings → API 的 service_role>   # 只放環境變數
 *   npx tsx scripts/migrate-firestore-to-supabase.mts --dry-run        # 只預估讀取量與文件數
 *   npx tsx scripts/migrate-firestore-to-supabase.mts --yes            # 真的搬
 *   npx tsx scripts/migrate-firestore-to-supabase.mts --verify         # 搬完比對兩邊筆數
 *
 * ⚠ 讀取額度：整個搬遷會把每份文件讀一次。Spark 每天 50,000 次讀取，
 *   預設超過 20,000 份就不放行（--max-reads 可調）；太大就用 --collections 分天搬。
 *   也請先關閉會大量讀取的流程，並留意流量監測不要因此觸發關站（95%）。
 * 每份文件的版本時鐘（ts）取 Firestore 的最後更新時間，之後前端的新寫入一定比它新。
 */
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore, type DocumentData } from "firebase-admin/firestore";
import { encode } from "../src/lib/dual/codec";
import type { Op } from "../src/lib/dual/supabaseDocs";

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(`--${n}`);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dry = flag("dry-run");
const verify = flag("verify");
const maxReads = Number(opt("max-reads") ?? 20000);
const only = opt("collections")?.split(",").map((x) => x.trim()).filter(Boolean);
/** 這些集合的文件底下還有子集合（rules 裡的 indicators/{id}/versions）。 */
const WITH_SUBCOLLECTIONS = new Set(["indicators"]);

const SB_URL = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!SB_URL || !SB_KEY) { console.error("缺少 SUPABASE_URL／SUPABASE_SERVICE_ROLE_KEY 環境變數"); process.exit(1); }
const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

initializeApp({ credential: applicationDefault() });
const fs: Firestore = getFirestore();

async function countOf(path: string): Promise<number> {
  const s = await fs.collection(path).count().get(); // 聚合計數：約每 1000 筆計 1 次讀取
  return s.data().count;
}

async function sbCount(col: string): Promise<number> {
  const r = await fetch(`${SB_URL}/rest/v1/docs?col=eq.${encodeURIComponent(col)}&select=id`, {
    headers: { ...sbHeaders, Prefer: "count=exact", Range: "0-0" },
  });
  const m = /\/(\d+)$/.exec(r.headers.get("content-range") ?? "");
  if (!r.ok || !m) throw new Error(`Supabase 計數失敗 ${r.status}`);
  return Number(m[1]);
}

async function upload(ops: Op[]): Promise<void> {
  for (let i = 0; i < ops.length; i += 200) {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/apply_ops`, {
      method: "POST", headers: sbHeaders, body: JSON.stringify({ p_ops: ops.slice(i, i + 200) }),
    });
    if (!r.ok) throw new Error(`apply_ops ${r.status} ${(await r.text()).slice(0, 300)}`);
  }
}

/** 列出要搬的集合路徑（含子集合）。 */
async function collectionPaths(): Promise<string[]> {
  const top = (await fs.listCollections()).map((c) => c.id).filter((id) => !only || only.includes(id));
  const out = [...top];
  for (const id of top.filter((t) => WITH_SUBCOLLECTIONS.has(t))) {
    for (const d of await fs.collection(id).listDocuments()) {
      for (const sub of await d.listCollections()) out.push(`${id}/${d.id}/${sub.id}`);
    }
  }
  return out;
}

const paths = await collectionPaths();
console.log(`集合 ${paths.length} 個：${paths.join("、")}\n`);

const counts: Record<string, number> = {};
let total = 0;
for (const p of paths) { counts[p] = await countOf(p); total += counts[p]!; }
console.table(counts);
console.log(`文件總數 ${total}；實際搬遷約耗 ${total} 次 Firestore 讀取（Spark 每日 50,000）。`);

if (verify) {
  const rows: Record<string, { firestore: number; supabase: number; ok: boolean }> = {};
  for (const p of paths) { const s = await sbCount(p); rows[p] = { firestore: counts[p]!, supabase: s, ok: s === counts[p] }; }
  console.table(rows);
  process.exit(Object.values(rows).every((r) => r.ok) ? 0 : 2);
}
if (dry) { console.log("[dry-run] 到此為止，沒有讀取任何文件、沒有寫入。"); process.exit(0); }
if (total > maxReads) { console.error(`超過 --max-reads ${maxReads}，已中止。請用 --collections 分批，或確認額度後調高 --max-reads。`); process.exit(3); }
if (!flag("yes")) { console.error("尚未加 --yes，未執行。"); process.exit(4); }

let moved = 0;
for (const p of paths) {
  let last: string | undefined;
  for (;;) {
    let q = fs.collection(p).orderBy("__name__").limit(500);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    const ops: Op[] = snap.docs.map((d) => ({
      col: p, id: d.id, kind: "set" as const,
      ts: d.updateTime.toMillis(),
      data: encode(d.data() as DocumentData, d.updateTime.toMillis()),
    }));
    await upload(ops);
    moved += ops.length;
    last = snap.docs[snap.docs.length - 1]!.id;
    process.stdout.write(`\r${p}: 已搬 ${moved}/${total}   `);
  }
}
console.log(`\n完成：搬了 ${moved} 份文件。接著執行 --verify 比對筆數。`);
