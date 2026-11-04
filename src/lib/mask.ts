/**
 * 姓名遮罩：資料庫儲存全名，系統顯示時中間字以 O 代替。
 * - 1 字：不變
 * - 2 字：保留首字（王明 → 王O）
 * - 3 字以上：保留首末字（王小明 → 王O明，歐陽小明 → 歐OO明）
 */
export function maskName(name: string): string {
  if (!name) return name;
  const chars = [...name];
  if (chars.length <= 1) return name;
  if (chars.length === 2) return `${chars[0]}O`;
  return `${chars[0]}${"O".repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}
