/**
 * 複合索引查詢＋優雅退化（v1.28 階段 7，提案 B7）。
 *
 * 索引：firestore.indexes.json 的 (indicatorId ASC, year ASC)，reviewRecords
 * 與 reviewTasks 各一組。查詢形狀：等號＋等號、無 orderBy、無範圍條件，
 * 該複合索引足以覆蓋（ResultsPage 原查詢只有 where("year", "==", y)）。
 *
 * 部署順序鐵律原本是「索引先部署、確認生效，再上程式」，但本專案目前
 * 沒有可用的索引自動部署路徑（Actions deploy workflow 只部署
 * hosting＋firestore:rules；workflow 檔無法經 REST 推送；本機
 * firebase-tools／Admin API 皆 401），故索引只寫進 indexes 檔、尚未生效。
 * 程式端因此必須優雅退化：先試 indicatorId＋year 查詢，收到
 * FAILED_PRECONDITION（索引未就緒）時退回舊的按年查詢＋前端過濾，
 * 行為與改前一致、絕不讓結果分析掛掉或空白，並在 console 留警告、
 * 畫面顯示一次性提示。
 *
 * 另註：Firestore 對多個等號條件可用索引合併（zigzag merge），兩等號
 * 查詢有可能不需複合索引也能跑——本模組不預設此點，退化邏輯覆蓋兩種情況。
 *
 * 本模組不動 firebase.ts 的 readReviewRecords：v1.14 測試 guard 要求該
 * 移植函式維持單一 where（避免複合索引），且該函式目前無呼叫端；
 * B7 的查詢改寫只走本模組（ResultsPage 用）。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  getDocs as dbGetDocs,
  query as dbQuery,
  where as dbWhere,
} from "./db";

export interface IndexedDoc {
  id: string;
  data: () => unknown;
}

export interface IndexedSnapshot {
  docs: IndexedDoc[];
}

/** 測試接縫：預設走 src/lib/db.ts（真實／demo 雙模式；demoStore 支援多個 where）。 */
export interface IndexedQueryApi {
  query: (ref: any, ...constraints: any[]) => any;
  where: (field: string, op: string, value: any) => any;
  getDocs: (q: any) => Promise<IndexedSnapshot>;
}

export const dbIndexedQueryApi: IndexedQueryApi = {
  query: dbQuery,
  where: dbWhere,
  getDocs: (q: any) =>
    dbGetDocs(q) as unknown as Promise<IndexedSnapshot>,
};

/** 是否為「索引未就緒」錯誤（Firestore FAILED_PRECONDITION）。其他錯誤一律重拋，不退化。 */
export function isIndexMissingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "failed-precondition") return true;
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    /FAILED_PRECONDITION/i.test(message) &&
    /index/i.test(message)
  );
}

export interface IndexedYearFetch {
  docs: IndexedDoc[];
  /** true＝索引未就緒，已退回舊查詢＋前端過濾（結果與改前一致） */
  fellBack: boolean;
  /** true＝這次有加 indicatorId 條件（即查詢曾嘗試走複合索引） */
  usedIndicatorFilter: boolean;
}

/**
 * 按年查一個集合，可選加 indicatorId 等號條件。
 * - 有 indicatorId：先試 where(indicatorId).where(year)；索引未就緒
 *   （FAILED_PRECONDITION）時退回 where(year)＋前端按 indicatorId 過濾。
 * - 無 indicatorId：維持舊的按年查詢。
 * - 索引以外的錯誤（權限、網路等）一律重拋，不靜默退化。
 */
export async function fetchYearDocs(
  api: IndexedQueryApi,
  collectionRef: any,
  opts: { indicatorId?: string; year: number },
): Promise<IndexedYearFetch> {
  const { indicatorId, year } = opts;
  if (indicatorId) {
    try {
      const snap = await api.getDocs(
        api.query(
          collectionRef,
          api.where("indicatorId", "==", indicatorId),
          api.where("year", "==", year),
        ),
      );
      return { docs: snap.docs, fellBack: false, usedIndicatorFilter: true };
    } catch (error) {
      if (!isIndexMissingError(error)) throw error;
      // 退化路徑：索引未就緒，舊查詢＋前端過濾（行為與改前一致）。
      const snap = await api.getDocs(
        api.query(collectionRef, api.where("year", "==", year)),
      );
      const docs = snap.docs.filter((d) => {
        const raw = d.data() as Record<string, unknown>;
        return raw.indicatorId === indicatorId;
      });
      return { docs, fellBack: true, usedIndicatorFilter: true };
    }
  }
  const snap = await api.getDocs(
    api.query(collectionRef, api.where("year", "==", year)),
  );
  return { docs: snap.docs, fellBack: false, usedIndicatorFilter: false };
}
