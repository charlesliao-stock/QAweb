/**
 * 人員／單位批次匯入（舊資料匯入，v1.21.0）：
 * - 職編／單位代號為唯一鍵，已存在 → 更新（upsert）；
 * - 未填欄位忽略（更新時不覆蓋既有值；新增時留空）；
 * - 群組／角色／職稱／單位名稱須存在，否則該列記入失敗摘要。
 *
 * 本檔零依賴、不碰 DOM、不碰 Firestore，可在 node 直接單元測試。
 * xlsx 檔案讀取由呼叫端（lib/sheetFile）完成後傳入 string[][]。
 */
import { splitOwners } from "./import";
import type { Membership } from "./roleIdentity";

/* ================= 共用：標題列對照 ================= */

function headerKey(h: string): string {
  return h
    .trim()
    .replace(/[\s（）()%％]/g, "")
    .toLowerCase();
}

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

/* ================= 人員匯入 ================= */

const USER_HEADER_MAP: Record<string, string> = {
  職編: "staffId",
  姓名: "name",
  單位: "unitCode",
  單位代號: "unitCode",
  職稱: "title",
  群組1: "group1",
  角色1: "roles1",
  群組2: "group2",
  角色2: "roles2",
};

export interface UserImportRowInput {
  lineNo: number;
  staffId: string;
  name: string;
  unitCode: string;
  title: string;
  group1: string;
  roles1: string;
  group2: string;
  roles2: string;
}

export interface UserImportRowResult {
  lineNo: number;
  ok: boolean;
  errors: string[];
  /** create＝新增；update＝職編已存在，僅更新有填欄位 */
  action: "create" | "update";
  values: {
    staffId: string;
    /** null＝未填（更新時忽略；新增時留空） */
    name: string | null;
    unitCode: string | null;
    title: string | null;
    /** null＝未填（更新時忽略；新增時為空陣列） */
    memberships: Membership[] | null;
  } | null;
}

/** 人員匯入檔：第一列標題列 → 資料列（lineNo 為檔案實際列號）。 */
export function parseUserSheet(rows: string[][]): {
  headerErrors: string[];
  data: UserImportRowInput[];
} {
  if (rows.length === 0)
    return { headerErrors: ["檔案為空，請使用範本格式"], data: [] };
  const { col } = mapHeaders(rows[0], USER_HEADER_MAP);
  if (col.staffId === undefined)
    return { headerErrors: ["缺少欄位：職編（請下載範本對照標題列）"], data: [] };
  const data: UserImportRowInput[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (k: string) => r[col[k]] ?? "";
    if (r.every((c) => c.trim() === "")) continue;
    data.push({
      lineNo: i + 1,
      staffId: get("staffId"),
      name: get("name"),
      unitCode: get("unitCode"),
      title: get("title"),
      group1: get("group1"),
      roles1: get("roles1"),
      group2: get("group2"),
      roles2: get("roles2"),
    });
  }
  return { headerErrors: [], data };
}

/** 逐列驗證人員（職編必填唯一鍵；群組／角色／職稱／單位須存在）。 */
export function validateUserRows(
  data: UserImportRowInput[],
  ctx: {
    existingStaffIds: Set<string>;
    groupByName: Map<string, string>;
    roleNames: Set<string>;
    titleNames: Set<string>;
    unitCodes: Set<string>;
  },
): UserImportRowResult[] {
  return data.map((r) => {
    const errors: string[] = [];
    const staffId = r.staffId.trim();
    if (!staffId) errors.push("職編未填");
    const name = r.name.trim();
    const unitCode = r.unitCode.trim();
    if (unitCode && !ctx.unitCodes.has(unitCode))
      errors.push(`單位 ${unitCode} 不存在`);
    const title = r.title.trim();
    if (title && !ctx.titleNames.has(title))
      errors.push(`職稱「${title}」不存在`);
    const memberships: Membership[] = [];
    for (const [gRaw, rolesRaw] of [
      [r.group1, r.roles1],
      [r.group2, r.roles2],
    ] as const) {
      const gName = gRaw.trim();
      const roleNames = splitOwners(rolesRaw);
      if (!gName && roleNames.length > 0) {
        errors.push("角色須搭配群組填寫");
        continue;
      }
      if (!gName) continue;
      const groupId = ctx.groupByName.get(gName) ?? "";
      if (!groupId) {
        errors.push(`群組「${gName}」不存在`);
        continue;
      }
      const unknown = roleNames.filter((n) => !ctx.roleNames.has(n));
      if (unknown.length > 0) {
        errors.push(`角色不存在：${unknown.join("、")}`);
        continue;
      }
      const dup = memberships.find((m) => m.groupId === groupId);
      if (dup) {
        for (const n of roleNames)
          if (!dup.roles.includes(n)) dup.roles.push(n);
      } else {
        memberships.push({ groupId, roles: roleNames });
      }
    }
    if (errors.length > 0 || !staffId)
      return {
        lineNo: r.lineNo,
        ok: false,
        errors,
        action: "create" as const,
        values: null,
      };
    const hasMembershipInput =
      r.group1.trim() !== "" || r.roles1.trim() !== "" ||
      r.group2.trim() !== "" || r.roles2.trim() !== "";
    return {
      lineNo: r.lineNo,
      ok: true,
      errors: [],
      action: ctx.existingStaffIds.has(staffId) ? "update" : "create",
      values: {
        staffId,
        name: name === "" ? null : name,
        unitCode: unitCode === "" ? null : unitCode,
        title: title === "" ? null : title,
        memberships: hasMembershipInput ? memberships : null,
      },
    };
  });
}

/* ================= 單位匯入 ================= */

const UNIT_HEADER_MAP: Record<string, string> = {
  單位代號: "code",
  代號: "code",
  單位名稱: "name",
  名稱: "name",
  所屬群組: "groupName",
  群組: "groupName",
};

export interface UnitImportRowInput {
  lineNo: number;
  code: string;
  name: string;
  groupName: string;
}

export interface UnitImportRowResult {
  lineNo: number;
  ok: boolean;
  errors: string[];
  action: "create" | "update";
  values: {
    code: string;
    name: string | null;
    groupId: string | null;
  } | null;
}

/** 單位匯入檔：第一列標題列 → 資料列。 */
export function parseUnitSheet(rows: string[][]): {
  headerErrors: string[];
  data: UnitImportRowInput[];
} {
  if (rows.length === 0)
    return { headerErrors: ["檔案為空，請使用範本格式"], data: [] };
  const { col } = mapHeaders(rows[0], UNIT_HEADER_MAP);
  if (col.code === undefined)
    return {
      headerErrors: ["缺少欄位：單位代號（請下載範本對照標題列）"],
      data: [],
    };
  const data: UnitImportRowInput[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (k: string) => r[col[k]] ?? "";
    if (r.every((c) => c.trim() === "")) continue;
    data.push({
      lineNo: i + 1,
      code: get("code"),
      name: get("name"),
      groupName: get("groupName"),
    });
  }
  return { headerErrors: [], data };
}

/** 逐列驗證單位（代號必填唯一鍵；所屬群組須存在）。 */
export function validateUnitRows(
  data: UnitImportRowInput[],
  ctx: {
    existingCodes: Set<string>;
    groupByName: Map<string, string>;
  },
): UnitImportRowResult[] {
  return data.map((r) => {
    const errors: string[] = [];
    const code = r.code.trim();
    if (!code) errors.push("單位代號未填");
    const name = r.name.trim();
    const groupName = r.groupName.trim();
    let groupId: string | null = null;
    if (groupName) {
      groupId = ctx.groupByName.get(groupName) ?? "";
      if (!groupId) errors.push(`群組「${groupName}」不存在`);
    }
    if (errors.length > 0 || !code)
      return {
        lineNo: r.lineNo,
        ok: false,
        errors,
        action: "create" as const,
        values: null,
      };
    return {
      lineNo: r.lineNo,
      ok: true,
      errors: [],
      action: ctx.existingCodes.has(code) ? "update" : "create",
      values: {
        code,
        name: name === "" ? null : name,
        groupId: groupName === "" ? null : groupId,
      },
    };
  });
}

/* ================= 範本 ================= */

export const USER_TEMPLATE_HEADERS = [
  "職編",
  "姓名",
  "單位",
  "職稱",
  "群組1",
  "角色1",
  "群組2",
  "角色2",
];

export function userTemplateRows(): string[][] {
  return [
    USER_TEMPLATE_HEADERS,
    ["A12345", "王小明", "9A", "護理師", "病房組", "品管組審查員", "", ""],
    ["B67890", "李小華", "9B", "副護理長", "病房組", "單位執行幹事", "加護組", "單位審查員"],
  ];
}

export const UNIT_TEMPLATE_HEADERS = ["單位代號", "單位名稱", "所屬群組"];

export function unitTemplateRows(): string[][] {
  return [
    UNIT_TEMPLATE_HEADERS,
    ["9A", "9A 病房", "病房組"],
    ["ICU", "加護病房", "加護組"],
  ];
}
