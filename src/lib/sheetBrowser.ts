/**
 * 瀏覽器直接讀 Google Sheet（v1.42.4）。
 *
 * 連線確認（步驟 1）與手動同步（步驟 3）由前端直接呼叫 Sheets API v4
 * values.get 立即讀值，不走 GitHub Actions 排程、不升 Blaze。
 *
 * 認證：瀏覽器金鑰（API key，?key= 參數）。API key 是公開設計——
 * 只能讀「知道連結者皆可查看」的試算表，且須在 GCP 限制來源網域
 * （HTTP referrers）為本站網址。絕對不要把 service account 私鑰放前端；
 * 每日 07:00 定時排程仍走 service account（Actions，sheet-sync.yml）。
 *
 * 本檔零新增依賴、不碰 Firestore、不碰 DOM，可在 node 直接單元測試
 * （fetch 由呼叫端注入，測試用 mock）。
 */
import { RESULT_FIXED_HEADERS } from "./import";

/** 讀取失敗種類（步驟 1／3 顯示具體原因與處理指引用）。 */
export type SheetBrowserErrorKind =
  | "no-api-key" // 尚未設定 API key
  | "not-shared" // 403：Sheet 未設「知道連結者皆可查看」
  | "api-disabled" // 403：專案未啟用 Sheets API
  | "not-found" // 404：試算表 ID 不正確
  | "bad-range" // 400：分頁名稱或範圍錯誤
  | "empty" // 試算表無資料（標題列為空）
  | "http" // 其他 HTTP 錯誤
  | "network"; // 無法連線（fetch 拋錯）

export interface SheetBrowserError {
  kind: SheetBrowserErrorKind;
  /** 顯示給使用者的原因（已含處理指引）。 */
  message: string;
  /** 原始錯誤訊息（除錯用，可空）。 */
  detail?: string;
}

/** Sheets API values.get 的 URL（range 須為已加引號的 A1 寫法，見 sheetRange）。 */
export function sheetApiUrl(
  spreadsheetId: string,
  range: string,
  apiKey: string,
): string {
  return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
    spreadsheetId,
  )}/values/${encodeURIComponent(range)}?key=${encodeURIComponent(apiKey)}`;
}

/** 分頁名＋A1 範圍 → 帶引號的範圍字串（分頁名含單引號時以 '' 跳脫）。 */
export function sheetRange(sheetName: string, a1: string): string {
  return `'${sheetName.replace(/'/g, "''")}'!${a1}`;
}

/**
 * 依 HTTP 狀態與錯誤訊息區分失敗原因（純函式）。
 * 403 有兩種：專案未啟用 Sheets API（訊息含 has not been used／disabled）
 * 與 Sheet 未設連結共用（其餘 403，常見為 The caller does not have permission）。
 */
export function classifySheetFetchError(
  status: number,
  bodyText: string,
): SheetBrowserError {
  let raw = "";
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: string; status?: string };
    };
    raw = parsed?.error?.message ?? "";
  } catch {
    raw = bodyText.slice(0, 300);
  }
  if (status === 404) {
    return {
      kind: "not-found",
      message:
        "找不到此試算表：請檢查貼上的 Google Sheet 網址是否正確（試算表 ID 是否有誤）。",
      detail: raw,
    };
  }
  if (status === 400) {
    return {
      kind: "bad-range",
      message:
        "讀取失敗：分頁名稱可能不正確或不存在，請檢查分頁名稱是否與試算表內的分頁名稱一致。",
      detail: raw,
    };
  }
  if (status === 403) {
    if (/has not been used|disabled|not enabled/i.test(raw)) {
      return {
        kind: "api-disabled",
        message:
          "Google Sheets API 尚未啟用：請到 GCP Console（專案 nurseboard-492316）→ API 和服務 → 啟用「Google Sheets API」。",
        detail: raw,
      };
    }
    return {
      kind: "not-shared",
      message:
        "沒有讀取權限：請把此試算表設為「知道連結的人皆可查看」（檢視者），再重新連線。",
      detail: raw,
    };
  }
  return {
    kind: "http",
    message: `讀取 Google Sheet 失敗（HTTP ${status}），請稍後再試。`,
    detail: raw,
  };
}

/**
 * 直接讀取 Sheet 值（純 fetch）。
 * 未傳 apiKey 時不發請求，直接回 no-api-key。
 * 回傳 values 為字串二維陣列（儲存格 null／缺值補 ""，前後空白已去除，
 * 與同步端 cellToString 同規則；列長度可能參差不齊，取用時一律以 ?? "" 補齊）。
 */
export async function fetchSheetValues(
  spreadsheetId: string,
  range: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ values: string[][] } | { error: SheetBrowserError }> {
  if (!apiKey || !apiKey.trim()) {
    return {
      error: {
        kind: "no-api-key",
        message:
          "尚未設定 Google Sheets API 金鑰：請到 Google Cloud Console 建立瀏覽器金鑰（限制來源網域為本站網址），貼到上方「Google Sheets API 金鑰」並儲存。",
      },
    };
  }
  let res: Response;
  try {
    res = await fetchImpl(sheetApiUrl(spreadsheetId, range, apiKey), {
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    return {
      error: {
        kind: "network",
        message: "無法連線到 Google Sheet，請檢查網路後再試。",
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { error: classifySheetFetchError(res.status, body) };
  }
  const data = (await res.json()) as { values?: unknown[][] };
  const values = (data.values ?? []).map((row) =>
    (Array.isArray(row) ? row : []).map((c) =>
      c == null ? "" : String(c).trim(),
    ),
  );
  return { values };
}

/** 讀標題列（A1:ZZ1）。 */
export async function fetchSheetHeaders(
  spreadsheetId: string,
  sheetName: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ headers: string[] } | { error: SheetBrowserError }> {
  const r = await fetchSheetValues(
    spreadsheetId,
    sheetRange(sheetName, "A1:ZZ1"),
    apiKey,
    fetchImpl,
  );
  if ("error" in r) return r;
  const headers = r.values[0] ?? [];
  if (headers.every((h) => h === "")) {
    return {
      error: {
        kind: "empty",
        message:
          "試算表標題列為空：請確認分頁名稱正確，且第一列有欄位名稱。",
      },
    };
  }
  return { headers };
}

/** 讀標題列＋前 4 列資料（預覽用，A1:ZZ5）。 */
export async function fetchSheetPreviewValues(
  spreadsheetId: string,
  sheetName: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ values: string[][] } | { error: SheetBrowserError }> {
  return fetchSheetValues(
    spreadsheetId,
    sheetRange(sheetName, "A1:ZZ5"),
    apiKey,
    fetchImpl,
  );
}

/** 讀全部資料（A1:ZZ10000，手動同步用）。 */
export async function fetchSheetAllValues(
  spreadsheetId: string,
  sheetName: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ values: string[][] } | { error: SheetBrowserError }> {
  return fetchSheetValues(
    spreadsheetId,
    sheetRange(sheetName, "A1:ZZ10000"),
    apiKey,
    fetchImpl,
  );
}

/**
 * 從表單時間戳記取出日期 YYYY-MM-DD（與同步端 parseTimestampDate 同規則）。
 * 接受 "2026/11/10 上午 11:23:45"、"2026-11-10 11:23"、ISO 等；
 * 先抓 YYYY/MM/DD 或 YYYY-MM-DD，抓不到再試 Date 解析（以台北時區取日期）。
 * 回傳 null＝無法解析。
 */
export function parseSheetTimestampDate(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const m = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (
      dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === mo - 1 &&
      dt.getUTCDate() === d
    ) {
      return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    return null;
  }
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

/** 依欄位對應把 Sheet 值轉為結果匯入檔格式列陣列。 */
export interface MappedSheetRows {
  /** 第 1 列為標題列（固定 6 欄＋每題「結果欄＋備註欄」成對），可直接餵 parseResultSheet。 */
  rows: string[][];
  /** lineNo（試算表列號，標題列為 1）→ 時間戳記原始字串（雜湊去重用）。 */
  timestamps: Map<number, string>;
  /** lineNo → 該列額外錯誤（指標代號不符、受審人員職編未填；合併進 validate 結果）。 */
  rowErrors: Map<number, string[]>;
}

/**
 * 依欄位對應把 Sheet 值轉為結果匯入檔格式（純函式）。
 * - 審查月份：月份欄優先；無月份欄時由時間戳記推導 YYYY-MM。
 * - 指標代號一律用連結指標的代號（對照已綁指標）；Sheet 內代號欄與連結指標
 *   不符時該列報錯（同步端 buildSyncRecord 同規則，逐列報錯、不整檔中止）。
 * - 受審人員職編未填時該列報錯（同步端同規則）。
 * - 全空列跳過；lineNo 為試算表實際列號（與 parseResultSheet 的 lineNo 一致）。
 */
export function mapSheetValuesToResultRows(
  values: string[][],
  fieldMapping: Record<string, string>,
  questions: string[],
  indicatorCode: string,
): MappedSheetRows {
  const rows: string[][] = [];
  const timestamps = new Map<number, string>();
  const rowErrors = new Map<number, string[]>();
  const headers = values[0] ?? [];
  if (headers.length === 0) return { rows, timestamps, rowErrors };
  rows.push([
    ...RESULT_FIXED_HEADERS,
    ...questions.flatMap((q) => [q, `${q}備註`]),
  ]);
  for (let i = 1; i < values.length; i++) {
    const cells = values[i] ?? [];
    if (cells.every((c) => (c ?? "").trim() === "")) continue;
    const lineNo = i + 1;
    const byKey: Record<string, string> = {};
    headers.forEach((h, j) => {
      const key = fieldMapping[h];
      if (key) byKey[key] = cells[j] ?? "";
    });
    const errs: string[] = [];
    const code = byKey.code ?? "";
    if (code !== "" && code !== indicatorCode) {
      errs.push(`指標代號 ${code} 與連結指標 ${indicatorCode} 不符`);
    }
    const personEmpNo = (byKey.personEmpNo ?? "").trim();
    if (!personEmpNo) errs.push("受審人員職編未填");
    const timestamp = byKey.timestamp ?? "";
    if (timestamp) timestamps.set(lineNo, timestamp);
    let monthRaw = byKey.monthRaw ?? "";
    if (!monthRaw && timestamp) {
      const d = parseSheetTimestampDate(timestamp);
      if (d) monthRaw = `${d.slice(0, 4)}-${d.slice(5, 7)}`;
    }
    if (errs.length > 0) rowErrors.set(lineNo, errs);
    rows.push([
      indicatorCode,
      byKey.unitCode ?? "",
      monthRaw,
      byKey.reviewerId ?? "",
      personEmpNo,
      byKey.bedNo ?? "",
      ...questions.flatMap((_, qi) => [
        byKey[`answer:${qi}`] ?? "",
        byKey[`note:${qi}`] ?? "",
      ]),
    ]);
  }
  return { rows, timestamps, rowErrors };
}

/**
 * 結果匯入檔格式的一列 → 預覽顯示值（系統欄位鍵 → 儲存格字串）。
 * 供步驟 2 對應預覽用（與 workflow 寫回的 preview.values 同形狀）。
 */
export function resultRowToPreviewValues(
  row: string[],
  questions: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const fixed: [string, number][] = [
    ["code", 0],
    ["unitCode", 1],
    ["monthRaw", 2],
    ["reviewerId", 3],
    ["personEmpNo", 4],
    ["bedNo", 5],
  ];
  for (const [key, idx] of fixed) out[key] = row[idx] ?? "";
  questions.forEach((_, qi) => {
    out[`answer:${qi}`] = row[6 + 2 * qi] ?? "";
    out[`note:${qi}`] = row[6 + 2 * qi + 1] ?? "";
  });
  return out;
}
