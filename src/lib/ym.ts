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

/** 年月字串（月份補零，符合 <input type="month">）：2026, 3 → "2026-03" */
export function ymPadded(year: number, month: number): string {
  return `${year}-${pad2(month)}`;
}

/** 日期顯示統一為 YYYY/MM/DD（v1.88.7）：`2026-10-10` → `2026/10/10`；
 * 已是斜線格式者不變；空值回 "—"；非日期字串原樣回傳（不丟資訊）。 */
export function formatDateSlash(value: string): string {
  const v = value.trim();
  if (v === "") return "—";
  const m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return value;
  return `${m[1]}/${pad2(Number(m[2]))}/${pad2(Number(m[3]))}`;
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
