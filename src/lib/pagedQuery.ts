/**
 * 游標分頁拉取完整查詢結果（v1.28 階段 6 B6 共用）。
 *
 * 用途：取代「每指標一次 limit(2000)」的靜默截斷模式。單一查詢＋游標分頁
 * 循序拉完，直到回傳少於一頁或空頁；以文件 id 去重（游標頁之間不應重疊，
 * 純防呆）；觸及頁數上限、分頁中斷或游標未前進時回報 truncated=true，
 * 呼叫端必須顯示可見提示、不得無聲少算。
 *
 * 索引要求：查詢只能是「單一欄位過濾＋同欄位 orderBy」（不需複合索引），
 * 例如 where("year", ">=", y).orderBy("year")（範圍欄位＝第一個 orderBy 欄位），
 * 或單一等號過濾＋該等號欄位 orderBy（例如 where("indicatorId", "==", x)
 * .orderBy("indicatorId")，Firestore 以索引合併支援）。
 * 切勿傳入「範圍過濾＋不同欄位 orderBy」或多欄位 orderBy，那需要複合索引；
 * 也不要加第二個等號 where（v1.14 測試 guard：移植函式維持單一 where）。
 *
 * queryApi 參數是測試接縫：預設走 src/lib/db.ts（真實／demo 雙模式）；
 * node 測試可注入 demoStore 後端直接驗證分頁完整性。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  getDocs as dbGetDocs,
  limit as dbLimit,
  orderBy as dbOrderBy,
  query as dbQuery,
  startAfter as dbStartAfter,
} from "./db";

export interface PageDoc {
  id: string;
  data: () => unknown;
}

export interface PageSnapshot {
  docs: PageDoc[];
}

export interface QueryApi {
  query: (ref: any, ...constraints: any[]) => any;
  orderBy: (field: string, dir?: "asc" | "desc") => any;
  limit: (n: number) => any;
  startAfter: (snapshot: any) => any;
  getDocs: (q: any) => Promise<PageSnapshot>;
}

export const dbQueryApi: QueryApi = {
  query: dbQuery,
  orderBy: dbOrderBy,
  limit: dbLimit,
  startAfter: dbStartAfter,
  getDocs: (q: any) => dbGetDocs(q) as unknown as Promise<PageSnapshot>,
};

/** 每頁文件數（Firestore 單次回傳建議上限內；舊 limit(2000) 的四分之一） */
export const PAGED_QUERY_PAGE_SIZE = 500;
/** 最多頁數：500×40＝20,000 筆；觸及即停並回報 truncated（不要無聲少算） */
export const PAGED_QUERY_MAX_PAGES = 40;

export interface PagedQueryResult {
  docs: PageDoc[];
  /** true＝未拉完（觸及頁數上限、分頁異常或游標未前進），呼叫端須顯示可見提示 */
  truncated: boolean;
  pages: number;
}

export async function fetchAllPaged(
  collectionRef: any,
  constraints: any[],
  api: QueryApi = dbQueryApi,
  opts?: { pageSize?: number; maxPages?: number; orderByField?: string },
): Promise<PagedQueryResult> {
  const pageSize = opts?.pageSize ?? PAGED_QUERY_PAGE_SIZE;
  const maxPages = opts?.maxPages ?? PAGED_QUERY_MAX_PAGES;
  const orderField = opts?.orderByField ?? "year";
  const seen = new Set<string>();
  const docs: PageDoc[] = [];
  let cursor: any = null;
  let truncated = false;
  let pages = 0;
  for (let p = 0; p < maxPages; p++) {
    const q =
      cursor == null
        ? api.query(
            collectionRef,
            ...constraints,
            api.orderBy(orderField),
            api.limit(pageSize),
          )
        : api.query(
            collectionRef,
            ...constraints,
            api.orderBy(orderField),
            api.startAfter(cursor),
            api.limit(pageSize),
          );
    let snap: PageSnapshot;
    try {
      snap = await api.getDocs(q);
    } catch {
      truncated = true;
      break;
    }
    pages++;
    let newDocs = 0;
    for (const d of snap.docs) {
      if (!seen.has(d.id)) {
        seen.add(d.id);
        docs.push(d);
        newDocs++;
      }
    }
    if (snap.docs.length === 0) break; // 已拉完
    if (newDocs === 0) {
      truncated = true; // 游標未前進，防無窮迴圈
      break;
    }
    if (snap.docs.length < pageSize) break; // 最後一頁
    cursor = snap.docs[snap.docs.length - 1];
  }
  if (pages >= maxPages) truncated = true; // 跑滿頁數上限，可能還有更多
  return { docs, truncated, pages };
}
