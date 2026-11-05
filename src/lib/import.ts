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

/** 逐列驗證基本資料（組別名稱須存在、編號不重複、閾值規則、職編須存在）。 */
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
    if (!code) errors.push("編號未填");
    else if (seen.has(code)) errors.push(`編號 ${code} 在檔案內重複`);
    else if (ctx.existingCodes.has(code)) errors.push(`編號 ${code} 已存在`);
    seen.add(code);
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
