/**
 * 匯入檔讀取共用（v1.21.0）：.xlsx/.xls 走 SheetJS；.csv 走自寫解析。
 * 指標／組織／結果匯入共用，避免各頁重複實作。
 */
import * as XLSX from "xlsx";
import { normalizeSheetRows, parseCSV, toCSV } from "./import";

/** 讀取匯入檔為字串陣列（第一列為標題列） */
export async function readSheetFile(file: File): Promise<string[][]> {
  if (/\.xlsx?$/i.test(file.name)) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return [];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      defval: "",
    });
    return normalizeSheetRows(aoa);
  }
  const text = await file.text();
  return parseCSV(text);
}

/** 下載 CSV（UTF-8 BOM，Excel 可直接開啟） */
export function downloadCsvFile(rows: string[][], filename: string) {
  const blob = new Blob(["\uFEFF" + toCSV(rows)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 下載 .xlsx 範本（失敗時退回 .csv） */
export function downloadTemplate(
  rows: string[][],
  sheetName: string,
  baseName: string,
) {
  try {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    XLSX.writeFile(wb, `${baseName}.xlsx`);
  } catch {
    downloadCsvFile(rows, `${baseName}.csv`);
  }
}
