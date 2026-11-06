/**
 * 匯入檔讀取共用（v1.21.0）：.xlsx/.xls 走 SheetJS；.csv 走自寫解析。
 * 指標／組織／結果匯入共用，避免各頁重複實作。
 *
 * v1.28 階段 5（A2）：xlsx 改動態 import。靜態 import 會把 427 KB 的
 * xlsx.core.min.js 包進首屏，但只有 GroupsPage／IndicatorsPage／
 * ResultsPage 的匯入功能用得到。改為函式內 `await import("xlsx")`，
 * 首屏不載；首次開匯入／下載範本時才載入獨立 chunk。
 * 載入以模組級 Promise 快取（失敗時清除快取、可重試）；載入失敗時
 * 讀檔拋出可見錯誤（各頁 catch 後顯示），範本下載退回 CSV 並回傳
 * "csv" 讓呼叫端提示使用者。
 */
import { normalizeSheetRows, parseCSV, toCSV } from "./import";

/** 動態載入 SheetJS：第一次呼叫才下載 chunk，之後共用同一份。 */
let xlsxPromise: Promise<typeof import("xlsx")> | null = null;
function loadXlsx(): Promise<typeof import("xlsx")> {
  if (!xlsxPromise) {
    xlsxPromise = import("xlsx").catch((err) => {
      // 載入失敗清除快取，下次操作可重試（不要把失敗的 Promise 留著）
      xlsxPromise = null;
      throw err;
    });
  }
  return xlsxPromise;
}

/** 讀取匯入檔為字串陣列（第一列為標題列） */
export async function readSheetFile(file: File): Promise<string[][]> {
  if (/\.xlsx?$/i.test(file.name)) {
    let XLSX: Awaited<ReturnType<typeof loadXlsx>>;
    try {
      XLSX = await loadXlsx();
    } catch {
      throw new Error(
        "Excel 解析元件載入失敗，請檢查網路連線後再試一次（CSV 檔不受影響）",
      );
    }
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

/**
 * 下載 .xlsx 範本（失敗時退回 .csv）。
 * 回傳實際下載的格式：xlsx 元件載入失敗時回傳 "csv"，呼叫端應提示使用者。
 */
export async function downloadTemplate(
  rows: string[][],
  sheetName: string,
  baseName: string,
): Promise<"xlsx" | "csv"> {
  try {
    const XLSX = await loadXlsx();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    XLSX.writeFile(wb, `${baseName}.xlsx`);
    return "xlsx";
  } catch {
    downloadCsvFile(rows, `${baseName}.csv`);
    return "csv";
  }
}
