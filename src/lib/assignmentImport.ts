/**
 * 分工表批次匯入（v1.88.4）：純函式，不碰 Firestore，可 node 測試。
 *
 * 範本欄位（依分工表一列的資料設計）：
 * - 審查員職編／審查員姓名：與人員資料比對（姓名須與人員檔一致，比照角色成員匯入）；
 * - 負責單位：單位代碼或單位名稱，多個單位以「、」分隔（例如 U01、U02）；
 *   填「不限單位」時匯入為不限單位項目（units 為空、unlimitedUnits 為 true），
 *   與現行分工表「不限單位」語意一致；「不限單位」不可與其他單位併填。
 * 同一審查員可分多列填寫，匯入時合併單位（聯集）。
 *
 * 驗證（驗不過的列報錯不匯入，其餘照常）：
 * - 職編不可空白；須在人員資料中；
 * - 姓名不可空白，須與人員資料一致；
 * - 審查員須具審查員身分：在 reviewReviewers 名單內，或具品管組審查員角色
 *   （呼叫端以 reviewerIds／reviewerRoleIds 兩集合傳入；效期已由呼叫端過濾）；
 * - 負責單位不可空白；每個單位須存在（代碼或名稱比對）。
 *
 * 匯入只寫進分工表 state（呼叫端 setItems），儲存／產生排程時才寫入
 * Firestore，沿用現行分工表儲存時機，不另立寫入路徑。
 */

import { maskName } from "./mask";
import type { AssignmentItem } from "./scheduling";

/** 分工表匯入範本標題列（標題須完全一致，否則 BatchImporter 模式會擋下檔案） */
export const ASSIGNMENT_IMPORT_HEADER = [
  "審查員職編",
  "審查員姓名",
  "負責單位",
] as const;

/** 範例檔內容（含標題列；下載時走 downloadTemplate，xlsx 失敗退回 CSV） */
export const ASSIGNMENT_IMPORT_SAMPLE_ROWS: string[][] = [
  [...ASSIGNMENT_IMPORT_HEADER],
  ["0000001", "王小明", "U01、U02"],
  ["0000002", "王小美", "不限單位"],
];

/** 負責單位欄填此值＝不限單位項目 */
export const ASSIGNMENT_UNLIMITED_TEXT = "不限單位";

/** 多單位分隔符（頓號／逗號／分號／空白皆可） */
const UNIT_SEPARATORS = /[、,，;；\s]+/;

export interface AssignmentImportLookup {
  /** 職編 → 姓名（人員資料） */
  userNames: Map<string, string>;
  /** reviewReviewers 名單內的職編（呼叫端已過濾審查員效期） */
  reviewerIds: Set<string>;
  /** 具審查員角色且效期有效的職編 */
  reviewerRoleIds: Set<string>;
  /** 單位對照（代碼／名稱皆可比對） */
  units: Array<{ code: string; name: string }>;
}

export interface ParsedAssignmentRow {
  reviewerId: string;
  reviewerName: string;
  unlimited: boolean;
  unitIds: string[];
}

export interface ValidatedAssignmentRow {
  index: number;
  values: string[];
  ok: boolean;
  error: string;
  parsed?: ParsedAssignmentRow;
}

/** 解析負責單位欄：回傳單位代碼清單，或不限單位旗標，或錯誤訊息。 */
export function parseAssignedUnits(
  text: string,
  units: Array<{ code: string; name: string }>,
): { unlimited: boolean; unitIds: string[]; error: string } {
  const raw = (text ?? "").trim();
  if (!raw) return { unlimited: false, unitIds: [], error: "負責單位不可空白" };
  if (raw === ASSIGNMENT_UNLIMITED_TEXT) {
    return { unlimited: true, unitIds: [], error: "" };
  }
  const tokens = raw.split(UNIT_SEPARATORS).map((t) => t.trim()).filter(Boolean);
  if (tokens.includes(ASSIGNMENT_UNLIMITED_TEXT)) {
    return {
      unlimited: false,
      unitIds: [],
      error: "「不限單位」不可與其他單位併填",
    };
  }
  const unitIds: string[] = [];
  for (const token of tokens) {
    const found =
      units.find((u) => u.code === token) ?? units.find((u) => u.name === token);
    if (!found) {
      return { unlimited: false, unitIds: [], error: `單位「${token}」不存在` };
    }
    if (!unitIds.includes(found.code)) unitIds.push(found.code);
  }
  if (unitIds.length === 0) {
    return { unlimited: false, unitIds: [], error: "負責單位不可空白" };
  }
  return { unlimited: false, unitIds, error: "" };
}

/**
 * 逐列驗證（與 GroupsPage 角色成員匯入同一模式：錯誤列不匯入，其餘照常）。
 * 同一審查員分多列填寫視為合法，合併時再聯集單位。
 */
export function validateAssignmentImportRows(
  rows: string[][],
  lookup: AssignmentImportLookup,
): ValidatedAssignmentRow[] {
  return rows.map((row, i) => {
    const index = i + 1;
    const values = row;
    const fail = (error: string): ValidatedAssignmentRow => ({
      index,
      values,
      ok: false,
      error,
    });
    const staffId = (row[0] ?? "").trim();
    if (!staffId) return fail("職編不可空白");
    const realName = lookup.userNames.get(staffId);
    if (realName === undefined) {
      return fail(`職編 ${staffId} 不在人員資料中`);
    }
    const name = (row[1] ?? "").trim();
    if (!name) return fail("姓名不可空白");
    if (name !== realName) {
      return fail(`姓名與人員資料不符（應為 ${maskName(realName)}）`);
    }
    if (
      !lookup.reviewerIds.has(staffId) &&
      !lookup.reviewerRoleIds.has(staffId)
    ) {
      return fail("非審查員（不在審查員名單內且未具審查員角色）");
    }
    const parsedUnits = parseAssignedUnits(row[2] ?? "", lookup.units);
    if (parsedUnits.error) return fail(parsedUnits.error);
    return {
      index,
      values,
      ok: true,
      error: "",
      parsed: {
        reviewerId: staffId,
        reviewerName: realName,
        unlimited: parsedUnits.unlimited,
        unitIds: parsedUnits.unitIds,
      },
    };
  });
}

/**
 * 把驗證通過的匯入列併入既有分工表（純函式；合併語意與
 * SchedulePage 的 mergeItemsWithUnits／mergeItemsUnlimited 一致）：
 * - 有單位列：該審查員的單位取聯集，既有單位的每輪件數保留，新單位件數為 null；
 *   併入單位後即為指定單位項目，既有限制單位旗標取消；
 * - 不限單位列：該審查員改為不限單位項目（units 清空）。
 * 項目依審查員職編排序，單位依代碼排序。
 */
export function mergeImportedAssignments(
  prev: AssignmentItem[],
  parsed: ParsedAssignmentRow[],
): AssignmentItem[] {
  const next: AssignmentItem[] = prev.map((it) => ({
    reviewerId: it.reviewerId,
    units: it.units.map((u) => ({ ...u })),
    ...(it.unlimitedUnits === true
      ? { unlimitedUnits: true as const }
      : {}),
  }));
  for (const row of parsed) {
    const idx = next.findIndex((it) => it.reviewerId === row.reviewerId);
    if (row.unlimited) {
      const item: AssignmentItem = {
        reviewerId: row.reviewerId,
        units: [],
        unlimitedUnits: true as const,
      };
      if (idx >= 0) next[idx] = item;
      else next.push(item);
      continue;
    }
    const existing = idx >= 0 ? next[idx] : undefined;
    const existingMap = new Map(
      (existing?.units ?? []).map((u) => [u.unitId, u.caseCount]),
    );
    const merged = [...new Set([...existingMap.keys(), ...row.unitIds])]
      .map((unitId) => ({
        unitId,
        caseCount: existingMap.get(unitId) ?? null,
      }))
      .sort((a, b) => a.unitId.localeCompare(b.unitId, "zh-Hant"));
    const item: AssignmentItem = { reviewerId: row.reviewerId, units: merged };
    if (idx >= 0) next[idx] = item;
    else next.push(item);
  }
  return next.sort((a, b) => a.reviewerId.localeCompare(b.reviewerId, "zh-Hant"));
}
