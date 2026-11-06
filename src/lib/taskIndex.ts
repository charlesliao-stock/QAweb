/**
 * 任務索引純函式（v1.28 階段 6 B5 抽出，供測試對照）。
 *
 * reviewTasks 文件 → Map<indicatorId, Map<"年-月", { pending, done }>>。
 * 規則與改前每指標查詢版完全一致（逐筆對照，見 scripts/test-v1.28-wave2.mjs）：
 * - 缺 indicatorId、缺年或缺月的文件不計入；
 * - status === "done" 計 done，其餘（pending／locked／其他）一律計 pending；
 * - 同一指標同年月的筆數累加。
 * 本檔零依賴、不碰 DOM、不碰 Firestore，可在 node 直接單元測試。
 */

export interface TaskIndexEntry {
  pending: number;
  done: number;
}

export type TaskIndex = Map<string, Map<string, TaskIndexEntry>>;

export function buildTaskIndex(
  docs: Array<{ data: () => Record<string, unknown> }>,
): TaskIndex {
  const idx: TaskIndex = new Map();
  docs.forEach((d) => {
    const v = d.data();
    const iid = typeof v.indicatorId === "string" ? v.indicatorId : "";
    if (!iid) return;
    const y = Number(v.year ?? 0);
    const mo = Number(v.month ?? 0);
    if (!y || !mo) return;
    const m = idx.get(iid) ?? new Map<string, TaskIndexEntry>();
    const k = `${y}-${mo}`;
    const e = m.get(k) ?? { pending: 0, done: 0 };
    if (v.status === "done") e.done += 1;
    else e.pending += 1;
    m.set(k, e);
    idx.set(iid, m);
  });
  return idx;
}
