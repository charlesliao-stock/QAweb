/**
 * 職編→姓名對照（v1.50.0：顯示統一「職編/遮罩姓名」用）。
 *
 * users 集合走共用快取（getCachedRefCollection），同分頁只讀一次；
 * 讀取失敗（例如權限不足）時回空對照，呼叫端 staffLabel 會退回只顯示職編。
 */
import { useEffect, useState } from "react";
import { readFirebaseUsersForReviewerManagement } from "./firebase";

export function useStaffNameMap(): Map<string, string> {
  const [map, setMap] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    let alive = true;
    void readFirebaseUsersForReviewerManagement()
      .then((rows) => {
        if (!alive) return;
        setMap(new Map(rows.map((r) => [r.staffId, r.name])));
      })
      .catch(() => {
        // 讀不到人員檔時維持空對照，顯示退回職編
      });
    return () => {
      alive = false;
    };
  }, []);
  return map;
}
