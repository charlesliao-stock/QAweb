/**
 * v1.59.1：品管審查頁審查員可見範圍聯集＋檢視彈窗限縮（純函式，可單測）。
 *
 * 任務→排程對應鍵：reviewTasks 沒有 scheduleId，以
 *   scheduleDocId(indicatorId, category, period)
 *   ＝ `{indicatorId}__{category}__{period}`
 * 對應（scheduleTaskBuilder.ts 寫任務時帶 scheduleCategory／schedulePeriod）。
 * 舊任務缺 scheduleCategory／schedulePeriod 時 fallback：同一指標、任務年月
 * 落在唯一一個排程區間內才歸屬；多個排程都含該年月時不歸屬（不誤放）。
 * 新任務一律帶鍵，fallback 只影響舊資料。
 *
 * 檢視彈窗限縮（每列各自算，scope 為 null＝該列全部單位可見）：
 * - 管理員／高階主管：全部可見（null）。
 * - 召集人／執行幹事：該列指標在其所屬群組內時，整列可見（null）——
 *   範圍是群組，不是單一單位，不可縮成 assignedUnitIds。
 * - 護理長：僅自審排程且本人單位在內時，只看本人單位。
 * - 審查員：只看自己被指派的單位（分工表＋任務指派的聯集）。
 * 多重身分取聯集；沒有任何分支貢獻時回 []（fail closed，什麼都不顯示）。
 */

/** reviewTasks 一筆本人任務（AuditPage 查詢後轉成的最小形狀） */
export interface AuditTaskLike {
  indicatorId: string;
  scheduleCategory?: string;
  schedulePeriod?: string;
  year: number;
  month: number;
  unitId: string;
}

/** 排程一筆（AuditPage 以 scheduleDocId 算 key、區間月份鍵集合傳入） */
export interface AuditScheduleLike {
  key: string;
  indicatorId: string;
  /** 區間內全部年月鍵，格式與 reviewActive.ymKey 一致（`年-月`） */
  intervalMonthKeys: Set<string>;
}

export function ymKeyOf(year: number, month: number): string {
  return `${year}-${month}`;
}

/**
 * 本人任務按排程分組：排程 key → 該排程下本人被指派的單位集合
 * （""＝不限單位 NA 任務的 unitId，原樣保留）。
 */
export function taskUnitsBySchedule(
  tasks: AuditTaskLike[],
  schedules: AuditScheduleLike[],
): Map<string, Set<string>> {
  const byKey = new Map<string, AuditScheduleLike>();
  const byIndicator = new Map<string, AuditScheduleLike[]>();
  for (const s of schedules) {
    byKey.set(s.key, s);
    const list = byIndicator.get(s.indicatorId) ?? [];
    list.push(s);
    byIndicator.set(s.indicatorId, list);
  }
  const out = new Map<string, Set<string>>();
  const add = (key: string, unitId: string) => {
    const set = out.get(key) ?? new Set<string>();
    set.add(unitId);
    out.set(key, set);
  };
  for (const t of tasks) {
    if (!t.indicatorId) continue;
    // (a) 精確鍵：新任務一律帶 scheduleCategory／schedulePeriod。
    if (t.scheduleCategory && t.schedulePeriod) {
      const key = `${t.indicatorId}__${t.scheduleCategory}__${t.schedulePeriod}`;
      if (byKey.has(key)) {
        add(key, t.unitId);
        continue;
      }
      // 鍵指到的排程已不存在（排程被刪、任務殘留）：不歸屬，不誤放。
      continue;
    }
    // (b) 舊任務 fallback：同一指標、任務年月落在唯一一個排程區間內才歸屬。
    const candidates = (byIndicator.get(t.indicatorId) ?? []).filter((s) =>
      s.intervalMonthKeys.has(ymKeyOf(t.year, t.month)),
    );
    if (candidates.length === 1) add(candidates[0].key, t.unitId);
  }
  return out;
}

/** 多組單位聯集（去重；"" NA 保留）。 */
export function unionUnits(...lists: (string[] | undefined)[]): string[] {
  return [...new Set(lists.flatMap((l) => l ?? []))];
}

/** 檢視彈窗可見單位：null＝該列全部單位可見，否則為允許的單位清單。 */
export type ModalUnitScope = string[] | null;

export function modalUnitScope(input: {
  isAdmin: boolean;
  isSenior: boolean;
  /** 該列指標屬於召集人／執行幹事的所屬群組 */
  isConvenerInGroup: boolean;
  /** 護理長分支成立：自審排程且本人單位在排程單位內 */
  isHeadNurseApplies: boolean;
  ownUnitCode: string;
  /** 本人被指派的單位（分工表＋任務指派聯集） */
  assignedUnits: string[];
}): ModalUnitScope {
  if (input.isAdmin || input.isSenior) return null;
  // 召集人／執行幹事：群組範圍＝整列可見（不可縮成單一單位）。
  if (input.isConvenerInGroup) return null;
  const allowed = new Set<string>();
  if (input.isHeadNurseApplies && input.ownUnitCode) {
    allowed.add(input.ownUnitCode);
  }
  for (const u of input.assignedUnits) allowed.add(u);
  return [...allowed];
}

/** 單一單位是否在彈窗可見範圍內（scope null＝全部可見）。 */
export function unitVisibleInModal(
  scope: ModalUnitScope,
  unitId: string,
): boolean {
  return scope === null || scope.includes(unitId);
}
