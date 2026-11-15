/**
 * 讀取量實測計數器（v1.73.0）：統計「本分頁」自開啟（或按重置）起，
 * 各集合實際向伺服器讀了幾份文件，供系統管理「流量控管」比對封存摘要前後的差異。
 * - 只計經 lib/db 的 getDoc／getDocs／getDocsFromServer；
 * - 本機快取命中（fromCache）不計費，另列「快取命中」；
 * - 空結果的查詢 Firestore 仍計 1 次讀取，併入「(空結果)」。
 * 只存記憶體，不寫 Firestore、不增加讀寫。
 */
export interface ReadMeterRow {
  name: string;
  billed: number;
  cached: number;
  calls: number;
}

const rows = new Map<string, ReadMeterRow>();
const listeners = new Set<() => void>();
let since = Date.now();

function bump(name: string, billed: number, cached: number): void {
  const row = rows.get(name) ?? { name, billed: 0, cached: 0, calls: 0 };
  row.billed += billed;
  row.cached += cached;
  row.calls += 1;
  rows.set(name, row);
  listeners.forEach((fn) => fn());
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function recordQueryRead(snap: any): void {
  try {
    const docs: any[] = snap?.docs ?? [];
    const fromCache = snap?.metadata?.fromCache === true;
    const name = docs[0]?.ref?.parent?.id ?? "(空結果)";
    if (fromCache) bump(name, 0, docs.length);
    else bump(name, Math.max(1, docs.length), 0);
  } catch {
    /* 計數失敗不影響讀取 */
  }
}

export function recordDocRead(snap: any): void {
  try {
    const name = snap?.ref?.parent?.id ?? "(單一文件)";
    if (snap?.metadata?.fromCache === true) bump(name, 0, 1);
    else bump(name, 1, 0);
  } catch {
    /* 同上 */
  }
}

export function getReadMeter(): { rows: ReadMeterRow[]; total: number; since: number } {
  const list = [...rows.values()].sort((a, b) => b.billed - a.billed);
  return { rows: list, total: list.reduce((s, r) => s + r.billed, 0), since };
}

export function resetReadMeter(): void {
  rows.clear();
  since = Date.now();
  listeners.forEach((fn) => fn());
}

export function subscribeReadMeter(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
