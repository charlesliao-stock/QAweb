/**
 * Google Sheet 定時同步對照（v1.42.0）。
 *
 * 本檔零依賴、不碰 DOM、不碰 Firestore，可在 node 直接單元測試。
 * 對照設定存在 Firestore `sheetSyncMappings` 集合（一份文件＝一個連結），
 * 由結果匯入頁「連結 Google Sheet」區維護、定時同步 workflow 照此讀取。
 * scripts/sheet-sync-lib.mjs 有同一份欄位對應邏輯（Node 版），兩邊以相同
 * fixture 測試守住一致。
 */

/** 系統欄位鍵：6 欄固定＋時間戳記＋每題結果／備註（answer:{i}／note:{i}，i 為題目序號 0 起） */
export type SheetSystemFieldKey =
  | "code"
  | "unitCode"
  | "monthRaw"
  | "reviewerId"
  | "personEmpNo"
  | "bedNo"
  | "timestamp"
  | `answer:${number}`
  | `note:${number}`;

/** 一份對照文件（Firestore sheetSyncMappings） */
export interface SheetSyncMapping {
  id: string;
  spreadsheetId: string;
  /** 分頁名（例如「表單回覆 1」） */
  sheetName: string;
  /** 網址 #gid= 的分頁 id（若有；workflow 可藉此解析分頁名） */
  sheetGid?: string;
  groupId: string;
  indicatorId: string;
  enabled: boolean;
  /** Sheet 標題列（workflow 讀回後寫入；未讀取前為 []） */
  detectedHeaders: string[];
  /** 欄位對應：Sheet 標題 → 系統欄位鍵 */
  fieldMapping: Record<string, string>;
  /** 對照狀態：pending＝未讀取標題、mapping-incomplete＝對應缺必要欄、ready＝可同步 */
  status: "pending" | "mapping-incomplete" | "ready";
  /** 前端要求讀取標題的時間（workflow 下次執行時處理） */
  headerFetchRequestedAt?: unknown;
  lastHeaderFetchAt?: unknown;
  lastSyncAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

/** 標題列正規化：去空白與括號、％，供欄位比對（與 import.ts headerKey 同規則）。 */
export function sheetHeaderKey(h: string): string {
  return h
    .trim()
    .replace(/[\s（）()%％]/g, "")
    .toLowerCase();
}

/**
 * 解析 Google Sheet 網址，取出 spreadsheetId 與 gid。
 * 接受格式：https://docs.google.com/spreadsheets/d/{id}/...（#gid= 選填）。
 * 其餘回傳 { error }。
 */
export function parseSheetUrl(
  url: string,
): { spreadsheetId: string; gid?: string } | { error: string } {
  const t = url.trim();
  const m = /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(t);
  if (!m) return { error: "網址須為 Google 試算表連結（含 /spreadsheets/d/試算表 ID/）" };
  const out: { spreadsheetId: string; gid?: string } = {
    spreadsheetId: m[1],
  };
  const gid = /[#&]gid=(\d+)/.exec(t);
  if (gid) out.gid = gid[1];
  return out;
}

/** 系統欄位選項（欄位對應編輯器下拉用）：6 欄固定＋時間戳記＋每題結果／備註 */
export function sheetSystemFieldOptions(questions: string[]): {
  key: string;
  label: string;
}[] {
  const opts: { key: string; label: string }[] = [
    { key: "timestamp", label: "時間戳記（表單回覆時間）" },
    { key: "code", label: "指標代號" },
    { key: "unitCode", label: "受審單位" },
    { key: "monthRaw", label: "審查月份" },
    { key: "reviewerId", label: "審查員職編" },
    { key: "personEmpNo", label: "受審人員職編" },
    { key: "bedNo", label: "床號" },
  ];
  questions.forEach((q, i) => {
    opts.push({ key: `answer:${i}`, label: `第 ${i + 1} 題結果：${q}` });
    opts.push({ key: `note:${i}`, label: `第 ${i + 1} 題備註：${q}備註` });
  });
  return opts;
}

/**
 * 依標題文字自動對應欄位（Sheet 標題 → 系統欄位鍵）。
 * 規則：時間戳記／固定欄以常見標題比對；每題結果欄須與題目文字完全相符、
 * 備註欄為「題目＋備註」。對不上的標題不寫入（留空待手動選）。
 */
export function autoFieldMapping(
  headers: string[],
  questions: string[],
): Record<string, string> {
  const map: Record<string, string> = {};
  const qKey = questions.map((q) => sheetHeaderKey(q));
  for (const h of headers) {
    const k = sheetHeaderKey(h);
    if (k === "" ) continue;
    if (k.includes("時間戳記") || k === "timestamp") {
      map[h] = "timestamp";
      continue;
    }
    if (k === "指標代號" || k === "編號") {
      map[h] = "code";
      continue;
    }
    if (k === "受審單位" || k === "單位") {
      map[h] = "unitCode";
      continue;
    }
    if (k === "審查月份" || k === "月份") {
      map[h] = "monthRaw";
      continue;
    }
    if (k === "審查員職編" || k === "審查員") {
      map[h] = "reviewerId";
      continue;
    }
    if (k === "受審人員職編" || k === "受審人員") {
      map[h] = "personEmpNo";
      continue;
    }
    if (k === "床號") {
      map[h] = "bedNo";
      continue;
    }
    const qi = qKey.indexOf(k);
    if (qi >= 0) {
      map[h] = `answer:${qi}`;
      continue;
    }
    const ni = qKey.findIndex((qk) => k === `${qk}備註`);
    if (ni >= 0) {
      map[h] = `note:${ni}`;
      continue;
    }
  }
  return map;
}

/** 同步必要的系統欄位鍵：受審單位、受審人員、（審查月份或時間戳記其一）、每題結果 */
export function requiredMappingKeys(questionCount: number): string[] {
  const keys = ["unitCode", "personEmpNo"];
  for (let i = 0; i < questionCount; i++) keys.push(`answer:${i}`);
  return keys;
}

/**
 * 檢查對應是否缺必要欄（供儲存對應時顯示錯誤、不建立同步）。
 * 回傳缺的欄位中文名（空陣列＝齊全）。審查月份與時間戳記有其一即可
 * （缺月份時由時間戳記推導年月）。
 */
export function mappingMissingRequired(
  fieldMapping: Record<string, string>,
  questions: string[],
): string[] {
  const used = new Set(Object.values(fieldMapping));
  const missing: string[] = [];
  if (!used.has("unitCode")) missing.push("受審單位");
  if (!used.has("personEmpNo")) missing.push("受審人員職編");
  if (!used.has("monthRaw") && !used.has("timestamp"))
    missing.push("審查月份（或時間戳記）");
  questions.forEach((q, i) => {
    if (!used.has(`answer:${i}`)) missing.push(`第 ${i + 1} 題結果：${q}`);
  });
  return missing;
}
