/**
 * 與 demoStore 同形的 Firestore 子集 API，背後是 DualStore（Supabase 主／Firebase 備）。
 * lib/db.ts 在「雙寫模式」時把 collection／doc／query／getDoc(s)／setDoc／updateDoc／
 * deleteDoc／writeBatch／serverTimestamp 轉呼叫本檔，其餘呼叫端不必改。
 */
import { decode, encode, mergeDeep, SbServerTimestamp, SbTimestamp, type Json } from "./codec";
import { DualStore } from "./dualStore";
import type { Op } from "./supabaseDocs";
import type { Query, Row, WhereC } from "./query";

export interface CollRef {
  __dual: "collection";
  path: string;
}
export interface DocRef {
  __dual: "doc";
  collPath: string;
  id: string;
  path: string;
}
export interface QueryRef extends Query {
  __dual: "query";
  collPath: string;
}
type Constraint =
  | { __dualQ: "where"; field: string; op: string; value: unknown }
  | { __dualQ: "orderBy"; field: string; dir: "asc" | "desc" }
  | { __dualQ: "limit"; n: number }
  | { __dualQ: "startAfter"; id: string };

export interface DocSnap {
  id: string;
  ref: DocRef;
  exists: () => boolean;
  data: () => Record<string, unknown> | undefined;
}
export interface QuerySnap {
  docs: DocSnap[];
  empty: boolean;
  size: number;
  forEach: (cb: (d: DocSnap) => void) => void;
}

let store: DualStore | null = null;
export function installDualStore(s: DualStore): void {
  store = s;
}
export function getDualStore(): DualStore {
  if (!store) throw new Error("DualStore 尚未初始化");
  return store;
}
export const isDualInstalled = (): boolean => store !== null;

function genId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function collection(...path: string[]): CollRef {
  return { __dual: "collection", path: path.join("/") };
}

/** 對應 doc(db, ...segments)／doc(collRef)／doc(collRef, id)。 */
export function docOf(first: unknown, ...segments: string[]): DocRef {
  const r = first as Partial<CollRef> | null;
  let collPath: string;
  let id: string;
  if (r && r.__dual === "collection" && typeof r.path === "string") {
    collPath = r.path;
    id = segments[0] ?? genId();
  } else {
    id = segments[segments.length - 1] ?? genId();
    collPath = segments.slice(0, -1).join("/");
  }
  return { __dual: "doc", collPath, id, path: `${collPath}/${id}` };
}

export const where = (field: string, op: string, value: unknown): Constraint => ({ __dualQ: "where", field, op, value });
export const orderBy = (field: string, dir: "asc" | "desc" = "asc"): Constraint => ({ __dualQ: "orderBy", field, dir });
export const limit = (n: number): Constraint => ({ __dualQ: "limit", n });
export const startAfter = (snap: { id?: string } | null | undefined): Constraint => ({ __dualQ: "startAfter", id: snap?.id ?? "" });
export const serverTimestamp = (): SbServerTimestamp => new SbServerTimestamp();
export const timestampFromMs = (ms: number): SbTimestamp => new SbTimestamp(ms);

export function query(ref: CollRef, ...cs: unknown[]): QueryRef {
  const q: QueryRef = { __dual: "query", collPath: ref.path, wheres: [], orderBys: [] };
  for (const c of cs as Array<Constraint | null>) {
    if (!c || typeof (c as { __dualQ?: string }).__dualQ !== "string") continue;
    if (c.__dualQ === "where") {
      q.wheres.push({ field: c.field, op: c.op, value: encode(c.value, 0) } as WhereC);
    } else if (c.__dualQ === "orderBy") q.orderBys.push({ field: c.field, dir: c.dir });
    else if (c.__dualQ === "limit") q.limitN = c.n;
    else if (c.__dualQ === "startAfter") q.startAfterId = c.id;
  }
  return q;
}

function snapOf(collPath: string, id: string, row: Row | null): DocSnap {
  const ref = docOf(collection(collPath), id);
  const data = row ? (decode(row.data) as Record<string, unknown>) : undefined;
  return { id, ref, exists: () => data !== undefined, data: () => data };
}

function toQuery(ref: CollRef | QueryRef): { collPath: string; q: Query } {
  if (ref.__dual === "query") return { collPath: ref.collPath, q: ref };
  return { collPath: ref.path, q: { wheres: [], orderBys: [] } };
}

export async function getDoc(ref: DocRef): Promise<DocSnap> {
  const r = await getDualStore().get(ref.collPath, ref.id);
  return snapOf(ref.collPath, ref.id, r.value);
}

export async function getDocs(ref: CollRef | QueryRef): Promise<QuerySnap> {
  const { collPath, q } = toQuery(ref);
  const r = await getDualStore().list(collPath, q);
  const docs = r.value.map((row) => snapOf(collPath, row.id, row));
  return { docs, empty: docs.length === 0, size: docs.length, forEach: (cb) => docs.forEach(cb) };
}

export async function getCount(ref: CollRef | QueryRef): Promise<number> {
  return (await getDocs(ref)).size;
}

// ---------- 寫入：一律先解析成最終整份文件，再交給 DualStore.commit ----------
type Staged =
  | { kind: "set"; ref: DocRef; data: Record<string, unknown>; merge: boolean }
  | { kind: "update"; ref: DocRef; data: Record<string, unknown> }
  | { kind: "del"; ref: DocRef };

async function resolve(staged: Staged[]): Promise<Op[]> {
  const ds = getDualStore();
  const ts = ds.tick();
  // 同一批內對同一文件的多次操作要依序累積
  const working = new Map<string, Json | null>();
  const ops = new Map<string, Op>();
  for (const s of staged) {
    const k = s.ref.path;
    if (s.kind === "del") {
      working.set(k, null);
      ops.set(k, { col: s.ref.collPath, id: s.ref.id, kind: "del", ts });
      continue;
    }
    const patch = encode(s.data, ts);
    let prev: Json | null;
    if (working.has(k)) prev = working.get(k) ?? null;
    else if (s.kind === "update" || s.merge) prev = (await ds.get(s.ref.collPath, s.ref.id)).value?.data ?? null;
    else prev = null;
    let next: Json;
    if (s.kind === "update") {
      if (prev === null) throw new Error(`updateDoc：文件不存在 ${k}`);
      next = { ...(prev as Record<string, Json>), ...(patch as Record<string, Json>) };
    } else if (s.merge && prev !== null) next = mergeDeep(prev, patch);
    else next = patch;
    working.set(k, next);
    ops.set(k, { col: s.ref.collPath, id: s.ref.id, kind: "set", ts, data: next });
  }
  return [...ops.values()];
}

export async function setDoc(ref: DocRef, data: Record<string, unknown>, options?: { merge?: boolean }): Promise<void> {
  await getDualStore().commit(await resolve([{ kind: "set", ref, data, merge: options?.merge === true }]));
}
export async function updateDoc(ref: DocRef, data: Record<string, unknown>): Promise<void> {
  await getDualStore().commit(await resolve([{ kind: "update", ref, data }]));
}
export async function deleteDoc(ref: DocRef): Promise<void> {
  await getDualStore().commit(await resolve([{ kind: "del", ref }]));
}

export interface DualBatch {
  set: (ref: DocRef, data: Record<string, unknown>, options?: { merge?: boolean }) => DualBatch;
  update: (ref: DocRef, data: Record<string, unknown>) => DualBatch;
  delete: (ref: DocRef) => DualBatch;
  commit: () => Promise<void>;
}

export function writeBatch(): DualBatch {
  const staged: Staged[] = [];
  const b: DualBatch = {
    set: (ref, data, options) => (staged.push({ kind: "set", ref, data, merge: options?.merge === true }), b),
    update: (ref, data) => (staged.push({ kind: "update", ref, data }), b),
    delete: (ref) => (staged.push({ kind: "del", ref }), b),
    commit: async () => {
      await getDualStore().commit(await resolve(staged));
    },
  };
  return b;
}
