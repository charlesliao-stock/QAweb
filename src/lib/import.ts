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
};

export interface ResultImportRowInput {
  lineNo: number;
  code: string;
  unitCode: string;
  monthRaw: string;
  reviewerId: string;
  personEmpNo: string;
  bedNo: string;
  /** 每題一欄（與題目順序對應；未填＝未答） */
  answers: string[];
  /** 每題備註一欄（與 answers 對應；未填＝""；舊範本無備註欄時全為 ""） */
  notes: string[];
}

export interface ResultImportRowResult {
  lineNo: number;
  ok: boolean;
  errors: string[];
  values: {
    code: string;
    unitCode: string;
    year: number;
    month: number;
    reviewerId: string;
    personEmpNo: string;
    bedNo: string;
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
  /** Google Sheet 來源才有（手動檔案匯入留空） */
  spreadsheetId?: string;
  sheetName?: string;
  /** 表單回覆時間戳記（Sheet 來源才有；手動匯入留空） */
  timestamp?: string;
  indicatorId: string;
  unitCode: string;
  year: number;
  month: number;
  reviewerId: string;
  personEmpNo: string;
  bedNo: string;
  /** 已正規化的答案（是／否／不適用／""） */
  answers: string[];
  /** 已去空白的備註（與 answers 對應） */
  notes: string[];
}

/**
 * 匯入紀錄內容雜湊（v1.42.0 去重核心）。
 * 固定順序 JSON，欄位皆去空白。reviewDate 不在內——手動匯入的 reviewDate
 * 是匯入當天，納入會讓隔天重匯同一檔案算成不同筆；指標與床號在內——
 * 同人同月不同指標／不同床是不同筆。scripts/sheet-sync-lib.mjs 有同一
 * 份邏輯（Node 版），兩邊以相同 fixture 測試守住一致。
 */
export function importRecordHash(input: ImportIdentityInput): string {
  const canon = {
    v: 1,
    s: (input.spreadsheetId ?? "").trim(),
    t: (input.sheetName ?? "").trim(),
    ts: (input.timestamp ?? "").trim(),
    ind: input.indicatorId.trim(),
    unit: input.unitCode.trim(),
    y: input.year,
    m: input.month,
    r: (input.reviewerId ?? "").trim(),
    p: (input.personEmpNo ?? "").trim(),
    b: (input.bedNo ?? "").trim(),
    a: input.answers.map((x) => (x ?? "").trim()),
    n: input.notes.map((x) => (x ?? "").trim()),
  };
  return sha1Hex(JSON.stringify(canon));
}

/**
 * 匯入紀錄文件 ID：import_＋雜湊前 24 字元（96 位元）。
 * 同一內容重複匯入／重複同步即 upsert（batch.set 覆寫），不會重複建檔。
 * 邊界（誠實處理）：舊的隨機 ID 紀錄無法與新雜湊 ID 自動對上，重匯舊檔
 * 案時舊紀錄仍留著、只保證不再新增重複；不自動刪舊紀錄。
 */
export function importRecordDocId(input: ImportIdentityInput): string {
  return `import_${importRecordHash(input).slice(0, 24)}`;
}

/**
 * 結果匯入檔解析：第一列標題列（前 6 欄固定、其後為題目欄）。
 * v1.42.0：每題結果欄後可跟一個備註欄（標題「{題目}備註」，與該題成對；
 * 未填可留空）。opts.questionTitles 傳入時以題目文字精確配對；未傳時以
 * 標題後綴「備註」判斷。舊範本（無備註欄）照常解析，notes 全為 ""。
 * 備註欄不計入題數（題數仍以結果欄計）。
 * 回傳 headerErrors（標題列不符＝整檔中止）與資料列。
 */
export function parseResultSheet(
  rows: string[][],
  opts?: { questionTitles?: string[] },
): {
  headerErrors: string[];
  data: ResultImportRowInput[];
} {
  if (rows.length === 0)
    return { headerErrors: ["檔案為空，請使用範本格式"], data: [] };
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
      data: [],
    };
  }
  // 題目欄／備註欄配對（第 7 欄起）。
  const titles = opts?.questionTitles;
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
    headerRow.length > 7 &&
    headerKey(headerRow[7] ?? "") === headerKey(`${titles[0]}備註`);
  if (paired && titles) {
    // 成對版面：每題結果欄＋備註欄交錯
    for (let i = 0; i < titles.length; i++) {
      const aCol = 6 + 2 * i;
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
    for (let j = 6 + 2 * titles.length; j < headerRow.length; j++) {
      if (!isNoteHeader(j)) {
        answerCols.push(j);
        noteCols.push(-1);
      }
    }
  } else {
    // 單欄版面（舊範本）或未傳題目：逐欄判斷
    for (let j = 6; j < headerRow.length; j++) {
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
    data.push({
      lineNo: i + 1,
      code: get("code"),
      unitCode: get("unitCode"),
      monthRaw: get("monthRaw"),
      reviewerId: get("reviewerId"),
      personEmpNo: get("personEmpNo"),
      bedNo: get("bedNo"),
      answers: answerCols.map((c) => (r[c] ?? "").trim()),
      notes: noteCols.map((c) => (c >= 0 ? (r[c] ?? "").trim() : "")),
    });
  }
  return { headerErrors: [], data };
}

/**
 * 結果匯入驗證（v1.21.0，v1.40.4 補 Google 表單對應，v1.42.0 補備註欄）：
 * - 檔案級預檢：全部列指標代號須等於所選指標 code；題數（結果欄數）須等於
 *   該指標題目數（備註欄不計入）；任一不符即整檔中止（fileErrors 非空）。
 * - 逐列：受審單位須存在、審查月份須合法、審查員職編須存在（未填留空）、
 *   各題答案須為 是／否／不適用（「正確」＝是、「不正確」＝否；未填＝未答）；
 *   任一不符該列跳過。驗證通過的列，values.answers 已正規化為 是／否／不適用，
 *   values.notes 為去空白後的備註（與 answers 對應）。
 */
export function validateResultSheet(
  data: ResultImportRowInput[],
  ctx: {
    code: string;
    questionCount: number;
    unitHas: (code: string) => boolean;
    staffHas: (id: string) => boolean;
    staffLoaded: boolean;
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
      `題數須為 ${ctx.questionCount} 題（總欄數-6；第 ${badCount
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
        values: null,
      })),
    };
  const rows = data.map((r) => {
    const errors: string[] = [];
    const unitCode = r.unitCode.trim();
    if (!unitCode) errors.push("受審單位未填");
    else if (!ctx.unitHas(unitCode)) errors.push(`受審單位 ${unitCode} 不存在`);
    const ym = parseReviewMonth(r.monthRaw);
    if (!ym)
      errors.push(
        `審查月份「${r.monthRaw || "（空白）"}」格式須為 YYYY-MM 或 YYYY/MM/DD（如 2026/11/05）`,
      );
    const reviewerId = r.reviewerId.trim();
    if (reviewerId && ctx.staffLoaded && !ctx.staffHas(reviewerId))
      errors.push(`審查員職編 ${reviewerId} 不存在`);
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
    if (errors.length > 0 || !ym)
      return { lineNo: r.lineNo, ok: false, errors, values: null };
    return {
      lineNo: r.lineNo,
      ok: true,
      errors: [],
      values: {
        code: ctx.code,
        unitCode,
        year: ym.year,
        month: ym.month,
        reviewerId,
        personEmpNo: r.personEmpNo.trim(),
        bedNo: r.bedNo.trim(),
        answers: normalizedAnswers.map((a) => a ?? ""),
        notes: r.notes.map((n) => n.trim()),
      },
    };
  });
  return { fileErrors: [], rows };
}

/**
 * 結果匯入範本：前 6 欄固定＋每題「結果欄＋備註欄」成對（標題＝題目文字、
 * 「{題目}備註」），依所選指標即時產生。備註欄未填可留空；舊範本（無備註
 * 欄）仍可匯入，見 parseResultSheet。
 */
export function resultTemplateRows(
  code: string,
  questions: string[],
): string[][] {
  return [
    [...RESULT_FIXED_HEADERS, ...questions.flatMap((q) => [q, `${q}備註`])],
    [
      code,
      "9A",
      "2026-11",
      "A12345",
      "B67890",
      "9A-01",
      ...questions.flatMap(() => ["是", ""]),
    ],
  ];
}
