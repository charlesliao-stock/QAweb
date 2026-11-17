/**
 * 結果分析下探權限（v1.50.0）：純函式，可單元測試。
 *
 * 護理長（D12 既定規則）：可看自己單位的指標審查結果＋該指標全院彙總比較，
 * 但看不到其他單位結果與個人細項。下探時：
 * - 非護理長：維持原權限（不擋）。
 * - 護理長：只有下探範圍限定在其本人單位（visibleUnitCodes，含單位沿革）
 *   時可下探；未指定單位（組別／指標分析，資料已依權限範圍過濾為本人單位）
 *   時亦可下探；指定到其他單位時不可下探。
 */
export function canOpenDrill(args: {
  isNurseLeader: boolean;
  scopeUnitId?: string;
  visibleUnitCodes: ReadonlySet<string>;
}): boolean {
  if (!args.isNurseLeader) return true;
  if (!args.scopeUnitId) return true;
  return args.visibleUnitCodes.has(args.scopeUnitId);
}
