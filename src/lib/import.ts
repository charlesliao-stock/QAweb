/**
 * 指標批次新增匯入：CSV 解析、基本資料／審核表匯入驗證、範本資料（v1.20）。
 *
 * 本檔零依賴、不碰 DOM、不碰 Firestore，可在 node 直接單元測試。
 * xlsx 檔案讀取由呼叫端（XLSX 套件）完成後傳入 string[][]。
 */
import { validateBasicThreshold, type OptionSet } from "./indicators";

/* ================= CSV 解析（RFC4180：引號、逗號、換行） ================= */

/** 解析 CSV 文字為列陣列（跳過檔尾空列）。 */
export function parseCSV(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else if (ch === '"') {
      inQuotes = true;
      i++;
    } else if (ch === ",") {
      pushField();
      i++;
    } else if (ch === "\r") {
      if (src[i + 1] === "\n") i++;
      pushRow();
      i++;
    } else if (ch === "\n") {
      pushRow();
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  // 檔尾殘值（無換行結尾的最後一列）
  if (field !== "" || row.length > 0) pushRow();
  // 移除全空列（例如檔尾多餘換行）
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** xlsx sheet_to_json({header:1}) 產出正規化為字串陣列。
 * Date 物件（cellDates 讀取的日期格）轉為 YYYY-MM-DD 字串（取本地日期，
 * 避免 UTC 換日），其餘照原樣轉字串。 */
export function normalizeSheetRows(rows: unknown[][]): string[][] {
  const fmtDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  return rows
    .map((r) =>
      (Array.isArray(r) ? r : []).map((c) =>
        c == null
          ? ""
          : c instanceof Date
            ? fmtDate(c)
            : String(c).trim(),
      ),
    )
    .filter((r) => r.some((c) => c !== ""));
}

/** 陣列 → CSV 文字（需要引號的欄位自動加引號；呼叫端另加 BOM 下載）。 */
export function toCSV(rows: string[][]): string {
  const esc = (c: string) =>
    /[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c;
  return rows.map((r) => r.map(esc).join(",")).join("\r\n");
}

/* ================= 共用小工具 ================= */

/** 負責人職編：多位以 、 、 , ; 任一分隔。 */
export function splitOwners(raw: string): string[] {
  return raw
    .split(/[、，,;；\s]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** 選項文字正規化：全形斜線→半形；「是/否」「是/否/不適用」二選一。 */
export function parseOptionSetLabel(raw: string): OptionSet | null {
  const t = raw.trim().replace(/／/g, "/").replace(/\s+/g, "");
  if (t === "是/否") return "yes-no";
  if (t === "是/否/不適用") return "yes-no-na";
  return null;
}

/** 標題列正規化：去空白與括號、％，供欄位比對。 */
function headerKey(h: string): string {
  return h
    .trim()
    .replace(/[\s（）()%％]/g, "")
    .toLowerCase();
}

const BASIC_HEADER_MAP: Record<string, string> = {
  組別: "groupName",
  編號: "code",
  指標編號: "code",
  指標名稱: "name",
  名稱: "name",
  閾值: "thresholdRaw",
  負責人: "ownersRaw",
  職編: "ownersRaw",
};

const AUDIT_HEADER_MAP: Record<string, string> = {
  組別: "indicatorGroup",
  指標編號: "code",
  編號: "code",
  題目: "itemText",
  指標項目: "itemText",
  選項: "optionSetRaw",
  分組: "groupName",
  審核指引: "guidance",
  指引: "guidance",
};

function mapHeaders(
  headerRow: string[],
  dict: Record<string, string>,
): { col: Record<string, number> } {
  const col: Record<string, number> = {};
  headerRow.forEach((h, i) => {
    const k = dict[headerKey(h)];
    if (k && col[k] === undefined) col[k] = i;
  });
  return { col };
}

/* ================= 基本資料匯入 ================= */

export interface BasicImportRowInput {
  lineNo: number;
  groupName: string;
  code: string;
  name: string;
  thresholdRaw: string;
  ownersRaw: string;
}

export interface BasicImportRowResult {
  lineNo: number;
  ok: boolean;
  errors: string[];
  values: {
    groupId: string;
    code: string;
    name: string;
    threshold: number;
    owners: string[];
  } | null;
}

/** 基本資料匯入檔：第一列標題列 → 資料列（lineNo 為檔案實際列號）。 */
export function parseBasicSheet(rows: string[][]): {
  headerErrors: string[];
  data: BasicImportRowInput[];
} {
  if (rows.length === 0)
    return { headerErrors: ["檔案為空，請使用範本格式"], data: [] };
  const { col } = mapHeaders(rows[0], BASIC_HEADER_MAP);
  const required = ["groupName", "code", "name", "thresholdRaw", "ownersRaw"];
  const missingRequired = required.filter((k) => col[k] === undefined);
  if (missingRequired.length > 0) {
    const labels = ["組別", "編號", "指標名稱", "閾值(%)", "負責人"];
    return {
      headerErrors: [
        `缺少欄位：${missingRequired
          .map((k) => labels[required.indexOf(k)])
          .join("、")}（請下載範本對照標題列）`,
      ],
      data: [],
    };
  }
  const data: BasicImportRowInput[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (k: string) => r[col[k]] ?? "";
    if (
      get("groupName") === "" &&
      get("code") === "" &&
      get("name") === "" &&
      get("thresholdRaw") === "" &&
      get("ownersRaw") === ""
    )
      continue;
    data.push({
      lineNo: i + 1,
      groupName: get("groupName"),
      code: get("code"),
      name: get("name"),
      thresholdRaw: get("thresholdRaw"),
      ownersRaw: get("ownersRaw"),
    });
  }
  return { headerErrors: [], data };
}

/**
 * 逐列驗證基本資料（組別名稱須存在、編號不重複、閾值規則、職編須存在）。
 * v1.21：編號唯一改為 (groupId, code)（複合文件 ID），existingCodes 為
 * 複合 ID 集合；不同組別同編號不再報錯。
 */
export function validateBasicRows(
  data: BasicImportRowInput[],
  ctx: {
    groupByName: Map<string, string>;
    existingCodes: Set<string>;
    staffHas: (id: string) => boolean;
    staffLoaded: boolean;
  },
): BasicImportRowResult[] {
  const seen = new Set<string>();
  return data.map((r) => {
    const errors: string[] = [];
    const groupName = r.groupName.trim();
    let groupId = ctx.groupByName.get(groupName) ?? "";
    if (!groupId) errors.push(`組別「${groupName || "（空白）"}」不存在`);
    const code = r.code.trim();
    const compositeKey = `${groupId}__${code}`;
    if (!code) errors.push("編號未填");
    else if (seen.has(compositeKey))
      errors.push(`編號 ${code} 在組別「${groupName}」內重複`);
    else if (ctx.existingCodes.has(compositeKey))
      errors.push(`編號 ${code} 在組別「${groupName}」內已存在`);
    seen.add(compositeKey);
    if (!r.name.trim()) errors.push("指標名稱未填");
    let threshold = 0;
    const thRaw = r.thresholdRaw.trim();
    if (!/^\d+$/.test(thRaw)) {
      errors.push("閾值須為正整數");
    } else {
      threshold = Number(thRaw);
      const thErr = validateBasicThreshold(threshold);
      if (thErr) errors.push(thErr);
    }
    const owners = splitOwners(r.ownersRaw);
    if (owners.length === 0) {
      errors.push("負責人未填");
    } else if (ctx.staffLoaded) {
      const unknown = owners.filter((id) => !ctx.staffHas(id));
      if (unknown.length > 0)
        errors.push(`負責人職編不存在：${unknown.join("、")}`);
    }
    if (errors.length > 0) return { lineNo: r.lineNo, ok: false, errors, values: null };
    return {
      lineNo: r.lineNo,
      ok: true,
      errors: [],
      values: { groupId, code, name: r.name.trim(), threshold, owners },
    };
  });
}

/* ================= 審核表匯入 ================= */

export interface AuditImportRowInput {
  lineNo: number;
  /** 指標所屬組別名稱（v1.22：與編號一併對應批次表格中的列） */
  indicatorGroup: string;
  code: string;
  itemText: string;
  optionSetRaw: string;
  groupName: string;
  guidance: string;
}

export interface AuditImportRowResult {
  lineNo: number;
  ok: boolean;
  errors: string[];
  values: {
    indicatorGroup: string;
    code: string;
    itemText: string;
    optionSet: OptionSet;
    groupName: string;
    guidance: string;
  } | null;
}

/** 審核表匯入檔：第一列標題列 → 資料列（v1.22 欄位順序：組別、指標編號、分組、題目、選項、審核指引）。 */
export function parseAuditSheet(rows: string[][]): {
  headerErrors: string[];
  data: AuditImportRowInput[];
} {
  if (rows.length === 0)
    return { headerErrors: ["檔案為空，請使用範本格式"], data: [] };
  const { col } = mapHeaders(rows[0], AUDIT_HEADER_MAP);
  const required = ["indicatorGroup", "code", "itemText", "optionSetRaw"];
  const missingRequired = required.filter((k) => col[k] === undefined);
  if (missingRequired.length > 0) {
    const labels = ["組別", "指標編號", "題目", "選項"];
    return {
      headerErrors: [
        `缺少欄位：${missingRequired
          .map((k) => labels[required.indexOf(k)])
          .join("、")}（請下載範本對照標題列）`,
      ],
      data: [],
    };
  }
  const data: AuditImportRowInput[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (k: string) => r[col[k]] ?? "";
    if (
      get("indicatorGroup") === "" &&
      get("code") === "" &&
      get("itemText") === "" &&
      get("optionSetRaw") === "" &&
      get("groupName") === "" &&
      get("guidance") === ""
    )
      continue;
    data.push({
      lineNo: i + 1,
      indicatorGroup: get("indicatorGroup"),
      code: get("code"),
      itemText: get("itemText"),
      optionSetRaw: get("optionSetRaw"),
      groupName: get("groupName"),
      guidance: get("guidance"),
    });
  }
  return { headerErrors: [], data };
}

/**
 * 逐列驗證審核表（v1.22：以「組別＋編號」對應批次表格中的列、題目必填、
 * 選項二選一）。batchByCode：編號 → 批次表格中該編號的組別名稱清單。
 */
export function validateAuditRows(
  data: AuditImportRowInput[],
  ctx: { batchByCode: Map<string, string[]> },
): AuditImportRowResult[] {
  return data.map((r) => {
    const errors: string[] = [];
    const code = r.code.trim();
    const indicatorGroup = r.indicatorGroup.trim();
    if (!code) errors.push("指標編號未填");
    else if (!ctx.batchByCode.has(code)) {
      errors.push(`編號 ${code} 不在批次表格中`);
    } else if (!indicatorGroup) {
      errors.push("組別未填");
    } else if (!ctx.batchByCode.get(code)!.includes(indicatorGroup)) {
      errors.push(
        `編號 ${code} 在批次表格中的組別為「${ctx.batchByCode
          .get(code)!
          .join("、")}」，與檔案組別「${indicatorGroup}」不符`,
      );
    }
    if (!r.itemText.trim()) errors.push("題目未填");
    const optionSet = parseOptionSetLabel(r.optionSetRaw);
    if (!optionSet) errors.push("選項須填「是/否」或「是/否/不適用」");
    if (errors.length > 0 || !optionSet)
      return { lineNo: r.lineNo, ok: false, errors, values: null };
    return {
      lineNo: r.lineNo,
      ok: true,
      errors: [],
      values: {
        indicatorGroup,
        code,
        itemText: r.itemText.trim(),
        optionSet,
        groupName: r.groupName.trim(),
        guidance: r.guidance.trim(),
      },
    };
  });
}

/* ================= 範本 ================= */

export const BASIC_TEMPLATE_HEADERS = [
  "組別",
  "編號",
  "指標名稱",
  "閾值(%)",
  "負責人",
];

export function basicTemplateRows(): string[][] {
  return [
    BASIC_TEMPLATE_HEADERS,
    ["病房組", "QI-001", "手部衛生遵從率", "90", "A12345"],
  ];
}

export const AUDIT_TEMPLATE_HEADERS = [
  "組別",
  "指標編號",
  "分組",
  "題目",
  "選項",
  "審核指引",
];

export function auditTemplateRows(): string[][] {
  return [
    AUDIT_TEMPLATE_HEADERS,
    [
      "病房組",
      "QI-001",
      "執行前",
      "接觸病人前執行手部衛生",
      "是/否/不適用",
      "查核接觸病人前是否執行手部衛生",
    ],
  ];
}

/* ================= 品管審查結果匯入（v1.21.0） ================= */

/** 結果匯入前 6 欄固定標題（第 7 欄起為該指標審查表題目文字）
 * v1.40.4：「審查員」改為「審查員職編」（範本表頭；舊表頭仍可匯入，見 RESULT_HEADER_MAP） */
export const RESULT_FIXED_HEADERS = [
  "指標代號",
  "受審單位",
  "審查月份",
  "審查員職編",
  "受審人員職編",
  "床號",
];

const RESULT_HEADER_MAP: Record<string, string> = {
  指標代號: "code",
  編號: "code",
  受審單位: "unitCode",
  單位: "unitCode",
  審查月份: "monthRaw",
  月份: "monthRaw",
  審查員職編: "reviewerId",
  審查員: "reviewerId",
  受審人員職編: "personEmpNo",
  受審人員: "personEmpNo",
  床號: "bedNo",
  /** v1.48.0：審核項目欄（第 7 欄，僅指標有設 auditItems 時出現） */
  審核項目: "auditItem",
};

export interface ResultImportRowInput {
  lineNo: number;
  code: string;
  unitCode: string;
  monthRaw: string;
  reviewerId: string;
  personEmpNo: string;
  bedNo: string;
  /** 審核項目（v1.48.0）：第 7 欄；無此欄的檔案為 "" */
  auditItem: string;
  /** 每題一欄（與題目順序對應；未填＝未答） */
  answers: string[];
  /** 備註（與 answers 對應；v1.43.0 已彙整至最後一題：僅最後一題可能有
   * 值，舊格式各題備註＋新格式單一備註欄合併進此處，其餘為 ""） */
  notes: string[];
}

export interface ResultImportRowResult {
  lineNo: number;
  ok: boolean;
  /** 硬錯誤：該列不能匯入 */
  errors: string[];
  /** 軟錯誤（v1.47.0）：受審人職編不在人員檔、或人員檔未載入無法驗證；
   * 由匯入者逐列決定是否仍要匯入 */
  softErrors: string[];
  /** 原始欄位（預覽表顯示用；values 為 null 的錯誤列亦有） */
  unitCode: string;
  monthRaw: string;
  reviewerId: string;
  personEmpNo: string;
  /** 審核項目（v1.48.0，trim 後；無此欄為 ""） */
  auditItem: string;
  values: {
    code: string;
    unitCode: string;
    year: number;
    month: number;
    reviewerId: string;
    personEmpNo: string;
    bedNo: string;
    /** 審核項目（v1.48.0）：指標無 auditItems 時為 ""（不寫入） */
    auditItem: string;
    answers: string[];
    notes: string[];
  } | null;
}

/**
 * 審查月份解析（v1.40.4，配合 Google 表單匯出）：
 * - 2026-11 / 2026/11 / 2026.11（既有）
 * - 2026/11/05 / 2026-11-05（年月日，日忽略；單數日亦可）
 * - Excel 日期序列（5 位數字，如 46331＝2026-11-05；xssx 未開 cellDates 時
 *   日期格即以序列傳入）；範圍 1981-01-01～2100-12-31，其餘回傳 null
 * - Date 物件先經 normalizeSheetRows 轉為 YYYY-MM-DD 再進此函式
 * 其餘回傳 null（呼叫端逐列報錯，不靜默跳過）。
 */
export function parseReviewMonth(
  raw: string,
): { year: number; month: number } | null {
  const t = raw
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[／－．]/g, (c) =>
      c === "／" ? "/" : c === "－" ? "-" : ".",
    );
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12) return null;
    const d = new Date(Date.UTC(year, month - 1, day));
    if (
      d.getUTCFullYear() !== year ||
      d.getUTCMonth() !== month - 1 ||
      d.getUTCDate() !== day
    )
      return null;
    return { year, month };
  }
  m = /^(\d{4})[-/.](\d{1,2})$/.exec(t);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return { year, month };
  }
  const serial = /^\d{4,5}$/.exec(t);
  if (serial) {
    const n = Number(serial[0]);
    if (n < 29580 || n > 73415) return null;
    const d = new Date(Math.round((n - 25569) * 86400 * 1000));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  }
  return null;
}

/**
 * 結果匯入每題答案正規化（v1.40.4，配合 Google 表單選項）：
 * 「正確」＝「是」、「不正確」＝「否」；「是／否／不適用」不變；
 * 未填（空字串）回傳 null（呼叫端視為未答）；其餘回傳 null（報錯用）。
 * 前後空白（全形空白亦同）先去除再比對。
 */
export function normalizeResultAnswer(
  raw: string,
): "是" | "否" | "不適用" | null {
  const t = raw.replace(/　/g, " ").trim();
  if (t === "正確" || t === "是") return "是";
  if (t === "不正確" || t === "否") return "否";
  if (t === "不適用") return "不適用";
  return null;
}

/* ================= 備註彙整（v1.43.0） ================= */

/** 備註彙整的一則：questionNo 為題號（依題目順序 1 起算）；
 * 0＝不屬於任何一題（新格式最後一題後的單一備註欄）。 */
export interface NotePart {
  questionNo: number;
  note: string;
}

/**
 * 備註彙整（v1.43.0）：多則備註合併為一則。
 * 單則時保持原文、不加題號；多則時有題號者前面加「第N題：」、無題號者
 * 直接接在後面，各則以「；」連接；空字串不計入。
 * 用途：(1)匯入時舊格式各題備註＋新格式單一備註欄合併進最後一題；
 * (2)查詢顯示時一筆紀錄的多題備註彙整為一則；(3)雜湊輸入正規化——
 * 同一內容用新格式或舊格式匯入，合併結果相同、文件 ID 相同。
 */
export function mergeNoteParts(parts: NotePart[]): string {
  const items = parts
    .map((p) => ({ questionNo: p.questionNo, note: (p.note ?? "").trim() }))
    .filter((p) => p.note !== "");
  if (items.length === 0) return "";
  if (items.length === 1) return items[0].note;
  return items
    .map((p) =>
      p.questionNo > 0 ? `第${p.questionNo}題：${p.note}` : p.note,
    )
    .join("；");
}

/* ================= 結果匯入指標下拉（v1.43.1） ================= */

/** 結果匯入指標下拉用的最小指標形狀（欄位與 ResultsPage 的 IndicatorOpt 一致）。 */
export interface ImportIndicatorOpt {
  id: string;
  status: string;
  groupId: string;
}

/**
 * 結果匯入指標下拉選項（v1.43.1）：只列「啟用」指標；選了組別時只列
 * 該組別（groupId 須與組別文件 ID 一致）；不選組別列出全部啟用指標。
 * 泛型保留呼叫端元素的完整型別（IndicatorOpt 的 code／name／questions）。
 */
export function filterImportIndicators<T extends ImportIndicatorOpt>(
  indicators: T[],
  groupId: string,
): T[] {
  return indicators.filter(
    (i) => i.status === "啟用" && (!groupId || i.groupId === groupId),
  );
}

/**
 * 指標下拉為空時的診斷提示（v1.43.1）：下拉本身沒有 disabled、選項
 * 就是過濾結果，所以為空只可能是資料面——尚未載入任何指標、沒有
 * 啟用指標、或所選組別沒有啟用指標。回傳 null 表示有選項、不用提示。
 * 呼叫端只在指標資料已載入後才顯示（載入中不顯示，避免閃爍）。
 */
export function importIndicatorEmptyHint(
  indicators: ImportIndicatorOpt[],
  groupId: string,
): string | null {
  if (indicators.length === 0)
    return "尚未載入任何指標資料，請重新整理頁面；若持續為空，請到指標管理確認指標資料。";
  if (!indicators.some((i) => i.status === "啟用"))
    return "尚無「啟用」狀態的指標，請先到指標管理將指標設為啟用。";
  if (
    groupId &&
    !indicators.some((i) => i.status === "啟用" && i.groupId === groupId)
  )
    return "該組別尚無啟用指標，請到指標管理確認指標的組別與狀態，或改選「全部組別」查看。";
  return null;
}

/* ================= SHA-1（純函式，零依賴） ================= */

/**
 * SHA-1（同步、零依賴；瀏覽器與 Node 共用）。
 * 以 UTF-8 編碼輸入，回傳 40 字元小寫十六進位。
 * 供匯入去重雜湊使用（importRecordHash）；標準測試向量：
 * sha1("")＝da39a3ee5e6b4b0d3255bfef95601890afd80709、
 * sha1("abc")＝a9993e364706816aba3e25717850c26c9cd0d89d。
 */
export function sha1Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const ml = bytes.length;
  const paddedLen = (((ml + 9 + 63) >> 6) << 6);
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[ml] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(paddedLen - 4, (ml * 8) >>> 0);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  const rotl = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++)
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const tmp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = tmp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const hex = (x: number) => x.toString(16).padStart(8, "0");
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4);
}

/* ================= 匯入去重：內容雜湊 → 決定性文件 ID ================= */

export interface ImportIdentityInput {
  indicatorId: string;
  unitCode: string;
  year: number;
  month: number;
  reviewerId: string;
  personEmpNo: string;
  bedNo: string;
  /** 已正規化的答案（是／否／不適用／""） */
  answers: string[];
  /** 備註（與 answers 對應；v1.43.0 備註已彙整至最後一題，其餘為 ""） */
  notes: string[];
}

/**
 * 匯入紀錄內容雜湊（v1.42.0 去重核心，v1.43.0 改雜湊正規化 v2）。
 * 固定順序 JSON，欄位皆去空白。reviewDate 不在內——手動匯入的 reviewDate
 * 是匯入當天，納入會讓隔天重匯同一檔案算成不同筆；指標與床號在內——
 * 同人同月不同指標／不同床是不同筆。
 * v1.43.0：備註先經 mergeNoteParts 彙整（各題備註合併進最後一題）再雜湊，
 * 因此同一內容用新格式（單一備註欄）或舊格式（各題備註欄）匯入，雜湊
 * 相同、文件 ID 相同。邊界：v1.42.0–v1.42.4 期間以每題備註匯入的紀錄，
 * 當時雜湊用的是未彙整的各題備註陣列，重匯同一檔案會因雜湊不同產生
 * 新文件、舊的留著（與 v1.42.0 舊隨機 ID 邊界同類，不自動刪舊紀錄）。
 */
export function importRecordHash(input: ImportIdentityInput): string {
  const mergedNote = mergeNoteParts(
    input.notes.map((x, i) => ({ questionNo: i + 1, note: x ?? "" })),
  );
  const canon = {
    v: 2,
    ind: input.indicatorId.trim(),
    unit: input.unitCode.trim(),
    y: input.year,
    m: input.month,
    r: (input.reviewerId ?? "").trim(),
    p: (input.personEmpNo ?? "").trim(),
    b: (input.bedNo ?? "").trim(),
    a: input.answers.map((x) => (x ?? "").trim()),
    n: mergedNote,
  };
  return sha1Hex(JSON.stringify(canon));
}

/**
 * 匯入紀錄文件 ID：import_＋雜湊前 24 字元（96 位元）。
 * 同一內容重複匯入／重複同步即 upsert（batch.set 覆寫），不會重複建檔。
 * 邊界（誠實處理）：舊的隨機 ID 紀錄無法與新雜湊 ID 自動對上，重匯舊檔
 * 案時舊紀錄仍留著、只保證不再新增重複；不自動刪舊紀錄。
 * v1.47.0：新匯入改用 importIdentityDocId（身分鍵）去重，本函式僅保留
 * 供舊版內容雜湊 ID 對照，不再用於寫入。
 */
export function importRecordDocId(input: ImportIdentityInput): string {
  return `import_${importRecordHash(input).slice(0, 24)}`;
}

/**
 * 匯入紀錄身分鍵文件 ID（v1.47.0）：指標＋單位＋年＋月＋受審人職編
 * （不含審查員、床號、答案、備註）。同一身分再匯＝同一文件 ID＝覆寫，
 * 改答案重匯不再新增重複筆。舊內容雜湊 ID 的文件不自動清理、不合併。
 * v1.48.0：納入審核項目（指標＋單位＋年＋月＋受審人職編＋審核項目），
 * 同一人同月不同審核項目為不同筆、並存不覆寫。相容要求：審核項目為空
 * （指標無此欄或該筆無值）時 canon 與 v1.47.0 完全相同（v:1、無 a 欄），
 * 文件 ID 與 v1.47.0 一致，既有紀錄重匯仍覆寫同一筆、不新增重複。
 */
export function importIdentityDocId(input: {
  indicatorId: string;
  unitCode: string;
  year: number;
  month: number;
  personEmpNo: string;
  /** 審核項目（v1.48.0，選填）：空值時不納入鍵（與 v1.47.0 相同） */
  auditItem?: string;
}): string {
  const item = (input.auditItem ?? "").trim();
  if (!item) {
    const canon = {
      v: 1,
      ind: input.indicatorId.trim(),
      unit: input.unitCode.trim(),
      y: input.year,
      m: input.month,
      p: input.personEmpNo.trim(),
    };
    return `import_${sha1Hex(JSON.stringify(canon)).slice(0, 24)}`;
  }
  const canon = {
    v: 2,
    ind: input.indicatorId.trim(),
    unit: input.unitCode.trim(),
    y: input.year,
    m: input.month,
    p: input.personEmpNo.trim(),
    a: item,
  };
  return `import_${sha1Hex(JSON.stringify(canon)).slice(0, 24)}`;
}

/**
 * 結果匯入檔解析：第一列標題列（前 6 欄固定、其後為題目欄）。
 * v1.43.0：範本改為最後一題後一個「備註」欄（所有指標一律如此）；
 * 備註欄不計入題數（題數仍以結果欄計）。舊格式檔案（每題各有
 * 「{題目}備註」欄）仍可匯入：各題備註＋單一備註欄經 mergeNoteParts
 * 合併進最後一題答案的 note（單則不加題號、多則每則附題號）。
 * opts.questionTitles 傳入時以題目文字精確配對；未傳時以標題後綴
 * 「備註」判斷。無備註欄的檔案照常解析，notes 全為 ""。
 * v1.48.0：指標有設 auditItems 時（opts.auditItems 非空），第 7 欄為
 * 「審核項目」欄（範本位置，床號之後、題目欄之前），答案欄自第 8 欄
 * 起；無此欄的舊檔案仍可解析，auditItem 視為 ""（驗證時逐列報錯）。
 * 回傳 hasAuditItemColumn 供驗證訊息（總欄數-6／-7）使用。
 */
export function parseResultSheet(
  rows: string[][],
  opts?: { questionTitles?: string[]; auditItems?: string[] },
): {
  headerErrors: string[];
  hasAuditItemColumn: boolean;
  data: ResultImportRowInput[];
} {
  if (rows.length === 0)
    return {
      headerErrors: ["檔案為空，請使用範本格式"],
      hasAuditItemColumn: false,
      data: [],
    };
  const headerRow = rows[0];
  const { col } = mapHeaders(headerRow, RESULT_HEADER_MAP);
  const required = ["code", "unitCode", "monthRaw"];
  const missingRequired = required.filter((k) => col[k] === undefined);
  if (missingRequired.length > 0) {
    const labels = ["指標代號", "受審單位", "審查月份"];
    return {
      headerErrors: [
        `缺少欄位：${missingRequired
          .map((k) => labels[required.indexOf(k)])
          .join("、")}（請下載範本對照標題列）`,
      ],
      hasAuditItemColumn: false,
      data: [],
    };
  }
  // v1.48.0：審核項目欄只在指標有設 auditItems 且標題正在範本位置
  // （第 7 欄，index 6）時認列；答案欄起始位置隨之條件式。
  const hasAuditItems = (opts?.auditItems ?? []).length > 0;
  const hasAuditCol = hasAuditItems && col.auditItem === 6;
  const answerStart = hasAuditCol ? 7 : 6;
  // 題目欄／備註欄配對（答案欄自 answerStart 起）。
  const titles = opts?.questionTitles;
  // 單一備註欄（v1.43.0 新格式）：標題恰為「備註」，位於最後一題之後。
  // 題目本身就叫「備註」時不誤判（此時不視為單一備註欄）。
  const isTitleNamedNote =
    !!titles && titles.some((t) => headerKey(t) === "備註");
  let singleNoteCol = -1;
  if (!isTitleNamedNote) {
    for (let j = answerStart; j < headerRow.length; j++) {
      if (headerKey(headerRow[j] ?? "") === "備註") {
        singleNoteCol = j;
        break;
      }
    }
  }
  const isNoteHeader = (idx: number): boolean => {
    const key = headerKey(headerRow[idx] ?? "");
    if (titles) {
      if (titles.some((t) => headerKey(t) === key)) return false;
      return titles.some((t) => headerKey(`${t}備註`) === key);
    }
    return key.endsWith("備註");
  };
  const answerCols: number[] = [];
  const noteCols: number[] = []; // -1＝該題無備註欄
  const paired =
    !!titles &&
    titles.length > 0 &&
    headerRow.length > answerStart + 1 &&
    headerKey(headerRow[answerStart + 1] ?? "") ===
      headerKey(`${titles[0]}備註`);
  if (paired && titles) {
    // 成對版面（舊格式）：每題結果欄＋備註欄交錯
    for (let i = 0; i < titles.length; i++) {
      const aCol = answerStart + 2 * i;
      if (aCol >= headerRow.length) break;
      answerCols.push(aCol);
      const nCol = aCol + 1;
      noteCols.push(
        nCol < headerRow.length &&
          headerKey(headerRow[nCol] ?? "") === headerKey(`${titles[i]}備註`)
          ? nCol
          : -1,
      );
    }
    // 成對版面之後的額外欄位：非備註標題者視為多餘題目欄（題數檢核會擋）
    for (let j = answerStart + 2 * titles.length; j < headerRow.length; j++) {
      if (j === singleNoteCol) continue;
      if (!isNoteHeader(j)) {
        answerCols.push(j);
        noteCols.push(-1);
      }
    }
  } else {
    // 單欄版面（新格式或舊範本）或未傳題目：逐欄判斷
    for (let j = answerStart; j < headerRow.length; j++) {
      if (j === singleNoteCol) continue;
      if (
        isNoteHeader(j) &&
        answerCols.length > 0 &&
        noteCols[noteCols.length - 1] === -1
      ) {
        noteCols[noteCols.length - 1] = j;
      } else if (!isNoteHeader(j)) {
        answerCols.push(j);
        noteCols.push(-1);
      }
      // 備註欄出現在無前導題目欄時忽略（不計入題數）
    }
  }
  const data: ResultImportRowInput[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (k: string) => r[col[k]] ?? "";
    if (r.every((c) => c.trim() === "")) continue;
    const answers = answerCols.map((c) => (r[c] ?? "").trim());
    // 備註彙整（v1.43.0）：舊格式各題備註＋新格式單一備註欄合併進最後一題
    const mergedNote = mergeNoteParts([
      ...noteCols.map((c, qi) => ({
        questionNo: qi + 1,
        note: c >= 0 ? (r[c] ?? "").trim() : "",
      })),
      {
        questionNo: 0,
        note: singleNoteCol >= 0 ? (r[singleNoteCol] ?? "").trim() : "",
      },
    ]);
    const notes = answers.map((_, qi) =>
      qi === answers.length - 1 ? mergedNote : "",
    );
    data.push({
      lineNo: i + 1,
      code: get("code"),
      unitCode: get("unitCode"),
      monthRaw: get("monthRaw"),
      reviewerId: get("reviewerId"),
      personEmpNo: get("personEmpNo"),
      bedNo: get("bedNo"),
      auditItem: hasAuditCol ? (r[6] ?? "").trim() : "",
      answers,
      notes,
    });
  }
  return { headerErrors: [], hasAuditItemColumn: hasAuditCol, data };
}

/**
 * 結果匯入驗證（v1.21.0，v1.40.4 補 Google 表單對應，v1.43.0 備註改彙整）：
 * - 檔案級預檢：全部列指標代號須等於所選指標 code；題數（結果欄數）須等於
 *   該指標題目數（備註欄不計入）；任一不符即整檔中止（fileErrors 非空）。
 * - 逐列：受審單位須存在、審查月份須合法、審查員職編須存在（未填留空）、
 *   各題答案須為 是／否／不適用（「正確」＝是、「不正確」＝否；未填＝未答）；
 *   任一不符該列跳過。驗證通過的列，values.answers 已正規化為 是／否／不適用，
 *   values.notes 為已彙整的備註（僅最後一題有值，其餘為 ""）。
 *   v1.48.0：指標有審核項目時，該欄未填或不在清單內皆為硬錯誤。
 */
export function validateResultSheet(
  data: ResultImportRowInput[],
  ctx: {
    code: string;
    questionCount: number;
    unitHas: (code: string) => boolean;
    staffHas: (id: string) => boolean;
    staffLoaded: boolean;
    /** 該指標的審核項目清單（v1.48.0）：非空時逐列驗證審核項目欄 */
    auditItems: string[];
    /** 檔案是否有審核項目欄（v1.48.0，parseResultSheet 回傳；題數訊息用） */
    hasAuditItemColumn: boolean;
  },
): { fileErrors: string[]; rows: ResultImportRowResult[] } {
  const fileErrors: string[] = [];
  const badCode = data.filter((r) => r.code.trim() !== ctx.code);
  if (badCode.length > 0) {
    fileErrors.push(
      `指標代號須全部等於 ${ctx.code}（第 ${badCode
        .map((r) => r.lineNo)
        .join("、")} 列不符），已中止全部匯入`,
    );
  }
  const badCount = data.filter((r) => r.answers.length !== ctx.questionCount);
  if (badCount.length > 0) {
    fileErrors.push(
      `題數須為 ${ctx.questionCount} 題（總欄數-${ctx.hasAuditItemColumn ? 7 : 6}；第 ${badCount
        .map((r) => r.lineNo)
        .join("、")} 列欄數不符），已中止全部匯入`,
    );
  }
  if (fileErrors.length > 0)
    return {
      fileErrors,
      rows: data.map((r) => ({
        lineNo: r.lineNo,
        ok: false,
        errors: fileErrors,
        softErrors: [],
        unitCode: r.unitCode.trim(),
        monthRaw: r.monthRaw,
        reviewerId: r.reviewerId.trim(),
        personEmpNo: r.personEmpNo.trim(),
        auditItem: r.auditItem.trim(),
        values: null,
      })),
    };
  const rows = data.map((r) => {
    const errors: string[] = [];
    const softErrors: string[] = [];
    const unitCode = r.unitCode.trim();
    if (!unitCode) errors.push("受審單位未填");
    else if (!ctx.unitHas(unitCode)) errors.push(`受審單位 ${unitCode} 不存在`);
    const ym = parseReviewMonth(r.monthRaw);
    if (!ym)
      errors.push(
        `審查月份「${r.monthRaw || "（空白）"}」格式須為 YYYY-MM 或 YYYY/MM/DD（如 2026/11/05）`,
      );
    // v1.47.0：審查員職編有填且不在人員檔＝硬錯誤；人員檔未載入時改軟
    // 錯誤（不直接放行、也不擋死），由匯入者決定。
    const reviewerId = r.reviewerId.trim();
    if (reviewerId) {
      if (ctx.staffLoaded) {
        if (!ctx.staffHas(reviewerId))
          errors.push(`審查員職編 ${reviewerId} 不存在`);
      } else {
        softErrors.push("人員檔未載入，無法驗證審查員職編");
      }
    }
    // v1.47.0：受審人職編空白＝硬錯誤；有填但不在人員檔＝軟錯誤
    // （非建檔人員可由匯入者逐列決定是否仍要匯入）；人員檔未載入時同為
    // 軟錯誤，不直接放行。
    const personEmpNo = r.personEmpNo.trim();
    if (!personEmpNo) {
      errors.push("受審人員職編未填");
    } else if (ctx.staffLoaded) {
      if (!ctx.staffHas(personEmpNo))
        softErrors.push(`受審人員職編 ${personEmpNo} 不在人員檔（非建檔人員）`);
    } else {
      softErrors.push("人員檔未載入，無法驗證受審人員職編");
    }
    const normalizedAnswers = r.answers.map((a) =>
      a === "" ? "" : normalizeResultAnswer(a),
    );
    const badAnswers = r.answers.filter(
      (a, i) => a !== "" && normalizedAnswers[i] === null,
    );
    if (badAnswers.length > 0)
      errors.push(
        `答案須為 是／否／不適用（正確＝是、不正確＝否）：${badAnswers.join("、")}`,
      );
    // v1.48.0：指標有審核項目時，該欄必填、且須為清單內的值（比照執行頁
    // 下拉單選）；指標無審核項目時忽略此欄（values.auditItem 為 ""）。
    const auditItem = r.auditItem.trim();
    const auditList = ctx.auditItems.map((x) => x.trim()).filter(Boolean);
    if (auditList.length > 0) {
      if (!auditItem) errors.push("審核項目未填");
      else if (!auditList.includes(auditItem))
        errors.push(`審核項目「${auditItem}」不在指標審核項目清單內`);
    }
    // v1.47.0：已填答案數（不含備註欄）須等於題數；空白答案算未填，
    // 不適用須填「不適用」才算有填。非法答案已另報錯時不重複報數。
    const filledCount = normalizedAnswers.filter(
      (a) => a !== "" && a !== null,
    ).length;
    if (badAnswers.length === 0 && filledCount !== ctx.questionCount)
      errors.push(
        `已填答案 ${filledCount} 題，與題數 ${ctx.questionCount} 題不符（空白答案不計入，未作答請填「不適用」）`,
      );
    if (errors.length > 0 || !ym)
      return {
        lineNo: r.lineNo,
        ok: false,
        errors,
        softErrors,
        unitCode,
        monthRaw: r.monthRaw,
        reviewerId,
        personEmpNo,
        auditItem,
        values: null,
      };
    return {
      lineNo: r.lineNo,
      ok: true,
      errors: [],
      softErrors,
      unitCode,
      monthRaw: r.monthRaw,
      reviewerId,
      personEmpNo,
      auditItem,
      values: {
        code: ctx.code,
        unitCode,
        year: ym.year,
        month: ym.month,
        reviewerId,
        personEmpNo: r.personEmpNo.trim(),
        bedNo: r.bedNo.trim(),
        auditItem: auditList.length > 0 ? auditItem : "",
        answers: normalizedAnswers.map((a) => a ?? ""),
        notes: r.notes.map((n) => n.trim()),
      },
    };
  });
  return { fileErrors: [], rows };
}

/**
 * 結果匯入範本（v1.43.0）：前 6 欄固定＋每題結果欄，最後一題後再加一個
 * 「備註」欄（所有指標一律如此）；備註欄未填可留空。舊格式檔案（每題
 * 各有「{題目}備註」欄、或無備註欄）仍可匯入，見 parseResultSheet。
 * v1.48.0：指標有設 auditItems 時，床號之後（第 7 欄）多一欄「審核項目」，
 * 範例值取清單第一項；無審核項目的指標範本完全不變。
 */
export function resultTemplateRows(
  code: string,
  questions: string[],
  auditItems?: string[],
): string[][] {
  const items = (auditItems ?? []).map((x) => x.trim()).filter(Boolean);
  const hasAudit = items.length > 0;
  return [
    [
      ...RESULT_FIXED_HEADERS,
      ...(hasAudit ? ["審核項目"] : []),
      ...questions,
      "備註",
    ],
    [
      code,
      "9A",
      "2026-11",
      "A12345",
      "B67890",
      "9A-01",
      ...(hasAudit ? [items[0]] : []),
      ...questions.map(() => "是"),
      "",
    ],
  ];
}
