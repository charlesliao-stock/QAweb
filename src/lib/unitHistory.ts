export interface UnitHistoryLink {
  code: string;
  mergedFromUnitCodes?: string[];
}

/** 從現行單位往前展開所有合併來源，回傳現行代碼加歷史單位代碼。 */
export function unitHistoryCodes(units: UnitHistoryLink[], currentCode: string): Set<string> {
  const byCode = new Map(units.map((unit) => [unit.code, unit]));
  const visited = new Set<string>();
  const pending = [currentCode];
  while (pending.length > 0) {
    const code = pending.pop()!;
    if (!code || visited.has(code)) continue;
    visited.add(code);
    for (const source of byCode.get(code)?.mergedFromUnitCodes ?? []) {
      if (source && !visited.has(source)) pending.push(source);
    }
  }
  return visited;
}

/** 來源若已包含目標單位的歷史，新增此連結會形成沿革循環。 */
export function wouldCreateUnitHistoryCycle(
  units: UnitHistoryLink[],
  targetCode: string,
  sourceCodes: string[],
): boolean {
  return sourceCodes.some((source) => unitHistoryCodes(units, source).has(targetCode));
}
