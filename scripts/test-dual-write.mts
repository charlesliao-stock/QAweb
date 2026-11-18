/**
 * 雙寫＋故障轉移斷言測試（假 PostgREST＋假 Firestore，不連真實資料庫）。
 * 執行：npx tsx scripts/test-dual-write.mts
 */
import assert from "node:assert/strict";
import { DualStore } from "../src/lib/dual/dualStore";
import { supabaseDocs } from "../src/lib/dual/supabaseDocs";
import { firestoreDocs, type FirestoreSdk } from "../src/lib/dual/firestoreDocs";
import { runQuery } from "../src/lib/dual/query";
import { encode, SbTimestamp } from "../src/lib/dual/codec";
import * as db from "../src/lib/dual/dualDb";
import { describeHealth, formatBytes, level, pct, SUPABASE_LIMITS } from "../src/lib/dual/status";

// ---------- 假 PostgREST ----------
const contains = (a: any, b: any): boolean => {
  if (Array.isArray(b)) return Array.isArray(a) && b.every((x) => a.some((y) => contains(y, x)));
  if (b && typeof b === "object") return a && typeof a === "object" && Object.entries(b).every(([k, v]) => contains(a[k], v));
  return a === b;
};
function fakeSupabase() {
  const rows = new Map<string, { col: string; id: string; data: any; ts: number; deleted: boolean }>();
  const state = { down: false, urls: [] as string[], rpcCalls: 0, reply: null as null | { status: number; body: unknown } };
  const fetchImpl = (async (input: any, init?: any) => {
    const url = String(input);
    state.urls.push(url);
    if (state.down) return new Response("boom", { status: 503 });
    if (state.reply) return new Response(JSON.stringify(state.reply.body), { status: state.reply.status });
    const u = new URL(url);
    if (u.pathname.endsWith("/rpc/apply_ops")) {
      state.rpcCalls++;
      const ops = JSON.parse(init.body).p_ops;
      for (const op of ops) {
        const k = `${op.col}|${op.id}`;
        const cur = rows.get(k);
        if (op.kind === "set") {
          if (!cur || cur.ts < op.ts) rows.set(k, { col: op.col, id: op.id, data: op.data, ts: op.ts, deleted: false });
        } else if (cur && cur.ts < op.ts) {
          rows.set(k, { ...cur, data: { ...cur.data, _dualTombstone: true, _dualTs: op.ts }, ts: op.ts, deleted: true });
        }
      }
      return new Response("1", { status: 200 });
    }
    const p = u.searchParams;
    let out = [...rows.values()].filter((r) => r.col === p.get("col")!.slice(3) && !r.deleted);
    if (p.get("id")) out = out.filter((r) => r.id === p.get("id")!.slice(3));
    if (p.get("data")) out = out.filter((r) => contains(r.data, JSON.parse(p.get("data")!.slice(3))));
    if (p.get("or")) {
      const alts = [...p.get("or")!.matchAll(/data\.cs\.(\{[^}]*\})/g)].map((m) => JSON.parse(m[1]!));
      out = out.filter((r) => alts.some((a) => contains(r.data, a)));
    }
    out.sort((a, b) => (a.id < b.id ? -1 : 1));
    const off = Number(p.get("offset") ?? 0), lim = Number(p.get("limit") ?? 1000);
    return new Response(JSON.stringify(out.slice(off, off + lim).map(({ id, ts, data }) => ({ id, ts, data }))), { status: 200 });
  }) as typeof fetch;
  return { rows, state, fetchImpl };
}

// ---------- 假 Firestore SDK ----------
function fakeFirestore() {
  const m = new Map<string, any>();
  const st = { down: false, reads: 0, writes: 0 };
  const Timestamp = { fromMillis: (ms: number) => ({ __fsTs: true, ms, toMillis: () => ms }) };
  const guard = () => { if (st.down) throw new Error("firebase down"); };
  const sdk: FirestoreSdk = {
    db: {},
    collection: (_db: any, ...p: string[]) => ({ kind: "c", path: p.join("/") }),
    doc: (_db: any, ...p: string[]) => ({ kind: "d", path: p.join("/"), id: p[p.length - 1], coll: p.slice(0, -1).join("/") }),
    getDoc: async (ref: any) => { guard(); st.reads++; const d = m.get(ref.path); return { id: ref.id, exists: () => d !== undefined, data: () => d }; },
    getDocs: async (q: any) => {
      guard();
      const rows = [...m.entries()].filter(([k]) => k.startsWith(q.coll + "/") && !k.slice(q.coll.length + 1).includes("/"))
        .map(([k, v]) => ({ id: k.slice(q.coll.length + 1), ts: 0, data: encode(v, 0) }));
      const res = runQuery(rows, q.spec);
      st.reads += res.length;
      return { docs: res.map((r) => ({ id: r.id, data: () => m.get(`${q.coll}/${r.id}`) })) };
    },
    query: (c: any, ...cs: any[]) => {
      const spec: any = { wheres: [], orderBys: [] };
      for (const x of cs) {
        if (x.t === "w") spec.wheres.push({ field: x.f, op: x.o, value: encode(x.v, 0) });
        else if (x.t === "o") spec.orderBys.push({ field: x.f, dir: x.d });
        else if (x.t === "l") spec.limitN = x.n;
        else if (x.t === "s") spec.startAfterId = x.id;
      }
      return { coll: c.path, spec };
    },
    where: (f: string, o: string, v: any) => ({ t: "w", f, o, v }),
    orderBy: (f: string, d: string) => ({ t: "o", f, d }),
    limit: (n: number) => ({ t: "l", n }),
    startAfter: (s: any) => ({ t: "s", id: s.id }),
    writeBatch: () => {
      const ops: Array<() => void> = [];
      return {
        set: (r: any, d: any) => ops.push(() => m.set(r.path, d)),
        delete: (r: any) => ops.push(() => m.delete(r.path)),
        commit: async () => { guard(); st.writes += ops.length; ops.forEach((f) => f()); },
      };
    },
    Timestamp,
  };
  return { m, st, sdk };
}

let clock = 1_000_000;
function setup() {
  const sb = fakeSupabase();
  const fs = fakeFirestore();
  const store = new DualStore({
    primary: supabaseDocs({ url: "https://x.supabase.co/rest/v1/", apiKey: "k", fetchImpl: sb.fetchImpl }),
    secondary: firestoreDocs(fs.sdk),
    now: () => clock,
    timeoutMs: 500,
    breakerThreshold: 2,
    breakerCooldownMs: 1000,
  });
  db.installDualStore(store);
  return { sb, fs, store };
}
const advance = (ms: number) => { clock += ms; };

const tests: Array<[string, () => Promise<void>]> = [];
const test = (n: string, f: () => Promise<void>) => tests.push([n, f]);

test("1 setDoc 先寫 Supabase，drain 後 Firebase 也有；時間戳兩邊一致", async () => {
  const { sb, fs, store } = setup();
  await db.setDoc(db.docOf(null, "indicators", "i1"), { name: "跌倒率", at: db.serverTimestamp(), n: 3 });
  await store.drain();
  const row = sb.rows.get("indicators|i1")!;
  assert.equal(row.data.name, "跌倒率");
  const fsDoc = fs.m.get("indicators/i1");
  assert.equal(fsDoc.at.toMillis(), row.data.at.__t);       // 同一個毫秒值
  assert.equal(fsDoc.at.__fsTs, true);                        // Firebase 端是真 Timestamp
  const snap = await db.getDoc(db.docOf(null, "indicators", "i1"));
  assert.equal(snap.exists(), true);
  assert.ok(snap.data()!.at instanceof SbTimestamp);
  assert.equal(store.pending().length, 0);
});

test("2 查詢：== 下推、in／array-contains、範圍、排序、limit、游標", async () => {
  const { sb, store } = setup();
  const b = db.writeBatch();
  const mk = (id: string, o: any) => b.set(db.docOf(null, "reviewTasks", id), o);
  mk("a", { unit: "U1", tags: ["x"], score: 5, at: db.timestampFromMs(100) });
  mk("b", { unit: "U1", tags: ["y"], score: 9, at: db.timestampFromMs(300) });
  mk("c", { unit: "U2", tags: ["x", "y"], score: 7, at: db.timestampFromMs(200) });
  mk("d", { unit: "U3", tags: [], score: 1, at: db.timestampFromMs(400) });
  await b.commit();
  const C = db.collection("reviewTasks");
  const ids = async (q: any) => (await db.getDocs(q)).docs.map((d) => d.id);
  sb.state.urls.length = 0;
  assert.deepEqual(await ids(db.query(C, db.where("unit", "==", "U1"))), ["a", "b"]);
  assert.ok(sb.state.urls.some((u) => decodeURIComponent(u).includes('data=cs.{"unit":"U1"}')), "== 應下推到 PostgREST");
  assert.deepEqual(await ids(db.query(C, db.where("unit", "in", ["U2", "U3"]))), ["c", "d"]);
  assert.deepEqual(await ids(db.query(C, db.where("tags", "array-contains", "y"))), ["b", "c"]);
  assert.deepEqual(await ids(db.query(C, db.where("score", ">=", 7))), ["b", "c"]);
  assert.deepEqual(await ids(db.query(C, db.where("at", ">=", db.timestampFromMs(250)))), ["b", "d"]);
  assert.deepEqual(await ids(db.query(C, db.where("unit", "!=", "U1"))), ["c", "d"]);
  assert.deepEqual(await ids(db.query(C, db.orderBy("score", "desc"), db.limit(2))), ["b", "c"]);
  const page1 = await db.getDocs(db.query(C, db.orderBy("score", "desc"), db.limit(2)));
  const page2 = await db.getDocs(db.query(C, db.orderBy("score", "desc"), db.startAfter(page1.docs[1]), db.limit(2)));
  assert.deepEqual(page2.docs.map((d) => d.id), ["a", "d"]);
  assert.equal(await db.getCount(db.query(C, db.where("unit", "==", "U1"))), 2);
  void store;
});

test("3 setDoc merge／updateDoc 語意；updateDoc 對不存在文件要丟錯", async () => {
  const { sb } = setup();
  const ref = db.docOf(null, "users", "u1");
  await db.setDoc(ref, { name: "王", prefs: { a: 1, b: 2 }, roles: ["x"] });
  await db.setDoc(ref, { prefs: { b: 9 } }, { merge: true });
  assert.deepEqual(sb.rows.get("users|u1")!.data, { name: "王", prefs: { a: 1, b: 9 }, roles: ["x"] });
  await db.updateDoc(ref, { name: "李", roles: ["y", "z"] });
  assert.deepEqual(sb.rows.get("users|u1")!.data, { name: "李", prefs: { a: 1, b: 9 }, roles: ["y", "z"] });
  await assert.rejects(db.updateDoc(db.docOf(null, "users", "nope"), { a: 1 }), /不存在/);
});

test("4 writeBatch 對 Supabase 只打一次 RPC（單一交易），同文件多次操作累積", async () => {
  const { sb } = setup();
  const b = db.writeBatch();
  b.set(db.docOf(null, "t", "1"), { v: 1 }).update(db.docOf(null, "t", "1"), { w: 2 }).set(db.docOf(null, "t", "2"), { v: 2 });
  await b.commit();
  assert.equal(sb.state.rpcCalls, 1);
  assert.deepEqual(sb.rows.get("t|1")!.data, { v: 1, w: 2 });
});

test("5 deleteDoc 兩邊都刪", async () => {
  const { sb, fs, store } = setup();
  await db.setDoc(db.docOf(null, "t", "1"), { v: 1 }); await store.drain();
  advance(10);
  await db.deleteDoc(db.docOf(null, "t", "1")); await store.drain();
  assert.equal(sb.rows.get("t|1")!.deleted, true); assert.equal(fs.m.has("t/1"), false);
  assert.equal((await db.getDoc(db.docOf(null, "t", "1"))).exists(), false);
});

test("6 備庫掛掉：使用者寫入照常成功，佇列補送", async () => {
  const { sb, fs, store } = setup();
  fs.st.down = true;
  await db.setDoc(db.docOf(null, "t", "1"), { v: 1 });
  await store.drain();
  assert.equal(sb.rows.has("t|1"), true);
  assert.equal(store.pending("firebase").length, 1);
  fs.st.down = false; advance(120_000); await store.drain();
  assert.equal(fs.m.get("t/1").v, 1);
  assert.equal(store.pending().length, 0);
});

test("7 主庫掛掉：寫入轉移到 Firebase、讀取走 Firebase；恢復後回補 Supabase", async () => {
  const { sb, fs, store } = setup();
  sb.state.down = true;
  await db.setDoc(db.docOf(null, "t", "1"), { v: 1, at: db.serverTimestamp() });
  assert.equal(fs.m.get("t/1").v, 1);
  const snap = await db.getDoc(db.docOf(null, "t", "1"));
  assert.equal(snap.data()!.v, 1);                                    // 讀備庫
  const lst = await db.getDocs(db.collection("t"));
  assert.equal(lst.size, 1);
  sb.state.down = false; advance(120_000); await store.drain();
  assert.equal(sb.rows.get("t|1")!.data.v, 1);                         // 回補
  assert.equal(store.pending().length, 0);
  assert.equal((await store.get("t", "1")).source, "supabase");
});

test("8 兩邊都掛：寫入丟錯、不吞資料", async () => {
  const { sb, fs } = setup();
  sb.state.down = true; fs.st.down = true;
  await assert.rejects(db.setDoc(db.docOf(null, "t", "1"), { v: 1 }), /寫入失敗/);
});

test("9 過時的 set 和被刪資料的舊 set 都不能復活文件", async () => {
  const { sb, store } = setup();
  await db.setDoc(db.docOf(null, "t", "1"), { v: "new" });
  const adapter = store.p;
  await adapter.apply([{ col: "t", id: "1", kind: "set", ts: 1, data: { v: "old" } }]);
  assert.equal(sb.rows.get("t|1")!.data.v, "new");
  await adapter.apply([{ col: "t", id: "1", kind: "del", ts: clock + 100 }]);
  await adapter.apply([{ col: "t", id: "1", kind: "set", ts: clock + 50, data: { v: "stale" } }]);
  assert.equal(sb.rows.get("t|1")!.deleted, true);
  assert.equal((await adapter.get("t", "1")), null);
});

test("10 佇列可持久化：重新載入後仍在", async () => {
  const sb = fakeSupabase(), fs = fakeFirestore();
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  const mk = () => new DualStore({ primary: supabaseDocs({ url: "https://x.supabase.co", apiKey: "k", fetchImpl: sb.fetchImpl }), secondary: firestoreDocs(fs.sdk), storage, now: () => clock, timeoutMs: 500 });
  const a = mk(); db.installDualStore(a);
  fs.st.down = true; await db.setDoc(db.docOf(null, "t", "1"), { v: 1 });
  assert.equal(mk().pending("firebase").length, 1);
});

test("11 規則拒絕（QA403）：丟錯給使用者，不轉移、不開斷路器、不寫備庫", async () => {
  const { sb, fs, store } = setup();
  sb.state.reply = { status: 400, body: { code: "QA403", message: "permission denied: INSERT on t/1" } };
  for (let i = 0; i < 5; i++) {
    await assert.rejects(db.setDoc(db.docOf(null, "t", String(i)), { v: 1 }), /QA403/);
  }
  assert.equal(fs.m.size, 0);                 // 沒有轉移到 Firebase
  assert.equal(store.mode(), "primary");      // 斷路器沒開（門檻只有 2，卻連錯 5 次）
  assert.equal(store.pending().length, 0);
});

test("12 認證拒絕（401/403）不會繞過主庫權限寫入備庫", async () => {
  const { sb, fs, store } = setup();
  for (const status of [401, 403]) {
    sb.state.reply = { status, body: { code: status === 401 ? "PGRST301" : "42501", message: "authorization denied" } };
    await assert.rejects(db.setDoc(db.docOf(null, "t", String(status)), { v: 1 }));
  }
  assert.equal(fs.m.size, 0);
  assert.equal(store.pending().length, 0);
  assert.equal(store.mode(), "primary");
});

test("13 補送時遇到規則拒絕：直接進死信，不無限重試", async () => {
  const { sb, store } = setup();
  const dead: unknown[] = [];
  (store as any).onEvent = (e: any) => { if (e.type === "dead-letter") dead.push(e); };
  sb.state.reply = { status: 503, body: { code: "PGRST503" } };
  await db.setDoc(db.docOf(null, "t", "1"), { v: 1 });          // 轉移到 Firebase，排入回補
  await store.drain();                                           // 等背景那一輪結束（它會因 401 而退避）
  sb.state.reply = { status: 400, body: { code: "QA403", message: "denied" } };
  advance(120_000); await store.drain();
  assert.equal(store.pending().length, 0);
  assert.equal(dead.length, 1);
  assert.equal(store.health().deadLetters, 1); // dead letter remains durable, not dropped
  sb.state.reply = null;
  assert.equal(store.retryDeadLetters("supabase"), 1);
  advance(120_000); await store.drain();
  assert.equal(store.health().deadLetters, 0);
  assert.equal(store.pending().length, 0);
  assert.equal(sb.rows.has("t|1"), true);
});

test("14 health()／describeHealth：正常、備庫失聯、故障轉移三種狀態的說明", async () => {
  const { sb, fs, store } = setup();
  let h = store.health();
  assert.equal(h.mode, "primary");
  assert.equal(describeHealth(h).tone, "ok");
  assert.match(describeHealth(h).text, /Supabase.*Firebase.*正常/);

  fs.st.down = true;                                   // 備援失聯 → 警告，主庫仍服務
  for (let i = 0; i < 3; i++) { await db.setDoc(db.docOf(null, "t", String(i)), { v: i }); await store.drain(); advance(5000); }
  h = store.health();
  assert.equal(h.mode, "primary");
  assert.equal(describeHealth(h).tone, "warn");
  assert.ok(h.pendingToSecondary >= 1);

  fs.st.down = false; await store.drain();
  sb.state.down = true;                                // 主庫失聯 → 故障轉移
  for (let i = 0; i < 3; i++) { await db.setDoc(db.docOf(null, "u", String(i)), { v: i }).catch(() => {}); advance(5000); }
  h = store.health();
  assert.equal(h.mode, "failover");
  assert.equal(describeHealth(h).tone, "bad");
  assert.match(describeHealth(h).text, /備援 Firebase 服務/);
  assert.ok(h.pendingToPrimary >= 1);
});

test("15 用量百分比、門檻、容量格式", async () => {
  assert.equal(pct(250 * 1024 * 1024, SUPABASE_LIMITS.dbBytes), 50);
  assert.equal(pct(5, 0), 0);
  assert.equal(level(79.9), "ok"); assert.equal(level(80), "warn"); assert.equal(level(95), "stop");
  assert.equal(formatBytes(1536), "1.5 KB"); assert.equal(formatBytes(500 * 1024 * 1024), "500.0 MB");
});

let failed = 0;
for (const [n, f] of tests) {
  try { await f(); console.log("PASS", n); } catch (e) { failed++; console.log("FAIL", n, "\n   ", (e as Error).message); }
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
