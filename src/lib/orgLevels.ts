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

/** 預設職稱層級：部級→單位（v1.88.8：4 層併回 2 層；主任／副主任／督導同屬部級） */
export const DEFAULT_TITLE_LEVELS: OrgLevel[] = [
  { id: "tl-dept", name: "部級", order: 0 },
  { id: "tl-unit", name: "單位", order: 1 },
];

/** 部級／單位層級 id（v1.88.8 起的現行 id） */
export const DEPT_TITLE_LEVEL_ID = "tl-dept";
export const UNIT_TITLE_LEVEL_ID = "tl-unit";

/** v1.87.0 拆出的三層 id（v1.88.8 起為舊層級，遷移後清理） */
export const LEGACY_TITLE_LEVEL_IDS = [
  "tl-director",
  "tl-deputy",
  "tl-supervisor",
] as const;

/** 職稱遷移對照（按名；v1.88.8：部級＝主任／副主任／督導，單位＝護理長/副護理長／護理師／護士） */
export const TITLE_LEVEL_ID_BY_NAME: Record<string, string> = {
  主任: "tl-dept",
  副主任: "tl-dept",
  督導: "tl-dept",
  護理部主任: "tl-dept",
  護理部副主任: "tl-dept",
  護理部督導: "tl-dept",
  "護理長/副護理長": "tl-unit",
  護理長: "tl-unit",
  副護理長: "tl-unit",
  護理師: "tl-unit",
  護士: "tl-unit",
};

/** v1.87.0：舊部級層級 id；v1.88.8 起部級層級重新啟用此 id（遷移後不再是舊值，僅供 v1.87.0 遷移函式對照） */
export const LEGACY_DEPT_TITLE_LEVEL_ID = "tl-dept";

/**
 * 職稱正規名稱（v1.88.8）：
 * - 去「護理部」前綴（護理部主任→主任、護理部督導→督導）；
 * - 護理長／副護理長皆視為合併後職稱「護理長/副護理長」。
 */
export function canonicalTitleName(name: string): string {
  const stripped = name.trim().replace(/^護理部/, "");
  if (stripped === "護理長" || stripped === "副護理長")
    return "護理長/副護理長";
  return stripped;
}

export function titleLevelIdForName(name: string): string {
  if (TITLE_LEVEL_ID_BY_NAME[name]) return TITLE_LEVEL_ID_BY_NAME[name];
  return TITLE_LEVEL_ID_BY_NAME[canonicalTitleName(name)] ?? "";
}

/** 合併後護理長職稱名稱（v1.88.8） */
export const MERGED_HEAD_NURSE_TITLE = "護理長/副護理長";

/**
 * 層級內排序（v1.88.8 補項）：order 小在上；無 order 者排最後，再按名稱。
 * order 是職稱／角色文件上的欄位，由管理員在頁面以上移／下移調整，
 * 層級內的上下順序即階層（組織由大到小、同一層級內上管下）。
 */
export interface OrderableItem {
  id: string;
  name: string;
  levelId?: string;
  order?: number;
}

export function sortByOrder<T extends { order?: number; name: string }>(
  items: T[],
): T[] {
  return [...items].sort(
    (a, b) =>
      (a.order ?? Number.POSITIVE_INFINITY) -
        (b.order ?? Number.POSITIVE_INFINITY) ||
      a.name.localeCompare(b.name, "zh-Hant"),
  );
}

/**
 * 同層級內的下一個（v1.88.8 補項：下屬鏈改讀 order，不寫死職稱名）。
 * 同 levelId 且 order 嚴格大於本項者中 order 最小者（同 order 者以名稱排序取先）；
 * 無更大 order 者回傳 undefined（該項為該層最末，下屬另議——督導→單位清單）。
 */
export function nextInLevel<T extends OrderableItem>(
  items: T[],
  current: T,
): T | undefined {
  const cur = current.order ?? Number.POSITIVE_INFINITY;
  const candidates = items.filter(
    (t) =>
      t.id !== current.id &&
      (t.levelId ?? "") === (current.levelId ?? "") &&
      (t.order ?? Number.POSITIVE_INFINITY) > cur,
  );
  if (candidates.length === 0) return undefined;
  return sortByOrder(candidates)[0];
}

/** 同層級內新增項目的 order（現有最大值＋1；無有效值時為 0） */
export function nextOrderInLevel(
  items: Array<{ levelId?: string; order?: number }>,
  levelId: string,
): number {
  const orders = items
    .filter((t) => (t.levelId ?? "") === levelId)
    .map((t) => t.order ?? Number.NEGATIVE_INFINITY)
    .filter((o) => Number.isFinite(o) && o < Number.MAX_SAFE_INTEGER);
  return orders.length === 0 ? 0 : Math.max(...orders) + 1;
}

/**
 * 順序初值對照（v1.88.8 補項：僅供遷移回填與載入退回的一次性初值；
 * 鏈的推導只讀 order 欄位，不讀名稱。管理員之後以頁面上移／下移調整，
 * 調整後 order 即為準）。
 * 部級：主任 0、副主任 1、督導 2（「護理部」變體與本名同階）；
 * 單位：護理長/副護理長 0、護理師 1、護士 2。
 */
export const TITLE_SEED_ORDER: Record<string, number> = {
  主任: 0,
  副主任: 1,
  督導: 2,
  護理部主任: 0,
  護理部副主任: 1,
  護理部督導: 2,
  "護理長/副護理長": 0,
  護理長: 0,
  副護理長: 0,
  護理師: 1,
  護士: 2,
};

export function seedOrderForTitle(name: string): number | undefined {
  return TITLE_SEED_ORDER[name] ?? TITLE_SEED_ORDER[canonicalTitleName(name)];
}

/** 角色順序初值（委員會／品管組／單位三層，依 2026-11-12 定案清單順序） */
export const ROLE_SEED_ORDER: Record<string, number> = {
  委員會召集人: 0,
  委員會執行秘書: 1,
  委員會執行幹事: 2,
  品管組召集人: 0,
  品管組副召集人: 1,
  品管組執行幹事: 2,
  品管組組長: 3,
  品管組審查員: 4,
  單位召集人: 0,
  單位執行幹事: 1,
  單位組長: 2,
  單位審查員: 3,
};

export function seedOrderForRole(name: string): number | undefined {
  return ROLE_SEED_ORDER[name];
}

/** 是否為督導職稱（正規名為「督導」；含「護理部督導」變體） */
export function isSupervisorTitleName(name: string): boolean {
  return canonicalTitleName(name) === "督導";
}

export interface HeadNurseMergePlan {
  /** 保留的職稱文件 id（null＝三者皆無，需新建） */
  targetId: string | null;
  /** 保留的文件是否需更名為「護理長/副護理長」 */
  targetNeedsRename: boolean;
  /** 合併後應刪除的舊職稱文件 id */
  mergeFromIds: string[];
}

/**
 * 護理長／副護理長合併計畫（純函式，v1.88.8）：
 * 已有合併名文件者以其為準；否則留護理長改名；再否留副護理長改名；皆無則新建。
 */
export function planHeadNurseMerge(
  titles: Array<{ id: string; name: string }>,
): HeadNurseMergePlan {
  const merged = titles.find((t) => t.name === MERGED_HEAD_NURSE_TITLE);
  const head = titles.find((t) => t.name === "護理長");
  const deputy = titles.find((t) => t.name === "副護理長");
  if (merged) {
    return {
      targetId: merged.id,
      targetNeedsRename: false,
      mergeFromIds: [head?.id, deputy?.id].filter(
        (x): x is string => Boolean(x),
      ),
    };
  }
  if (head) {
    return {
      targetId: head.id,
      targetNeedsRename: true,
      mergeFromIds: deputy ? [deputy.id] : [],
    };
  }
  if (deputy) {
    return {
      targetId: deputy.id,
      targetNeedsRename: true,
      mergeFromIds: [],
    };
  }
  return { targetId: null, targetNeedsRename: false, mergeFromIds: [] };
}

/** 預設角色層級：委員會→品管組→單位 */
export const DEFAULT_ROLE_LEVELS: OrgLevel[] = [
  { id: "rl-committee", name: "委員會", order: 0 },
  { id: "rl-qi", name: "品管組", order: 1 },
  { id: "rl-unit", name: "單位", order: 2 },
];

/** 角色遷移對照（按名稱前綴） */
export function roleLevelIdForName(name: string): string {
  if (name.startsWith("委員會")) return "rl-committee";
  if (name.startsWith("品管組")) return "rl-qi";
  if (name.startsWith("單位")) return "rl-unit";
  return "";
}

/** 新角色規格（v1.55.0 一次建立，預設零權限；v1.57.0 A3：不再寫 category／kind，身分由名稱關鍵字推導、範圍由層級推導） */
export interface NewRoleSpec {
  name: string;
  levelId: string;
  description: string;
}

export const NEW_ROLES: NewRoleSpec[] = [
  {
    name: "委員會召集人",
    levelId: "rl-committee",
    description: "委員會召集人：委員會層級的召集與監督。",
  },
  {
    name: "委員會執行秘書",
    // v1.57.0 A3：執行秘書由名稱關鍵字推導為執行幹事類別（同 v1.55.0 判定）。
    levelId: "rl-committee",
    description: "委員會執行秘書：委員會層級的執行事務。",
  },
  {
    name: "委員會執行幹事",
    levelId: "rl-committee",
    description: "委員會執行幹事：委員會層級的執行事務。",
  },
  {
    name: "品管組副召集人",
    levelId: "rl-qi",
    description: "品管組副召集人：所屬群組的排程權限與審查監督（組級）。",
  },
  {
    name: "品管組組長",
    levelId: "rl-qi",
    description: "品管組組長：所屬群組的組務（組級）。",
  },
  {
    name: "單位組長",
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

/** 排序用層級序號：對不上任何層級者排最後（Infinity） */
export function levelRank(levels: OrgLevel[], levelId: string | undefined): number {
  const idx = sortedLevels(levels).findIndex((l) => l.id === levelId);
  return idx >= 0 ? idx : Number.POSITIVE_INFINITY;
}

/**
 * 依層級順序排序（層級 order → 次級排序鍵 → 名稱）。
 * 無層級者排最後。純函式，不改動輸入陣列。
 */
export function sortByLevel<T extends { name: string; levelId?: string }>(
  items: T[],
  levels: OrgLevel[],
  secondary?: (item: T) => number,
): T[] {
  const sorted = sortedLevels(levels);
  const rank = (id: string | undefined) => {
    const idx = sorted.findIndex((l) => l.id === id);
    return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
  };
  return [...items].sort(
    (a, b) =>
      rank(a.levelId) - rank(b.levelId) ||
      (secondary ? secondary(a) - secondary(b) : 0) ||
      a.name.localeCompare(b.name, "zh-Hant"),
  );
}
