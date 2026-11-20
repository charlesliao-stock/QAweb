/**
 * 結果分析預設值與複合篩選純函式（v1.88.33 結果分析介面修改）。
 * 本檔零依賴、不碰 DOM、不碰 Firestore，可在 node 直接單元測試。
 */
import { pad2 } from "../../../lib/ym";

export type StatsCycle = "year" | "academic";

/**
 * Q5：起迄預設依系統設定（systemParams/config.statsCycle）。
 * 年度：今年 1 月～本月；學年度：本學年 8 月～本月（8 月起算新學年）。
 */
export function defaultRangeForCycle(
  cycle: StatsCycle,
  now: Date = new Date(),
): { startMonth: string; endMonth: string } {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const endMonth = `${y}-${pad2(m)}`;
  if (cycle === "academic") {
    const startYear = m >= 8 ? y : y - 1;
    return { startMonth: `${startYear}-08`, endMonth };
  }
  return { startMonth: `${y}-01`, endMonth };
}

/** Q4：指標關鍵字篩選（打字模糊比對編號／名稱；空白關鍵字＝全部）。 */
export function filterIndicatorsByKeyword<T extends { code: string; name: string }>(
  indicators: T[],
  keyword: string,
): T[] {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return indicators;
  return indicators.filter(
    (i) =>
      i.code.toLowerCase().includes(kw) ||
      i.name.toLowerCase().includes(kw),
  );
}

/**
 * Q11：單位模式「有排程即列」——該單位在查詢月份內有審查任務的指標 id。
 * 任務由排程產生：有任務即代表有排程，即使尚無審查紀錄。
 */
export function scheduledIndicatorIdsForUnit(
  tasks: Array<{ indicatorId: string; unitId: string; year: number; month: number }>,
  unitCode: string,
  months: Array<{ year: number; month: number }>,
): Set<string> {
  const wanted = new Set(months.map((m) => `${m.year}-${m.month}`));
  const out = new Set<string>();
  for (const t of tasks) {
    if (t.unitId !== unitCode) continue;
    if (!wanted.has(`${t.year}-${t.month}`)) continue;
    if (t.indicatorId) out.add(t.indicatorId);
  }
  return out;
}
