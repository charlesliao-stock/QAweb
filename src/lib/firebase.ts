import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import {
  arrayUnion,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from "firebase/firestore";
import {
  collection,
  doc,
  getDocs,
  limit,
  query,
  updateDoc,
  where,
} from "./db";
import { getCachedRefCollection } from "./refCache";
import { getDocsCacheFirst } from "./cacheFirst";
import { fetchAllPaged } from "./pagedQuery";
import {
  isConvenerRole,
  isOfficerRole,
  isReviewerRole,
} from "./roleIdentity";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? "",
};

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId,
);

let appInstance: FirebaseApp | undefined;
let authInstance: Auth | undefined;
let dbInstance: Firestore | undefined;

function ensureConfigured(): void {
  if (!isFirebaseConfigured) {
    throw new Error("Firebase 尚未設定，請聯絡系統管理員");
  }
}

export function getFirebaseApp(): FirebaseApp {
  ensureConfigured();
  appInstance ??=
    getApps().length > 0 ? getApps()[0]! : initializeApp(firebaseConfig);
  return appInstance;
}

export function getFirebaseAuth(): Auth {
  authInstance ??= getAuth(getFirebaseApp());
  return authInstance;
}

/**
 * v1.28 階段 7（B3）：Firestore 持久快取狀態。
 * - "persistent"：IndexedDB 持久快取已啟用（多分頁共用）。
 * - "fallback"：初始化失敗（例如 Safari 私密模式 IndexedDB 不可用、
 *   或 Firestore 已先被初始化），已退回預設行為（記憶體快取），整站不受影響。
 * demo 模式不走 Firestore SDK，狀態值與 demo 路徑無關（見 cacheFirst.ts 的隔離測試）。
 */
export type FirestoreCacheStatus = "persistent" | "fallback";
let firestoreCacheStatus: FirestoreCacheStatus = "fallback";

export function getFirestoreCacheStatus(): FirestoreCacheStatus {
  return firestoreCacheStatus;
}

export function getFirebaseDb(): Firestore {
  if (dbInstance) return dbInstance;
  const app = getFirebaseApp();
  try {
    // 持久快取（Web 為 IndexedDB）：多分頁共用，關分頁、重整頁面後仍在。
    // 只開開關不省錢，必須搭配 cacheFirst.ts 的先讀快取才計費生效。
    dbInstance = initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
    firestoreCacheStatus = "persistent";
  } catch {
    // Safari 私密模式 IndexedDB 不可用、或已初始化：退回預設 getFirestore，
    // 絕不讓初始化失敗拖垮整站（快取未命中時走伺服器，行為與改前一致）。
    dbInstance = getFirestore(app);
    firestoreCacheStatus = "fallback";
  }
  return dbInstance;
}

/* ------------------------------------------------------------------
 * 使用者自建 Firebase 輔助（v1.14.0 自 main 移植，供
 * ReviewerManagement / QuarterResults 使用；已改用本專案既有的
 * getFirebaseDb() 與 lib/db 封裝，單一 where＋前端過濾以避免複合索引）。
 * ------------------------------------------------------------------ */

export type FirebaseProfile = {
  staffId: string;
  name: string;
  roles: string[];
  unitCode: string;
  groupId: string;
  groupIds: string[];
  status: string;
};

export type ReviewRecord = {
  id: string;
  indicatorId: string;
  unitId: string;
  reviewerId: string;
  reviewerName: string;
  year: number;
  month: number;
  rate: number;
};

export type IndicatorYearSchedule = {
  indicatorId: string;
  year: number;
  months: number[];
  monthsPerAudit: number;
  /** Missing means a legacy schedule that historically applied to all units. */
  unitIds?: string[];
};

export type FirebaseUserRow = {
  staffId: string;
  name: string;
  roles: string[];
  unitCode: string;
  groupIds: string[];
  status: string;
};

export type FirebaseGroupOption = { id: string; name: string };

/** StaffProfile → FirebaseProfile 對應（StaffProfile 無 groupId/groupIds，補空值） */
export function toFirebaseProfile(
  user: {
    staffId: string;
    name: string;
    roles: string[];
    unitCode: string;
  } | null | undefined,
): FirebaseProfile | null {
  if (!user) return null;
  return {
    staffId: user.staffId,
    name: user.name,
    roles: user.roles ?? [],
    unitCode: user.unitCode ?? "",
    groupId: "",
    groupIds: [],
    status: "啟用",
  };
}

function safeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length <= 120 ? value : fallback;
}

/** 審查員角色寫入開關（沿用 main 的環境變數旗標；未設定＝關閉寫入） */
export function isFirebaseReviewerRoleWriteEnabled(): boolean {
  return (
    isFirebaseConfigured &&
    import.meta.env.VITE_FIREBASE_REVIEWER_ROLE_WRITES === "true"
  );
}

/**
 * 讀取某指標某年度的已送出審查紀錄（唯讀）。
 * 資料範圍依角色：全院（主任／副主任／督導／系統管理員）→ 不限；
 * 組別（召集人／執行幹事）→ 所屬組別單位；護理長 → 所屬單位；
 * 審查員／一般人員 → 本人送出的。
 */
export async function readReviewRecords(
  indicatorId: string,
  year: number,
  profile: FirebaseProfile,
): Promise<ReviewRecord[]> {
  const db = getFirebaseDb();
  const roles = new Set(profile.roles);
  const fullHospital = ["主任", "副主任", "督導", "系統管理員"].some((role) =>
    roles.has(role),
  );
  // v1.21：召集人／執行幹事新舊並認（組級＋單位級皆以所屬群組計範圍）
  const groupScope =
    isConvenerRole(profile.roles) || isOfficerRole(profile.roles);
  const unitScope = roles.has("護理長");
  const ownScope = isReviewerRole(profile.roles) || roles.has("一般人員");

  // v1.28 階段 6（B6）：單一指標查詢改游標分頁，取代舊 limit(2000) 靜默截斷。
  // 維持單一 where（indicatorId 等號），年份仍在前端過濾：v1.14 測試明言
  // 「移植函式用單一 where（避免複合索引）」，不再加 year 等號 where；
  // 分頁 orderBy 用等號欄位 indicatorId（分頁 helper 內加），Firestore 以
  // 索引合併支援，不需複合索引。分頁未拉完時拋錯（不回傳不完整統計），
  // 由呼叫端顯示可見提示。
  const { docs, truncated } = await fetchAllPaged(
    collection(db, "reviewRecords"),
    [where("indicatorId", "==", indicatorId)],
    undefined,
    { orderByField: "indicatorId" },
  );
  if (truncated) {
    throw new Error("審查紀錄未完整載入（分頁中斷），請稍後再試。");
  }
  const snapshot = { docs };

  let allowedUnitIds: Set<string> | null = null; // null＝不限
  if (!fullHospital) {
    if (groupScope) {
      const groupIds = [
        ...new Set([...profile.groupIds, profile.groupId].filter(Boolean)),
      ];
      if (groupIds.length) {
        const unitSnap = await getCachedRefCollection("units", () =>
          getDocsCacheFirst(query(collection(db, "units"), limit(2000))),
        );
        const ids = new Set<string>();
        unitSnap.docs.forEach((u) => {
          const data = u.data() as Record<string, unknown>;
          const gid = typeof data.groupId === "string" ? data.groupId : "";
          if (groupIds.includes(gid)) {
            const code = typeof data.code === "string" ? data.code : "";
            if (code) ids.add(code);
            ids.add(u.id);
          }
        });
        allowedUnitIds = ids;
      } else if (unitScope && profile.unitCode) {
        allowedUnitIds = new Set([profile.unitCode]);
      } else {
        throw new Error(
          "帳號未設定組別範圍，請先在 users 文件設定 groupId 或 groupIds。",
        );
      }
    } else if (unitScope) {
      if (!profile.unitCode)
        throw new Error("帳號未設定所屬單位，無法查詢結果。");
      allowedUnitIds = new Set([profile.unitCode]);
    } else if (!ownScope) {
      throw new Error("此帳號角色尚未設定結果分析範圍。");
    }
  }

  return snapshot.docs.flatMap((document) => {
    const raw = document.data() as Record<string, unknown>;
    const recordYear = Number(raw.year);
    if (recordYear !== year) return [];
    const month = Number(raw.month);
    const rateValue =
      typeof raw.rate === "number"
        ? raw.rate
        : Number(raw.maxScore) > 0
          ? (Number(raw.totalScore) / Number(raw.maxScore)) * 100
          : NaN;
    const normalizedRate = rateValue <= 1 ? rateValue * 100 : rateValue;
    const hasSubmittedEvidence =
      Boolean(raw.submittedAt) ||
      (typeof raw.reviewDate === "string" && raw.reviewDate.trim().length > 0);
    if (
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12 ||
      !Number.isFinite(normalizedRate) ||
      normalizedRate < 0 ||
      normalizedRate > 100 ||
      !hasSubmittedEvidence
    )
      return [];
    const unitId = safeText(raw.unitId, "未指定單位");
    if (allowedUnitIds && !allowedUnitIds.has(unitId)) return [];
    if (
      !fullHospital &&
      !groupScope &&
      !unitScope &&
      safeText(raw.reviewerId, "") !== profile.staffId
    )
      return [];
    return [
      {
        id: document.id,
        indicatorId: safeText(raw.indicatorId, ""),
        unitId,
        reviewerId: safeText(raw.reviewerId, ""),
        reviewerName: safeText(raw.reviewerName, "未命名審查員"),
        year: recordYear,
        month,
        rate: normalizedRate,
      },
    ];
  });
}

/** 讀取某指標某年度的排程（月份／每期月數） */
export async function readIndicatorYearSchedule(
  indicatorId: string,
  year: number,
): Promise<IndicatorYearSchedule | null> {
  const db = getFirebaseDb();
  const snapshot = await getDocs(
    query(
      collection(db, "indicatorYearSchedules"),
      where("indicatorId", "==", indicatorId),
      limit(20),
    ),
  );
  const item = snapshot.docs.find(
    (d) => Number((d.data() as Record<string, unknown>).year) === year,
  );
  if (!item) return null;
  const raw = item.data() as Record<string, unknown>;
  return {
    indicatorId,
    year,
    months: Array.isArray(raw.months)
      ? (raw.months as unknown[])
          .filter(
            (value): value is number =>
              Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 12,
          )
          .sort((a, b) => a - b)
      : [],
    unitIds: Array.isArray(raw.unitIds)
      ? [
          ...new Set(
            (raw.unitIds as unknown[]).filter(
              (value): value is string =>
                typeof value === "string" && value.trim().length > 0,
            ),
          ),
        ]
      : undefined,
    monthsPerAudit:
      typeof raw.monthsPerAudit === "number" &&
      Number.isInteger(raw.monthsPerAudit) &&
      raw.monthsPerAudit >= 1 &&
      raw.monthsPerAudit <= 12
        ? raw.monthsPerAudit
        : 1,
  };
}

/** 審查員管理：讀取 users 人員清單（供篩選審查員／候選人） */
export async function readFirebaseUsersForReviewerManagement(): Promise<
  FirebaseUserRow[]
> {
  const db = getFirebaseDb();
  const snapshot = await getCachedRefCollection("users", () =>
    getDocsCacheFirst(query(collection(db, "users"), limit(1000))),
  );
  let groupByUnit = new Map<string, string>();
  try {
    const units = await getCachedRefCollection("units", () =>
      getDocsCacheFirst(query(collection(db, "units"), limit(2000))),
    );
    groupByUnit = new Map(
      units.docs.flatMap((unit) => {
        const data = unit.data() as Record<string, unknown>;
        const groupId = safeText(data.groupId, "");
        if (!groupId) return [];
        return [
          [unit.id, groupId] as const,
          [safeText(data.code, ""), groupId] as const,
          [safeText(data.unitCode, ""), groupId] as const,
        ].filter(([unitKey]) => Boolean(unitKey));
      }),
    );
  } catch {
    // Users can still be listed by their direct groupId/groupIds if unit access is restricted.
  }
  return snapshot.docs.map((document) => {
    const raw = document.data() as Record<string, unknown>;
    const roles = Array.isArray(raw.roles)
      ? (raw.roles as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const groupIds = Array.isArray(raw.groupIds)
      ? (raw.groupIds as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const groupId = safeText(raw.groupId, "");
    const unitCode = safeText(raw.unitCode, "");
    const inferredGroupId = groupByUnit.get(unitCode) ?? "";
    return {
      staffId: document.id,
      name: safeText(raw.name, document.id),
      roles,
      unitCode,
      groupIds: [
        ...new Set([...groupIds, groupId, inferredGroupId].filter(Boolean)),
      ],
      status: safeText(raw.status, "未設定"),
    };
  });
}

/** 審查員管理：讀取 groups 組別選單 */
export async function readFirebaseGroupsForReviewerManagement(): Promise<
  FirebaseGroupOption[]
> {
  const db = getFirebaseDb();
  const snapshot = await getCachedRefCollection("groups", () =>
    getDocsCacheFirst(query(collection(db, "groups"), limit(500))),
  );
  return snapshot.docs
    .map((document) => ({
      id: document.id,
      name: safeText(
        (document.data() as Record<string, unknown>).name,
        document.id,
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
}

/** 授予審查員角色（users/{staffId}.roles arrayUnion "審查員"） */
export async function grantReviewerRole(staffId: string): Promise<void> {
  if (!isFirebaseReviewerRoleWriteEnabled())
    throw new Error("審查員角色寫入尚未啟用；需先完成 Firestore Rules 驗收。");
  const normalizedStaffId = staffId.trim();
  if (!normalizedStaffId) throw new Error("缺少人員職編，無法授予角色。");
  const db = getFirebaseDb();
  await updateDoc(doc(db, "users", normalizedStaffId), {
    roles: arrayUnion("審查員"),
  });
}
