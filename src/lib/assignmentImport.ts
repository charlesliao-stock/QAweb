/**
 * 分工表批次匯入（v1.88.4；v1.88.13 改為 4 欄）：純函式，不碰 Firestore，可 node 測試。
 *
 * 範本欄位（依分工表一列的資料設計）：
 * - 指標代號：只核對目前頁面的指標，不符者整列報錯不匯入（一次只匯一支指標）；
 * - 審查員職編：與人員資料比對；姓名欄已移除（v1.88.13），解析後預覽
 *   以職編查出人員並顯示遮罩姓名供匯入者確認；
 * - 負責單位：單位代碼或單位名稱，多個單位以半形逗號分隔（例如 U01,U02）；
 *   只認半形逗號（v1.88.19：含「、」／全形逗號／分號／空白者整列報錯）；
 *   填「不限單位」時匯入為不限單位項目（units 為空、unlimitedUnits 為 true），
 *   與現行分工表「不限單位」語意一致；「不限單位」不可與其他單位併填。
 * - 審查月份：必填，yyyy/m，多筆以半形逗號分隔（例如 2026/8,2026/9）；
 *   一位數月份接受並正規化為兩位數（2026/9 → 2026/09）；超出該期
 *   審查月範圍者整列報錯不匯入。
 * 同一審查員可分多列填寫，匯入時合併單位（聯集）與月份（聯集）。
 *
 * 驗證（驗不過的列報錯不匯入，其餘照常）：
 * - 指標代號須與目前頁面指標一致；
 * - 職編不可空白；須在人員資料中；
 * - 審查員須具審查員身分：在 reviewReviewers 名單內，或具品管組審查員角色
 *   （呼叫端以 reviewerIds／reviewerRoleIds 兩集合傳入；效期已由呼叫端過濾）；
 * - 負責單位不可空白；每個單位須存在（代碼或名稱比對），且須在該期
 *   受審單位內（allowedUnitCodes＝排程單位 ∩ 權限單位）；
 * - 審查月份不可空白；格式須為 yyyy/mm；須落在該期審查月範圍內。
 *
 * 匯入只寫進分工表 state（呼叫端 setItems），儲存／產生排程時才寫入
 * Firestore，沿用現行分工表儲存時機，不另立寫入路徑。
 */

import { mergeReviewMonths } from "./scheduling";
import type { AssignmentItem } from "./scheduling";
import { normalizeReviewMonth, normalizeReviewMonths } from "./ym";

/** 分工表匯入範本標題列（標題須完全一致，否則 BatchImporter 模式會擋下檔案） */
export const ASSIGNMENT_IMPORT_HEADER = [
  "指標代號",
  "審查員職編",
  "負責單位",
  "審查月份",
] as const;

/** 範例檔內容（含標題列；下載時走 downloadTemplate，xlsx 失敗退回 CSV） */
export const ASSIGNMENT_IMPORT_SAMPLE_ROWS: string[][] = [
  [...ASSIGNMENT_IMPORT_HEADER],
  ["QA-001", "0000001", "U01,U02", "2026/8,2026/9"],
  ["QA-001", "0000002", "不限單位", "2026/10"],
];

/** 負責單位欄填此值＝不限單位項目 */
export const ASSIGNMENT_UNLIMITED_TEXT = "不限單位";

/** 多單位分隔符（v1.88.19：只認半形逗號） */
const UNIT_SEPARATORS = /,/;

export interface AssignmentImportLookup {
  /** 職編 → 姓名（人員資料） */
  userNames: Map<string, string>;
  /** reviewReviewers 名單內的職編（呼叫端已過濾審查員效期） */
  reviewerIds: Set<string>;
  /** 具審查員角色且效期有效的職編 */
  reviewerRoleIds: Set<string>;
  /** 單位對照（代碼／名稱皆可比對） */
  units: Array<{ code: string; name: string }>;
  /**
   * v1.88.5：允許匯入的單位代碼（單位排程者＝僅自己單位；未設＝不設限）。
   * 「不限單位」列對受限者一律不通過（不限單位等於幫所有單位排）。
   */
  allowedUnitCodes?: ReadonlySet<string>;
  /** v1.88.13：目前頁面指標的代號（只核對，不符整列報錯） */
  expectedIndicatorCode?: string;
  /**
   * v1.88.13：該期排程的受審單位代碼（未設＝尚無排程或排程不限單位，
   * 不做此項核對；月份核對仍會因無排程而報錯）。
   */
  scheduleUnitCodes?: ReadonlySet<string>;
  /**
   * v1.88.13：該期排程的審查曆月（"yyyy/mm" 集合；未設＝尚無排程，
   * 月份無法核對，整列報錯）。
   */
  allowedReviewMonths?: ReadonlySet<string>;
}

export interface ParsedAssignmentRow {
  reviewerId: string;
  reviewerName: string;
  unlimited: boolean;
  unitIds: string[];
  /** 審查月份（v1.88.13）："yyyy/mm"，排序去重 */
  reviewMonths: string[];
}

export interface ValidatedAssignmentRow {
  index: number;
  values: string[];
  ok: boolean;
  error: string;
  parsed?: ParsedAssignmentRow;
}

/** 多月份分隔符（v1.88.19：只認半形逗號） */
const MONTH_SEPARATORS = /,/;

/**
 * 解析審查月份欄（v1.88.13，純函式；v1.88.19 只認半形逗號）：
 * 以半形逗號分隔多筆，每段 trim；
 * 格式須為 yyyy/mm，一位數月份正規化為兩位數（2026/9 → 2026/09）；
 * 去重、依曆年月排序。空白回錯誤；任一段格式不符即整欄報錯。
 */
export function parseReviewMonths(
  text: string,
): { months: string[]; error: string } {
  const raw = (text ?? "").trim();
  if (!raw) return { months: [], error: "審查月份不可空白" };
  if (/[、，；\s]/.test(raw))
    return { months: [], error: "審查月份多筆請以半形逗號分隔" };
  const months: string[] = [];
  for (const token of raw.split(MONTH_SEPARATORS)) {
    const t = token.trim();
    if (!t) continue;
    const n = normalizeReviewMonth(t);
    if (!n) {
      return { months: [], error: `審查月份格式錯誤「${t}」（應為 yyyy/mm，多筆以半形逗號分隔）` };
    }
    if (!months.includes(n)) months.push(n);
  }
  if (months.length === 0) {
    return { months: [], error: "審查月份不可空白" };
  }
  return { months: months.sort(), error: "" };
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
  if (/[、，；\s]/.test(raw))
    return {
      unlimited: false,
      unitIds: [],
      error: "負責單位多筆請以半形逗號分隔",
    };
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
 * 同一審查員分多列填寫視為合法，合併時再聯集單位與月份。
 * 欄位順序（v1.88.13）：指標代號／審查員職編／負責單位／審查月份。
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
    // v1.88.13：指標代號只核對目前頁面指標，不符整列報錯（一次只匯一支指標）。
    const code = (row[0] ?? "").trim();
    if (!code) return fail("指標代號不可空白");
    if (!lookup.expectedIndicatorCode) {
      return fail("無法核對指標代號（尚無指標代號）");
    }
    if (code !== lookup.expectedIndicatorCode) {
      return fail(
        `指標代號不符（應為 ${lookup.expectedIndicatorCode}，本列為 ${code}）`,
      );
    }
    const staffId = (row[1] ?? "").trim();
    if (!staffId) return fail("職編不可空白");
    const realName = lookup.userNames.get(staffId);
    if (realName === undefined) {
      return fail(`職編 ${staffId} 不在人員資料中`);
    }
    if (
      !lookup.reviewerIds.has(staffId) &&
      !lookup.reviewerRoleIds.has(staffId)
    ) {
      return fail("非審查員（不在審查員名單內且未具審查員角色）");
    }
    const parsedUnits = parseAssignedUnits(row[2] ?? "", lookup.units);
    if (parsedUnits.error) return fail(parsedUnits.error);
    // v1.88.13：負責單位須在該期受審單位內（不限單位列不受此限）。
    if (lookup.scheduleUnitCodes && !parsedUnits.unlimited) {
      const outside = parsedUnits.unitIds.filter(
        (c) => !lookup.scheduleUnitCodes!.has(c),
      );
      if (outside.length > 0) {
        return fail(`負責單位不在本期受審單位內（${outside.join("、")}）`);
      }
    }
    // v1.88.5：單位排程者僅能匯入自己單位；「不限單位」列亦不通過。
    if (lookup.allowedUnitCodes) {
      if (parsedUnits.unlimited) {
        return fail("僅能為自己單位匯入，「不限單位」不開放");
      }
      const outside = parsedUnits.unitIds.filter(
        (c) => !lookup.allowedUnitCodes!.has(c),
      );
      if (outside.length > 0) {
        return fail(`僅能為自己單位匯入（不可匯入 ${outside.join("、")}）`);
      }
    }
    // v1.88.13：審查月份必填；超出該期審查月範圍整列報錯不匯入。
    const parsedMonths = parseReviewMonths(row[3] ?? "");
    if (parsedMonths.error) return fail(parsedMonths.error);
    if (!lookup.allowedReviewMonths) {
      return fail("尚無排程／單位設定，無法核對審查月份");
    }
    const outsideMonths = parsedMonths.months.filter(
      (m) => !lookup.allowedReviewMonths!.has(m),
    );
    if (outsideMonths.length > 0) {
      return fail(`審查月份超出該期審查月範圍（${outsideMonths.join("、")}）`);
    }
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
        reviewMonths: parsedMonths.months,
      },
    };
  });
}

/**
 * 把驗證通過的匯入列併入既有分工表（純函式；合併語意與
 * SchedulePage 的 mergeItemsWithUnits／mergeItemsUnlimited 一致）：
 * - 有單位列：該審查員的單位取聯集，既有單位的每輪件數保留，新單位件數為 null；
 *   併入單位後即為指定單位項目，既有限制單位旗標取消；
 * - 不限單位列：該審查員改為不限單位項目（units 清空）；
 * - 審查月份（v1.88.13）：同一審查員多列取聯集；既有為空（＝全部月份）
 *   時，新填月份直接取代。
 * 項目依審查員職編排序，單位依代碼排序，月份排序去重。
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
    ...(normalizeReviewMonths(it.reviewMonths).length > 0
      ? { reviewMonths: normalizeReviewMonths(it.reviewMonths) }
      : {}),
  }));
  for (const row of parsed) {
    const idx = next.findIndex((it) => it.reviewerId === row.reviewerId);
    if (row.unlimited) {
      const item: AssignmentItem = {
        reviewerId: row.reviewerId,
        units: [],
        unlimitedUnits: true as const,
        reviewMonths: [...row.reviewMonths],
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
    const item: AssignmentItem = {
      reviewerId: row.reviewerId,
      units: merged,
      reviewMonths: mergeReviewMonths(existing?.reviewMonths, row.reviewMonths),
    };
    if (idx >= 0) next[idx] = item;
    else next.push(item);
  }
  return next.sort((a, b) => a.reviewerId.localeCompare(b.reviewerId, "zh-Hant"));
}
