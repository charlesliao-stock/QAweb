/**
 * 職稱／角色層級（v1.55.0，方案 A：層級做成可管理資料）。
 *
 * 層級集合：titleLevels／roleLevels（文件欄位 id、name、order）。
 * titles／roles 文件各加 levelId（字串，空＝未分層級）。
 * 本檔皆為純函式，可 node 測試，不依賴 Firestore。
 */

/** 層級（一筆文件） */
export interface OrgLevel {
  id: string;
  name: string;
  order: number;
}

/** 預設職稱層級：部級→單位 */
export const DEFAULT_TITLE_LEVELS: OrgLevel[] = [
  { id: "tl-dept", name: "部級", order: 0 },
  { id: "tl-unit", name: "單位", order: 1 },
];

/** 預設角色層級：委員會→品管組→單位 */
export const DEFAULT_ROLE_LEVELS: OrgLevel[] = [
  { id: "rl-committee", name: "委員會", order: 0 },
  { id: "rl-qi", name: "品管組", order: 1 },
  { id: "rl-unit", name: "單位", order: 2 },
];

/** 職稱遷移對照（按名） */
export const TITLE_LEVEL_ID_BY_NAME: Record<string, string> = {
  主任: "tl-dept",
  副主任: "tl-dept",
  督導: "tl-dept",
  護理長: "tl-unit",
  副護理長: "tl-unit",
  護理師: "tl-unit",
};

export function titleLevelIdForName(name: string): string {
  return TITLE_LEVEL_ID_BY_NAME[name] ?? "";
}

/** 角色遷移對照（按名稱前綴） */
export function roleLevelIdForName(name: string): string {
  if (name.startsWith("委員會")) return "rl-committee";
  if (name.startsWith("品管組")) return "rl-qi";
  if (name.startsWith("單位")) return "rl-unit";
  return "";
}

/** 新角色規格（v1.55.0 一次建立，預設零權限） */
export interface NewRoleSpec {
  name: string;
  category: string;
  kind: "group" | "unit";
  levelId: string;
  description: string;
}

export const NEW_ROLES: NewRoleSpec[] = [
  {
    name: "委員會召集人",
    category: "convener",
    kind: "group",
    levelId: "rl-committee",
    description: "委員會召集人：委員會層級的召集與監督。",
  },
  {
    name: "委員會執行秘書",
    // v1.55.0：第 2 項唯一由名稱推斷的判斷——執行秘書歸執行幹事類別。
    // 若執行秘書另有慣例，應改此處並同步更新權限範本，不默默改成一般。
    category: "officer",
    kind: "group",
    levelId: "rl-committee",
    description: "委員會執行秘書：委員會層級的執行事務。",
  },
  {
    name: "委員會執行幹事",
    category: "officer",
    kind: "group",
    levelId: "rl-committee",
    description: "委員會執行幹事：委員會層級的執行事務。",
  },
  {
    name: "品管組副召集人",
    category: "convener",
    kind: "group",
    levelId: "rl-qi",
    description: "品管組副召集人：所屬群組的排程權限與審查監督（組級）。",
  },
  {
    name: "品管組組長",
    category: "general",
    kind: "group",
    levelId: "rl-qi",
    description: "品管組組長：所屬群組的組務（組級）。",
  },
  {
    name: "單位組長",
    category: "general",
    kind: "unit",
    levelId: "rl-unit",
    description: "單位組長：所屬單位的組務（單位級）。",
  },
];

/** 舊名清理（v1.55.0 第 9 項）：舊「品管執行幹事」→「品管組執行幹事」 */
export const OLD_ROLE_NAME = "品管執行幹事";
export const OLD_ROLE_REPLACEMENT = "品管組執行幹事";

/** 按層級分組後的一個區段（level 為 null＝未分層級） */
export interface LevelSection<T> {
  level: OrgLevel | null;
  items: T[];
}

/**
 * 依 levelId 分組：有層級的按層級 order 排序；無層級（空或對不上）
 * 的放最後「未分層級」區；沒有項目的層級不出區段。
 */
export function groupByLevel<T extends { levelId?: string }>(
  items: T[],
  levels: OrgLevel[],
): LevelSection<T>[] {
  const sorted = sortedLevels(levels);
  const sections: LevelSection<T>[] = sorted.map((level) => ({ level, items: [] }));
  const ungrouped: T[] = [];
  for (const item of items) {
    const idx = sorted.findIndex((l) => l.id === item.levelId);
    if (idx >= 0) sections[idx].items.push(item);
    else ungrouped.push(item);
  }
  const out = sections.filter((s) => s.items.length > 0);
  if (ungrouped.length > 0) out.push({ level: null, items: ungrouped });
  return out;
}

/** 層級刪除擋下規則：底下還有項目就不能刪 */
export function canDeleteLevel(
  items: Array<{ levelId?: string }>,
  levelId: string,
): boolean {
  return !items.some((i) => i.levelId === levelId);
}

/** 層級依 order 排序（order 相同時按名稱） */
export function sortedLevels(levels: OrgLevel[]): OrgLevel[] {
  return [...levels].sort(
    (a, b) => a.order - b.order || a.name.localeCompare(b.name, "zh-Hant"),
  );
}

/** 新增層級的 order（接在最後） */
export function nextLevelOrder(levels: OrgLevel[]): number {
  return levels.length === 0 ? 0 : Math.max(...levels.map((l) => l.order)) + 1;
}

/** 匯入時以層級名稱查 id（查不到＝未分層級） */
export function levelIdByName(levels: OrgLevel[], name: string): string {
  return levels.find((l) => l.name === name)?.id ?? "";
}
