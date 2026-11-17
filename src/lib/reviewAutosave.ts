/**
 * 審查表單未送出自動暫存（v1.88.10）。
 *
 * 背景：審查執行頁的作答原本只存在 React state，必須手動按「暫存」才會寫進
 * Firestore `reviewDrafts`；關閉或重整網頁前沒按暫存，輸到一半的資料就全丟。
 * 本模組提供本機自動暫存：作答後自動存一份草稿到 localStorage，關閉／重整後
 * 10 分鐘內重開同一瀏覽器可恢復，超過 10 分鐘就刪除、不恢復。
 *
 * 設計要點：
 * - 只存本機 localStorage，不新增 Firestore 集合、不改 rules、不占審查名額。
 * - 暫存鍵含登入者職編＋任務 id：`qaweb:review-autosave:v1:<staffId>:<taskId>`，
 *   不同任務、不同帳號不會互相覆蓋或串到別人的審查。
 * - 10 分鐘以「最後一次編輯時間」（updatedAt）起算；恢復時不重寫時間，
 *   恢復後沒有新編輯就關閉，不會把時鐘再延 10 分鐘。
 * - 照片不進暫存：拍照只作畫面標記（blob／計數），重整後本來就無法還原，
 *   且 data URL 會塞爆 localStorage（約 5MB 上限）；只存答案、缺失分類、
 *   文字備註等結構化欄位。語音備註目前未實作，無欄位可存。
 * - 送出成功、按「暫存」成功、使用者主動清除時，由呼叫端清除該份草稿。
 *
 * 本檔為純函式（storage 可注入），可用 esbuild 打包後以 node 驗算，不碰 Firestore。
 */

/** 暫存有效期：10 分鐘（毫秒）。 */
export const REVIEW_AUTOSAVE_TTL_MS = 10 * 60 * 1000;

/** localStorage 鍵前綴；prune 時用它掃描過期草稿。 */
export const REVIEW_AUTOSAVE_KEY_PREFIX = "qaweb:review-autosave:v1";

/** 暫存一份未送出審查表單的內容（不含照片）。 */
export interface ReviewAutosaveData {
  version: 1;
  taskId: string;
  staffId: string;
  /** 最後一次編輯時間（ms epoch）；10 分鐘起算點。 */
  updatedAt: number;
  auditMonth: string;
  reviewDate: string;
  reviewerEmpNo: string;
  reviewerName: string;
  personEmpNo: string;
  personName: string;
  bedNo: string;
  selectedAuditItem: string;
  /** questionId → 選中的選項 index。 */
  answers: Record<string, number>;
  /** questionId → 備註。 */
  notes: Record<string, string>;
  /** questionId → 已勾選常見錯誤。 */
  commonErrorAnswers: Record<string, string[]>;
  /** 恢復後繼續編輯的 Firestore 暫存 id（若當時正在編輯暫存）；否則 null。 */
  editingDraftId: string | null;
  /** 恢復後繼續編輯的已送出紀錄 id（若當時正在編輯紀錄）；否則 null。 */
  editingId: string | null;
}

/** localStorage 的最小介面（可注入假 storage 做 node 驗算）。 */
export interface ReviewAutosaveStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

/** 暫存鍵：登入者＋任務，同一瀏覽器換帳號、換任務都不會串。 */
export function reviewAutosaveKey(staffId: string, taskId: string): string {
  return `${REVIEW_AUTOSAVE_KEY_PREFIX}:${staffId}:${taskId}`;
}

/** 表單有沒有值得暫存的內容（審查日期／審查人員是預設值，不算內容）。 */
export function hasReviewAutosaveContent(
  answers: Record<string, number>,
  notes: Record<string, string>,
  commonErrorAnswers: Record<string, string[]>,
  personEmpNo: string,
  bedNo: string,
  selectedAuditItem: string,
): boolean {
  if (Object.keys(answers).length > 0) return true;
  if (Object.values(notes).some((note) => note.trim() !== "")) return true;
  if (Object.values(commonErrorAnswers).some((list) => list.length > 0)) return true;
  if (personEmpNo.trim() !== "") return true;
  if (bedNo.trim() !== "") return true;
  if (selectedAuditItem.trim() !== "") return true;
  return false;
}

/** 寫入暫存；寫入失敗（如空間滿）回傳 false，不拋錯、不阻擋表單。 */
export function saveReviewAutosave(
  storage: ReviewAutosaveStorage,
  key: string,
  data: ReviewAutosaveData,
): boolean {
  try {
    storage.setItem(key, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

export type LoadReviewAutosaveResult =
  | { status: "found"; data: ReviewAutosaveData; remainingMs: number }
  | { status: "expired" }
  | { status: "none" };

function isValidAutosaveData(value: unknown): value is ReviewAutosaveData {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    data.version === 1 &&
    typeof data.taskId === "string" &&
    typeof data.staffId === "string" &&
    typeof data.updatedAt === "number" &&
    Number.isFinite(data.updatedAt) &&
    typeof data.answers === "object" &&
    data.answers !== null &&
    typeof data.notes === "object" &&
    data.notes !== null &&
    typeof data.commonErrorAnswers === "object" &&
    data.commonErrorAnswers !== null
  );
}

/**
 * 讀取暫存。過期（updatedAt＋10 分鐘已過）或格式損毀時直接刪除並回報，
 * 呼叫端不恢復、不顯示提示。
 */
export function loadReviewAutosave(
  storage: ReviewAutosaveStorage,
  key: string,
  now: number = Date.now(),
): LoadReviewAutosaveResult {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { status: "none" };
  }
  if (raw == null) return { status: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      /* 忽略 */
    }
    return { status: "none" };
  }
  if (!isValidAutosaveData(parsed)) {
    try {
      storage.removeItem(key);
    } catch {
      /* 忽略 */
    }
    return { status: "none" };
  }
  const remainingMs = parsed.updatedAt + REVIEW_AUTOSAVE_TTL_MS - now;
  if (remainingMs <= 0) {
    try {
      storage.removeItem(key);
    } catch {
      /* 忽略 */
    }
    return { status: "expired" };
  }
  return { status: "found", data: parsed, remainingMs };
}

/** 清除一份暫存（送出成功、手動暫存成功、使用者主動清除時呼叫）。 */
export function clearReviewAutosave(storage: ReviewAutosaveStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

/** 掃描並刪除所有過期的審查暫存（載入時呼叫一次）；回傳刪除筆數。 */
export function pruneExpiredReviewAutosaves(
  storage: ReviewAutosaveStorage,
  now: number = Date.now(),
): number {
  let removed = 0;
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && key.startsWith(REVIEW_AUTOSAVE_KEY_PREFIX)) keys.push(key);
    }
  } catch {
    return 0;
  }
  keys.forEach((key) => {
    if (loadReviewAutosave(storage, key, now).status === "expired") removed += 1;
  });
  return removed;
}

/** 剩餘時間顯示用分鐘數（無條件進位，最少 1 分鐘）。 */
export function remainingMinutesText(remainingMs: number): number {
  return Math.max(1, Math.ceil(remainingMs / 60000));
}
