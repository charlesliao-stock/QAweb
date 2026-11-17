/**
 * 雙資料庫（Supabase 主／Firebase 備）共用的文件編碼。
 * 文件在佇列、Supabase jsonb 中一律用純 JSON 表示；
 * Timestamp 以 {"__t": 毫秒} 編碼，讀回時還原成 SbTimestamp（有 toDate／toMillis）。
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** 與 Firestore Timestamp 同介面的子集（呼叫端只用 toDate／toMillis／valueOf）。 */
export class SbTimestamp {
  constructor(readonly ms: number) {}
  toDate(): Date {
    return new Date(this.ms);
  }
  toMillis(): number {
    return this.ms;
  }
  get seconds(): number {
    return Math.floor(this.ms / 1000);
  }
  get nanoseconds(): number {
    return (this.ms % 1000) * 1e6;
  }
  valueOf(): number {
    return this.ms;
  }
}

/** serverTimestamp() 在雙寫模式的佔位值；寫入時以「同一個」毫秒值落到兩邊資料庫。 */
export class SbServerTimestamp {}

function isTimestampLike(v: unknown): v is { toMillis: () => number } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { toMillis?: unknown }).toMillis === "function"
  );
}

/** 應用層值 → JSON。undefined 欄位丟棄（Firestore 也不收 undefined）。 */
export function encode(v: unknown, nowMs: number): Json {
  if (v === null) return null;
  if (v instanceof SbServerTimestamp) return { __t: nowMs };
  if (v instanceof Date) return { __t: v.getTime() };
  if (isTimestampLike(v)) return { __t: v.toMillis() };
  if (Array.isArray(v)) return v.map((x) => encode(x === undefined ? null : x, nowMs));
  switch (typeof v) {
    case "string":
    case "boolean":
      return v;
    case "number":
      return Number.isFinite(v) ? v : null;
    case "object": {
      const out: { [k: string]: Json } = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (x === undefined) continue;
        out[k] = encode(x, nowMs);
      }
      return out;
    }
    default:
      return null;
  }
}

function isTsObj(v: unknown): v is { __t: number } {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v).length === 1 &&
    typeof (v as { __t?: unknown }).__t === "number"
  );
}

/** JSON → 應用層值（{__t} 還原為 SbTimestamp）。 */
export function decode(v: Json): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (isTsObj(v)) return new SbTimestamp(v.__t);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = decode(x);
    return out;
  }
  return v;
}

/** Firestore setDoc(..., {merge:true}) 的語意：物件遞迴合併，其餘整個覆蓋。 */
export function mergeDeep(prev: Json, patch: Json): Json {
  if (
    prev !== null && typeof prev === "object" && !Array.isArray(prev) && !isTsObj(prev) &&
    patch !== null && typeof patch === "object" && !Array.isArray(patch) && !isTsObj(patch)
  ) {
    const out: { [k: string]: Json } = { ...prev };
    for (const [k, x] of Object.entries(patch)) {
      out[k] = k in out ? mergeDeep(out[k] as Json, x) : x;
    }
    return out;
  }
  return patch;
}
