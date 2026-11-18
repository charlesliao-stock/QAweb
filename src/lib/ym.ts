/**
 * 年月／日期的共用小工具（各處原本各自手寫的 padStart、"年-月" key 集中於此）。
 * 純函式、無相依，可被 lib 與 features 任意引用。
 */

/** 補零到兩位：3 → "03" */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 年月 key（不補零）：2026, 3 → "2026-3"（封存摘要、稽核可見範圍等用） */
export function ymKeyOf(year: number, month: number): string {
  return `${year}-${month}`;
}

/**
 * "YYYY-MM" → 可比較的年月序號（年*12＋月-1）；格式非法／月份超出 1–12 回 null。
 * v1.88.14：審查進度追蹤起迄月份篩選用。
 */
export function parseYmOrder(value: string): number | null {
  const m = /^(\d{4})-(\d{1,2})$/.exec(value ?? "");
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return Number(m[1]) * 12 + (month - 1);
}

/**
 * 年月是否落在 [起，迄] 區間內（起、迄為 parseYmOrder 的序號；起＞迄時自動交換）。
 * v1.88.14：審查進度追蹤起迄月份篩選用。
 */
export function ymInRange(
  year: number,
  month: number,
  from: number | null,
  to: number | null,
): boolean {
  if (from == null || to == null) return false;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const k = year * 12 + (month - 1);
  return k >= lo && k <= hi;
}

/** 年月字串（月份補零，符合 <input type="month">）：2026, 3 → "2026-03" */
export function ymPadded(year: number, month: number): string {
  return `${year}-${pad2(month)}`;
}

/** 年月顯示（v1.88.15，全站統一，不補零）：2026, 9 → "2026/9" */
export function fmtYm(year: number, month: number): string {
  return `${year}/${month}`;
}

/**
 * 日期顯示（v1.88.15，全站統一，不補零）：接受 "YYYY-MM-DD" 或 "YYYY/MM/DD"，
 * `2026-10-05` → `2026/10/5`；空值回 "—"；非日期字串原樣回傳（不丟資訊）。
 * 注意：只做顯示轉換，不改儲存（reviewDate 仍存 YYYY-MM-DD）。
 */
export function fmtYmd(value: string): string {
  const v = (value ?? "").trim();
  if (v === "") return "—";
  const m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return value;
  return `${m[1]}/${Number(m[2])}/${Number(m[3])}`;
}

/** Date → 含時間顯示（v1.88.15，不補零）：2026/10/5 09:30（時分保留兩位） */
export function fmtDateTime(d: Date): string {
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Firestore Timestamp → 含時間顯示（v1.88.15）；解析失敗回 "—" */
export function fmtTsDate(ts: unknown): string {
  try {
    const t = ts as { toDate?: () => Date };
    if (t && typeof t.toDate === "function") {
      const d = t.toDate();
      if (d instanceof Date && !Number.isNaN(d.getTime())) return fmtDateTime(d);
    }
  } catch {
    /* ignore */
  }
  return "—";
}

/** ISO 時間字串／毫秒時間戳 → 含時間顯示（v1.88.15）；空值／解析失敗回 "—" */
export function fmtIsoDateTime(value: string | number): string {
  if (value === "" || value == null) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return fmtDateTime(d);
}

/** 日期顯示統一為 YYYY/MM/DD（v1.88.7；v1.88.15 起不補零）：`2026-10-10` → `2026/10/10`；
 * 已是斜線格式者不變；空值回 "—"；非日期字串原樣回傳（不丟資訊）。 */
export function formatDateSlash(value: string): string {
  const v = value.trim();
  if (v === "") return "—";
  const m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return value;
  return `${m[1]}/${Number(m[2])}/${Number(m[3])}`;
}

/** 年月加減 n 個月（跨年自動進位）：(2026, 12, +1) → { year: 2027, month: 1 } */
export function shiftYm(
  year: number,
  month: number,
  n: number,
): { year: number; month: number } {
  const total = year * 12 + (month - 1) + n;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

/**
 * 審查月份「yyyy/mm」正規化（v1.88.13）：
 * 接受一位數月份並補零（"2026/9" → "2026/09"）；格式不符回 null。
 * 前後空白會先 trim；年份須為 4 位數、月份 1–12。
 */
export function normalizeReviewMonth(value: string): string | null {
  const m = /^\s*(\d{4})\/(\d{1,2})\s*$/.exec(value ?? "");
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${m[1]}/${pad2(month)}`;
}

/**
 * 審查月份清單正規化（v1.88.13）：只留合法的 "yyyy/mm"，去重、依曆年月排序。
 * 非字串／非法值直接丟棄（不報錯，呼叫端驗證另行處理）。
 */
export function normalizeReviewMonths(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out = new Set<string>();
  for (const v of values) {
    if (typeof v !== "string") continue;
    const n = normalizeReviewMonth(v);
    if (n) out.add(n);
  }
  return [...out].sort();
}

/** 審查月份「yyyy/mm」→ { year, month }（非法回 null） */
export function reviewMonthToYm(
  value: string,
): { year: number; month: number } | null {
  const n = normalizeReviewMonth(value);
  if (!n) return null;
  const [y, m] = n.split("/");
  return { year: Number(y), month: Number(m) };
}
