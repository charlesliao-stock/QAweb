/**
 * 資料可見範圍（v1.88.4）：CAPA 與結果分析共用的純函式，不碰 Firestore。
 *
 * 使用者已定的範圍模型（不得擅自改定義）：
 * 1. 每個角色或職稱的跨區／不跨區，就是能不能看自己單位或品管組以外的
 *    東西——跨區＝可看範圍外，不跨區＝只看自己範圍。
 * 2. 能不能跨是橫向，從屬是縱向——兩軸分開：橫向 cross 管同層可見範圍，
 *    縱向從屬管上層看下層。
 * 3. 單位召集人只看自己單位（cross=false 時）。
 * 4. 先前「跨區先只管功能開關、資料範圍另議」已被取代，資料範圍須接上 cross。
 *
 * 以下語意是本版採用的假設（與程式現況或使用者定義衝突時以使用者定義為準），
 * 標「待使用者確認」，尚未定案——見 resolveDataScope 內註解與驗收報告：
 * - A1：主任／副主任（isHospitalHead）→ 全院。
 * - A2：群組層級角色 cross=true → 全部群組（全部單位）。
 * - A3：單位層級角色／職稱 cross=true → 所屬品管組內全部單位。
 * - A4：委員會層級角色（角色名 委員會開頭，或 membership groupId 為 ALL）→ 全院。
 * - A5：品管組層級角色 → 所屬群組（memberships 的 groupId）內全部單位。
 *
 * 範圍取聯集：任一身分放寬即放寬；管理員以外、沒有任何放寬來源時只看本人單位。
 * 審查員分支由呼叫端保留（結果分析：任務單位；CAPA：無任務概念，取靜態範圍）。
 */

import { roleLevelIdForName } from "./orgLevels";
import { deriveRoleScope } from "./roleDerivation";
import type { Membership } from "./roleIdentity";
import { COMMITTEE_GROUP_ID } from "./roleIdentity";
import type { AssignmentItem } from "./scheduling";
import { unitHistoryCodes, type UnitHistoryLink } from "./unitHistory";

/** 單位對照（code＝units 文件 id；groupId＝所屬品管組，空＝未歸屬） */
export interface DataScopeUnit extends UnitHistoryLink {
  groupId: string;
}

/** 職稱旗標（取 titleFlagsOf 的三項與範圍有關者） */
export interface DataScopeTitleFlags {
  isUnitHead: boolean;
  isDistrictHead: boolean;
  isHospitalHead: boolean;
}

/**
 * 橫向 cross 旗標（直接讀 catalog.templates 的 cross，不經 can()——
 * can() 是角色範本與職稱範本的交集，會誤判）：
 * - unitRole：任一單位層級角色名對應範本（unitRole__<角色名>）cross=true；
 * - groupRole：任一群組層級角色名對應範本（group__<角色名>）cross=true；
 * - title：職稱範本（unit__<職稱>）cross=true。
 * 角色名所屬類別依名稱含「單位」區分（與 deriveTemplateRowNames 一致）。
 */
export interface DataScopeCross {
  unitRole: boolean;
  groupRole: boolean;
  title: boolean;
}

export interface DataScopeInput {
  isAdmin: boolean;
  roles: string[];
  title: string;
  titleFlags: DataScopeTitleFlags;
  memberships: Membership[];
  unitCode: string;
  /** 督導轄區單位清單（titleUnitCodes） */
  titleUnitCodes: string[];
  units: DataScopeUnit[];
  /** 單位→所屬群組對照（unitCode → groupId） */
  unitGroups: Record<string, string>;
  cross: DataScopeCross;
  /** 是否具審查員身分（isReviewerRole；供呼叫端決定是否走 reviewer 分支） */
  isReviewer: boolean;
}

export type DataScopeResult =
  | {
      kind: "all";
      unitCodes: Set<string>;
      groupIds: Set<string>;
    }
  | {
      kind: "units";
      unitCodes: Set<string>;
      groupIds: Set<string>;
      isReviewer: boolean;
    };

/**
 * 由 permissionTemplates 直接推導 cross 旗標（純函式）。
 * templates 以 `${category}:${name}` 為鍵（與 usePermissions 的 catalog 一致）；
 * 無範本＝不跨（false），不再給預設值。
 */
export function deriveCrossFlags(
  templates: Record<string, { cross: boolean }>,
  roles: string[],
  title: string,
): DataScopeCross {
  const out: DataScopeCross = { unitRole: false, groupRole: false, title: false };
  for (const name of new Set(roles)) {
    if (!name) continue;
    const category = name.includes("單位") ? "unitRole" : "group";
    const template = templates[`${category}:${name}`];
    if (template?.cross === true) {
      if (category === "unitRole") out.unitRole = true;
      else out.groupRole = true;
    }
  }
  if (title && templates[`unit:${title}`]?.cross === true) {
    out.title = true;
  }
  return out;
}

function roleLevelScope(name: string): "group" | "unit" {
  const levelId = roleLevelIdForName(name);
  if (levelId === "rl-unit") return "unit";
  if (levelId === "rl-committee" || levelId === "rl-qi") return "group";
  return deriveRoleScope({ name });
}

/** 可見單位集合 → 其所屬群組集合（單位未歸組者不計入群組）。 */
function groupIdsOfUnits(
  unitCodes: Iterable<string>,
  units: DataScopeUnit[],
  unitGroups: Record<string, string>,
): Set<string> {
  const byCode = new Map(units.map((u) => [u.code, u.groupId]));
  const out = new Set<string>();
  for (const code of unitCodes) {
    const gid = unitGroups[code] ?? byCode.get(code) ?? "";
    if (gid) out.add(gid);
  }
  return out;
}

/**
 * 解析可見範圍（純函式，各來源取聯集）。
 *
 * 縱向（從屬，上層看下層）：
 * - 管理員、主任／副主任（A1）、委員會層級角色（A4）→ 全部；
 * - 品管組層級角色（A5）→ memberships 所屬群組內全部單位；
 * - 督導（isDistrictHead）→ titleUnitCodes 全部單位；
 * - 護理長（isUnitHead）→ 本人單位＋沿革合併單位（unitHistoryCodes）。
 * 橫向（cross，同層可見範圍）：
 * - 群組層級角色 cross=true（A2）→ 全部；
 * - 單位層級角色／職稱 cross=true（A3）→ 所屬品管組內全部單位。
 * 其餘單位層級角色 → 本人單位；無任何放寬來源 → 本人單位。
 * 審查員的任務單位由呼叫端（結果分析）另行聯集，不在本函式內處理。
 */
export function resolveDataScope(input: DataScopeInput): DataScopeResult {
  const allUnitCodes = input.units.map((u) => u.code);
  const allGroupIds = new Set(
    input.units.map((u) => u.groupId).filter(Boolean),
  );
  const all = (): DataScopeResult => ({
    kind: "all",
    unitCodes: new Set(allUnitCodes),
    groupIds: allGroupIds,
  });

  if (input.isAdmin) return all();
  // A1（待使用者確認）：主任／副主任 → 全院。
  if (input.titleFlags.isHospitalHead) return all();
  // A4（待使用者確認）：委員會層級角色 → 全院（角色名 委員會開頭，或
  // membership 以 ALL 登記；ALL 是委員會特殊群組值，見 roleIdentity）。
  const isCommitteeRole = input.roles.some(
    (name) => roleLevelIdForName(name) === "rl-committee",
  );
  const hasCommitteeMembership = input.memberships.some(
    (m) => m.groupId === COMMITTEE_GROUP_ID,
  );
  if (isCommitteeRole || hasCommitteeMembership) return all();
  // A2（待使用者確認）：群組層級角色 cross=true → 全部群組。
  if (input.cross.groupRole) return all();

  const unitsOfGroup = (groupId: string): string[] =>
    input.units.filter((u) => u.groupId === groupId).map((u) => u.code);
  const ownGroupId =
    input.unitGroups[input.unitCode] ??
    input.units.find((u) => u.code === input.unitCode)?.groupId ??
    "";

  const visible = new Set<string>();
  // 縱向：品管組層級角色 → memberships 所屬群組內全部單位（A5）。
  for (const membership of input.memberships) {
    if (!membership.groupId || membership.groupId === COMMITTEE_GROUP_ID) {
      continue;
    }
    for (const roleName of membership.roles) {
      if (roleLevelScope(roleName) === "group") {
        for (const code of unitsOfGroup(membership.groupId)) {
          visible.add(code);
        }
      }
    }
  }
  // 縱向：督導 → 轄區單位清單。
  if (input.titleFlags.isDistrictHead) {
    for (const code of input.titleUnitCodes) {
      if (code) visible.add(code);
    }
  }
  // 縱向：護理長 → 本人單位＋沿革合併單位。
  if (input.titleFlags.isUnitHead && input.unitCode) {
    for (const code of unitHistoryCodes(input.units, input.unitCode)) {
      visible.add(code);
    }
  }
  // 單位層級角色 → 本人單位（單位召集人 cross=false 時只看自己單位，已定案）。
  const hasUnitRole = input.roles.some(
    (name) => roleLevelScope(name) === "unit",
  );
  if (hasUnitRole && input.unitCode) visible.add(input.unitCode);
  // 橫向（A3，待使用者確認）：單位角色／職稱 cross=true → 所屬品管組內全部單位。
  if ((input.cross.unitRole || input.cross.title) && ownGroupId) {
    for (const code of unitsOfGroup(ownGroupId)) {
      visible.add(code);
    }
  }
  // 兜底：管理員以外、沒有任何放寬來源時只看本人單位。
  if (visible.size === 0 && input.unitCode) visible.add(input.unitCode);

  return {
    kind: "units",
    unitCodes: visible,
    groupIds: groupIdsOfUnits(visible, input.units, input.unitGroups),
    isReviewer: input.isReviewer,
  };
}

/* ================= 排程範圍（v1.88.5）：單位召集人／執行幹事 =================
 *
 * 使用者新定規則（以此為準）：
 * - 單位的召集人、執行幹事可以（只能）幫自己單位排程；
 * - 指標可以來自各品管組（不設限）；
 * - 但看不到其他單位的排程。
 *
 * 本節與上節同一口徑（橫向 cross＋縱向從屬），不另立一套。以下兩點是本版
 * 的詮釋（待使用者確認，見驗收報告 §5）：
 * - S1：排程權限與 cross 無關。cross 管資料可見範圍（CAPA／結果分析），
 *   排程是「幫誰排」的權限：點名的兩個角色不論 cross=true／false，都只
 *   能幫自己單位排程、只看得到自己單位的排程內容。cross=true 時，這兩
 *   個角色在 CAPA／結果分析仍依 A3 看所屬品管組，排程頁仍只限自己單位。
 * - S2：「不限單位」對這兩個角色不提供：不限單位等於幫所有單位排，與
 *   「只能幫自己單位」直接衝突，故停用（既有不限單位排程仍看得到、不
 *   會因本版消失；該角色亦不得將其改為指定單位以外、或刪除它，見
 *   scheduleDeletableByUnit）。
 * 只針對點名的兩個角色；管理員、委員會、品管組層級角色依上節不變。
 * 其他持 manageSchedule 的單位角色（單位組長／單位審查員等）是否比照，
 * 本版不順手擴大，列為待審定案點。
 */

/** 單位排程者角色（使用者點名，依角色名稱比對，與 permissionTemplates 無關） */
export const UNIT_SCHEDULER_ROLE_NAMES = [
  "單位召集人",
  "單位執行幹事",
] as const;

/** 是否為單位排程者（點名的兩個角色其一；系統管理員 bypass，不受限） */
export function isUnitSchedulerRole(
  roles: string[],
  isAdmin: boolean,
): boolean {
  if (isAdmin) return false;
  return roles.some((r) =>
    (UNIT_SCHEDULER_ROLE_NAMES as readonly string[]).includes(r),
  );
}

/** 排程文件／分工表項目的最小單位形狀（本節純函式只依賴這兩個欄位） */
export interface ScheduleUnitRef {
  unitIds: readonly string[];
  unlimitedUnits?: boolean;
}

export interface AssignmentItemUnitRef {
  units: readonly { unitId: string }[];
  unlimitedUnits?: boolean;
}

/**
 * 排程是否涵蓋該單位：不限單位＝涵蓋（不限單位排程的任務 unitId 為 ""，
 * 屬該單位的受審範圍）；否則看 unitIds 是否含該單位。
 */
export function scheduleInvolvesUnit(
  s: ScheduleUnitRef | null | undefined,
  unitCode: string,
): boolean {
  if (!s || !unitCode) return false;
  if (s.unlimitedUnits === true) return true;
  return s.unitIds.includes(unitCode);
}

/** 分工表項目是否涵蓋該單位（不限單位項目＝涵蓋） */
export function assignmentItemInvolvesUnit(
  item: AssignmentItemUnitRef,
  unitCode: string,
): boolean {
  if (!unitCode) return false;
  if (item.unlimitedUnits === true) return true;
  return item.units.some((u) => u.unitId === unitCode);
}

/** 分工表是否含該單位的項目 */
export function assignmentInvolvesUnit(
  items: readonly AssignmentItemUnitRef[],
  unitCode: string,
): boolean {
  return items.some((it) => assignmentItemInvolvesUnit(it, unitCode));
}

/**
 * 排程清單列是否對該單位排程者可見：
 * - 臨時列：只看臨時排程本身是否涵蓋自己單位（常規分工表與臨時排程無關）；
 * - 常規列：排程涵蓋自己單位，或分工表含自己單位項目，或兩者皆無
 *   （尚未排程，該角色可為自己單位新建）；
 * - 其餘（排程／分工表皆有內容、但皆不含自己單位）→ 整列隱藏。
 */
export function rowHasOwnUnitScheduleContent(
  schedule: ScheduleUnitRef | null | undefined,
  assignmentItems: readonly AssignmentItemUnitRef[],
  unitCode: string,
  isTemp: boolean,
): boolean {
  if (!unitCode) return false;
  if (isTemp) return scheduleInvolvesUnit(schedule, unitCode);
  if (scheduleInvolvesUnit(schedule, unitCode)) return true;
  if (assignmentInvolvesUnit(assignmentItems, unitCode)) return true;
  const noSchedule = !schedule;
  const noAssignment = assignmentItems.length === 0;
  return noSchedule && noAssignment;
}

/**
 * 該單位排程者能否刪除此排程：排程須存在、非不限單位、且 unitIds
 * 全部是自己單位。含其他單位（或不限單位）者僅能由管理員刪除，
 * 否則刪掉的是別單位的排程與其未完成任務。
 */
export function scheduleDeletableByUnit(
  schedule: ScheduleUnitRef | null | undefined,
  unitCode: string,
): boolean {
  if (!schedule || !unitCode) return false;
  if (schedule.unlimitedUnits === true) return false;
  if (schedule.unitIds.length === 0) return false;
  return schedule.unitIds.every((c) => c === unitCode);
}

/**
 * 分工表按單位拆分（單位排程者編輯用）：own＝自己單位的部分
 * （不限單位項目整筆保留、鎖定；含自己單位的項目只留自己單位），
 * other＝其餘部分（不含自己單位的項目；含自己單位的項目只留其他單位）。
 * 兩邊按審查員合併後即還原（見 mergeAssignmentItemsByReviewer）。
 * 純函式；AssignmentItem 以 type-only 引入，不產生執行期循環依賴。
 */
export function splitAssignmentItemsByUnit(
  items: readonly AssignmentItem[],
  unitCode: string,
): { own: AssignmentItem[]; other: AssignmentItem[] } {
  const own: AssignmentItem[] = [];
  const other: AssignmentItem[] = [];
  for (const it of items) {
    if (it.unlimitedUnits === true) {
      own.push(it);
      continue;
    }
    const ownUnits = it.units.filter((u) => u.unitId === unitCode);
    const otherUnits = it.units.filter((u) => u.unitId !== unitCode);
    if (ownUnits.length > 0) {
      own.push({ ...it, units: ownUnits });
    }
    if (otherUnits.length > 0) {
      other.push({ ...it, units: otherUnits });
    }
  }
  return { own, other };
}

/**
 * 拆分後的分工表按審查員合併還原：同一審查員的單位取聯集；任一邊為
 * 不限單位者，合併後仍為不限單位（units 清空）。
 */
export function mergeAssignmentItemsByReviewer(
  own: readonly AssignmentItem[],
  other: readonly AssignmentItem[],
): AssignmentItem[] {
  const byReviewer = new Map<string, AssignmentItem>();
  const mergeOne = (it: AssignmentItem) => {
    const prev = byReviewer.get(it.reviewerId);
    if (!prev) {
      byReviewer.set(it.reviewerId, {
        ...it,
        units: it.units.map((u) => ({ ...u })),
      });
      return;
    }
    if (prev.unlimitedUnits === true || it.unlimitedUnits === true) {
      byReviewer.set(it.reviewerId, {
        ...prev,
        units: [],
        unlimitedUnits: true as const,
      });
      return;
    }
    const seen = new Map(prev.units.map((u) => [u.unitId, u]));
    for (const u of it.units) {
      if (!seen.has(u.unitId)) seen.set(u.unitId, { ...u });
    }
    byReviewer.set(it.reviewerId, {
      ...prev,
      units: [...seen.values()].sort((a, b) =>
        a.unitId.localeCompare(b.unitId, "zh-Hant"),
      ),
    });
  };
  for (const it of other) mergeOne(it);
  for (const it of own) mergeOne(it);
  return [...byReviewer.values()].sort((a, b) =>
    a.reviewerId.localeCompare(b.reviewerId, "zh-Hant"),
  );
}
