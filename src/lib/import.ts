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

/** xlsx sheet_to_json({header:1}) 產出正規化為字串陣列。 */
export function normalizeSheetRows(rows: unknown[][]): string[][] {
  return rows
    .map((r) =>
      (Array.isArray(r) ? r : []).map((c) =>
        c == null ? "" : String(c).trim(),
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
    code: string;
    itemText: string;
    optionSet: OptionSet;
    groupName: string;
    guidance: string;
  } | null;
}

/** 審核表匯入檔：第一列標題列 → 資料列。 */
export function parseAuditSheet(rows: string[][]): {
  headerErrors: string[];
  data: AuditImportRowInput[];
} {
  if (rows.length === 0)
    return { headerErrors: ["檔案為空，請使用範本格式"], data: [] };
  const { col } = mapHeaders(rows[0], AUDIT_HEADER_MAP);
  const required = ["code", "itemText", "optionSetRaw"];
  const missingRequired = required.filter((k) => col[k] === undefined);
  if (missingRequired.length > 0) {
    const labels = ["指標編號", "題目", "選項"];
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
      get("code") === "" &&
      get("itemText") === "" &&
      get("optionSetRaw") === "" &&
      get("groupName") === "" &&
      get("guidance") === ""
    )
      continue;
    data.push({
      lineNo: i + 1,
      code: get("code"),
      itemText: get("itemText"),
      optionSetRaw: get("optionSetRaw"),
      groupName: get("groupName"),
      guidance: get("guidance"),
    });
  }
  return { headerErrors: [], data };
}

/** 逐列驗證審核表（編號須對應批次表格中的列、題目必填、選項二選一）。 */
export function validateAuditRows(
  data: AuditImportRowInput[],
  ctx: { batchCodes: Set<string> },
): AuditImportRowResult[] {
  return data.map((r) => {
    const errors: string[] = [];
    const code = r.code.trim();
    if (!code) errors.push("指標編號未填");
    else if (!ctx.batchCodes.has(code))
      errors.push(`編號 ${code} 不在批次表格中`);
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
  "指標編號",
  "題目",
  "選項",
  "分組",
  "審核指引",
];

export function auditTemplateRows(): string[][] {
  return [
    AUDIT_TEMPLATE_HEADERS,
    [
      "QI-001",
      "接觸病人前執行手部衛生",
      "是/否/不適用",
      "執行前",
      "查核接觸病人前是否執行手部衛生",
    ],
  ];
}

/* ================= 品管審查結果匯入（v1.21.0） ================= */

/** 結果匯入前 6 欄固定標題（第 7 欄起為該指標審查表題目文字） */
export const RESULT_FIXED_HEADERS = [
  "指標代號",
  "受審單位",
  "審查月份",
  "審查員",
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
  } | null;
}

/** 審查月份解析：接受 2026-11 / 2026/11（亦接受 2026.11）；其餘回傳 null */
export function parseReviewMonth(
  raw: string,
): { year: number; month: number } | null {
  const m = /^(\d{4})[-/.](\d{1,2})$/.exec(raw.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

/**
 * 結果匯入檔解析：第一列標題列（前 6 欄固定、其後為題目欄）。
 * 回傳 headerErrors（標題列不符＝整檔中止）與資料列。
 */
export function parseResultSheet(rows: string[][]): {
  headerErrors: string[];
  data: ResultImportRowInput[];
} {
  if (rows.length === 0)
    return { headerErrors: ["檔案為空，請使用範本格式"], data: [] };
  const { col } = mapHeaders(rows[0], RESULT_HEADER_MAP);
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
      answers: r.slice(6).map((c) => c.trim()),
    });
  }
  return { headerErrors: [], data };
}

/**
 * 結果匯入驗證（v1.21.0）：
 * - 檔案級預檢：全部列指標代號須等於所選指標 code；題數（欄數-6）須等於
 *   該指標題目數；任一不符即整檔中止（fileErrors 非空）。
 * - 逐列：受審單位須存在、審查月份須合法、審查員職編須存在（未填留空）、
 *   各題答案須為 是／否／不適用（未填＝未答）；任一不符該列跳過。
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
    if (!ym) errors.push(`審查月份「${r.monthRaw || "（空白）"}」格式須為 2026-11`);
    const reviewerId = r.reviewerId.trim();
    if (reviewerId && ctx.staffLoaded && !ctx.staffHas(reviewerId))
      errors.push(`審查員職編 ${reviewerId} 不存在`);
    const badAnswers = r.answers.filter(
      (a) => a !== "" && a !== "是" && a !== "否" && a !== "不適用",
    );
    if (badAnswers.length > 0)
      errors.push(`答案須為 是／否／不適用：${badAnswers.join("、")}`);
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
        answers: r.answers,
      },
    };
  });
  return { fileErrors: [], rows };
}

/** 結果匯入範本：前 6 欄固定＋每題一欄（標題＝題目文字），依所選指標即時產生 */
export function resultTemplateRows(
  code: string,
  questions: string[],
): string[][] {
  return [
    [...RESULT_FIXED_HEADERS, ...questions],
    [
      code,
      "9A",
      "2026-11",
      "A12345",
      "B67890",
      "9A-01",
      ...questions.map(() => "是"),
    ],
  ];
}
