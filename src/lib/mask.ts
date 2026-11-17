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

/**
 * 人員顯示統一格式（v1.50.0）：「職編/遮罩姓名」（半形斜線）。
 * 姓名缺值或與職編相同（舊資料以職編代姓名）時只顯示職編，兩者皆無顯示 —。
 */
export function staffLabel(empNo: string, name: string): string {
  const masked = name && name !== empNo ? maskName(name) : "";
  if (empNo && masked) return `${empNo}/${masked}`;
  return empNo || masked || "—";
}

/**
 * 單位代碼顯示（v1.51.0）：不限單位的任務／紀錄 unitId 為空字串，顯示為 NA；
 * 真實單位代碼照原樣顯示。絕對不要把 "NA" 當單位代碼存進資料庫。
 */
export function displayUnitCode(code: string): string {
  return code === "" ? "NA" : code;
}
