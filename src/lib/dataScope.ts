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
