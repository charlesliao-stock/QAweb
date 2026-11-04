import type { User } from "firebase/auth";
import type { Firestore } from "firebase/firestore";
import type { Indicator } from "../types";

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? "",
};

export type DemoDataSource = "local" | "firebase" | "firebase-unavailable";
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
export type FirebaseUnitOption = {
  id: string;
  name: string;
  groupId: string;
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

type Services = {
  app: typeof import("firebase/app");
  auth: typeof import("firebase/auth");
  firestore: typeof import("firebase/firestore");
  db: Firestore;
  authInstance: import("firebase/auth").Auth;
};
let servicesPromise: Promise<Services> | undefined;

function firebaseConfigured(): boolean {
  return Boolean(config.apiKey && config.projectId && config.appId);
}

export function isFirebaseDemoReadEnabled(): boolean {
  return (
    firebaseConfigured() && import.meta.env.VITE_FIREBASE_DEMO_READS === "true"
  );
}

export function isFirebaseAuditModeEnabled(): boolean {
  return (
    firebaseConfigured() && import.meta.env.VITE_FIREBASE_AUDIT_READS === "true"
  );
}

export function isFirebaseReviewerRoleWriteEnabled(): boolean {
  return (
    firebaseConfigured() &&
    import.meta.env.VITE_FIREBASE_REVIEWER_ROLE_WRITES === "true"
  );
}

async function getServices(): Promise<Services> {
  if (!firebaseConfigured())
    throw new Error("Firebase 尚未設定，請確認環境變數。");
  servicesPromise ??= Promise.all([
    import("firebase/app"),
    import("firebase/auth"),
    import("firebase/firestore"),
  ]).then(([app, auth, firestore]) => {
    const appInstance =
      app.getApps().length > 0 ? app.getApp() : app.initializeApp(config);
    return {
      app,
      auth,
      firestore,
      db: firestore.getFirestore(appInstance),
      authInstance: auth.getAuth(appInstance),
    };
  });
  return servicesPromise;
}

export async function signInWithStaffId(
  staffId: string,
  password: string,
): Promise<FirebaseProfile> {
  const id = staffId.trim();
  if (!id || !password) throw new Error("請輸入職編與密碼。");
  const { auth, authInstance, db, firestore } = await getServices();
  const credential = await auth.signInWithEmailAndPassword(
    authInstance,
    `${id}@nurseboard.internal`,
    password,
  );
  try {
    return await profileForUser(credential.user, db, firestore);
  } catch (error) {
    await auth.signOut(authInstance);
    throw error;
  }
}

export async function signOutFirebaseUser(): Promise<void> {
  const { auth, authInstance } = await getServices();
  await auth.signOut(authInstance);
}

export async function watchFirebaseProfile(
  onProfile: (profile: FirebaseProfile | null) => void,
  onError: (error: unknown) => void,
): Promise<() => void> {
  const { auth, authInstance, db, firestore } = await getServices();
  return auth.onAuthStateChanged(
    authInstance,
    async (user) => {
      if (!user) {
        onProfile(null);
        return;
      }
      try {
        onProfile(await profileForUser(user, db, firestore));
      } catch (error) {
        onError(error);
        onProfile(null);
      }
    },
    onError,
  );
}

async function profileForUser(
  user: User,
  db: Firestore,
  firestore: typeof import("firebase/firestore"),
): Promise<FirebaseProfile> {
  const staffId = user.email?.split("@")[0]?.trim() ?? "";
  if (!staffId) throw new Error("登入帳號沒有職編資訊，無法載入權限資料。");
  const snapshot = await firestore.getDoc(firestore.doc(db, "users", staffId));
  if (!snapshot.exists())
    throw new Error("找不到此帳號的人員資料，請聯絡系統管理員。");
  const raw = snapshot.data();
  const status = safeText(raw.status, "");
  if (status === "停用") throw new Error("此帳號已停用，請聯絡系統管理員。");
  const groups = Array.isArray(raw.groupIds)
    ? raw.groupIds.filter((value): value is string => typeof value === "string")
    : [];
  return {
    staffId,
    name: safeText(raw.name, staffId),
    roles: Array.isArray(raw.roles)
      ? raw.roles.filter((value): value is string => typeof value === "string")
      : [],
    unitCode: safeText(raw.unitCode, ""),
    groupId: safeText(raw.groupId, ""),
    groupIds: groups,
    status,
  };
}

/** The demo adapter stays restricted to its dedicated allowlisted path. */
export async function readDemoIndicators(): Promise<Indicator[] | null> {
  if (!isFirebaseDemoReadEnabled()) return null;
  const { db, firestore } = await getServices();
  const demoCollection = firestore.collection(
    db,
    "qms_demo",
    "indicators",
    "records",
  );
  const result = await firestore.getDocs(
    firestore.query(
      demoCollection,
      firestore.where("demoOnly", "==", true),
      firestore.limit(30),
    ),
  );
  const rows = result.docs.flatMap((snapshot) => {
    const raw = snapshot.data();
    if (raw.demoOnly !== true) return [];
    return [
      {
        id: snapshot.id,
        code: safeText(raw.code, "DEMO"),
        name: safeText(raw.name, "展示指標"),
        group: safeText(raw.group, "展示組別"),
        threshold: safeNumber(raw.threshold, 90, 0, 100),
        attainment: safeNumber(raw.attainment, 0, 0, 100),
        audited: safeCount(raw.audited),
        planned: safeCount(raw.planned),
        version: safeText(raw.version, "v1.0"),
        status:
          raw.status === "審核中" || raw.status === "草稿"
            ? raw.status
            : "啟用",
        owner: "展示負責人",
        resultLabel: safeText(raw.resultLabel, "符合率"),
      } satisfies Indicator,
    ];
  });
  return rows.length ? rows : null;
}

export async function readFirebaseIndicators(): Promise<Indicator[]> {
  const { db, firestore } = await getServices();
  const snapshot = await firestore.getDocs(
    firestore.query(
      firestore.collection(db, "users"),
      firestore.limit(5000),
    ),
  );
  return snapshot.docs.map((item) => {
    const raw = item.data();
    const stepThreshold = getNested(raw, [
      "tenSteps",
      "step5",
      "thresholds",
      "0",
      "value",
    ]);
    const threshold = parsePercent(raw.threshold ?? stepThreshold, 90);
    return {
      id: item.id,
      code: safeText(raw.code, item.id),
      name: safeText(raw.name, item.id),
      group: safeText(raw.groupName ?? raw.groupId, "未分類"),
      threshold,
      attainment: 0,
      audited: 0,
      planned: 0,
      version: safeText(raw.version, ""),
      status:
        raw.status === "草稿" || raw.status === "審核中" ? raw.status : "啟用",
      owner: "",
      resultLabel: "符合率",
    } satisfies Indicator;
  });
}

export async function readFirebaseUsersForReviewerManagement(): Promise<
  FirebaseUserRow[]
> {
  const { db, firestore } = await getServices();
  const snapshot = await firestore.getDocs(
    firestore.query(firestore.collection(db, "users"), firestore.limit(1000)),
  );
  let groupByUnit = new Map<string, string>();
  try {
    const units = await firestore.getDocs(
      firestore.query(firestore.collection(db, "units"), firestore.limit(2000)),
    );
    groupByUnit = new Map(
      units.docs.flatMap((unit) => {
        const data = unit.data();
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
    const raw = document.data();
    const roles = Array.isArray(raw.roles)
      ? raw.roles.filter((value): value is string => typeof value === "string")
      : [];
    const groupIds = Array.isArray(raw.groupIds)
      ? raw.groupIds.filter(
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

export async function readFirebaseGroupsForReviewerManagement(): Promise<
  FirebaseGroupOption[]
> {
  const { db, firestore } = await getServices();
  const snapshot = await firestore.getDocs(
    firestore.query(firestore.collection(db, "groups"), firestore.limit(500)),
  );
  return snapshot.docs
    .map((document) => ({
      id: document.id,
      name: safeText(document.data().name, document.id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
}

export async function grantReviewerRole(staffId: string): Promise<void> {
  if (!isFirebaseReviewerRoleWriteEnabled())
    throw new Error("審查員角色寫入尚未啟用；需先完成 Firestore Rules 驗收。");
  const normalizedStaffId = staffId.trim();
  if (!normalizedStaffId) throw new Error("缺少人員職編，無法授予角色。");
  const { db, firestore } = await getServices();
  await firestore.updateDoc(firestore.doc(db, "users", normalizedStaffId), {
    roles: firestore.arrayUnion("審查員"),
  });
}

export async function readFirebaseScheduleUnits(
  profile: FirebaseProfile,
): Promise<FirebaseUnitOption[]> {
  const { db, firestore } = await getServices();
  const units = firestore.collection(db, "units");
  const roles = new Set(profile.roles);
  const fullScope = ["主任", "副主任", "督導", "系統管理員"].some((role) =>
    roles.has(role),
  );
  const groupScope = [
    "各組召集人",
    "執行幹事",
    "品管執行幹事",
    "指標負責人",
  ].some((role) => roles.has(role));

  if (fullScope) {
    const snapshot = await firestore.getDocs(
      firestore.query(units, firestore.limit(500)),
    );
    return normalizeFirebaseUnits(snapshot.docs);
  }

  if (groupScope) {
    const groupIds = [
      ...new Set([...profile.groupIds, profile.groupId].filter(Boolean)),
    ];
    if (!groupIds.length && profile.unitCode) {
      const unitById = await firestore.getDoc(
        firestore.doc(db, "units", profile.unitCode),
      );
      let groupId = unitById.exists()
        ? String(unitById.data().groupId ?? "")
        : "";
      if (!groupId) {
        const unitByCode = await firestore.getDocs(
          firestore.query(
            units,
            firestore.where("code", "==", profile.unitCode),
            firestore.limit(1),
          ),
        );
        groupId = String(unitByCode.docs[0]?.data().groupId ?? "");
      }
      if (groupId) groupIds.push(groupId);
    }
    if (!groupIds.length)
      throw new Error("帳號未設定組別範圍，無法載入可排程單位。");
    if (groupIds.length > 30)
      throw new Error("此帳號所屬組別超過 Firestore 單次查詢上限。");
    const snapshot = await firestore.getDocs(
      firestore.query(
        units,
        firestore.where("groupId", "in", groupIds),
        firestore.limit(500),
      ),
    );
    return normalizeFirebaseUnits(snapshot.docs);
  }

  if (roles.has("護理長") && profile.unitCode) {
    const direct = await firestore.getDoc(
      firestore.doc(db, "units", profile.unitCode),
    );
    const byCode = await firestore.getDocs(
      firestore.query(
        units,
        firestore.where("code", "==", profile.unitCode),
        firestore.limit(1),
      ),
    );
    return normalizeFirebaseUnits([
      ...(direct.exists() ? [direct] : []),
      ...byCode.docs,
    ]);
  }

  throw new Error("此帳號角色尚未設定可排程單位範圍。");
}

function normalizeFirebaseUnits(
  documents: Array<{ id: string; data: () => Record<string, unknown> }>,
): FirebaseUnitOption[] {
  const byId = new Map<string, FirebaseUnitOption>();
  for (const document of documents) {
    const raw = document.data();
    const id = [raw.code, raw.unitCode, document.id].find(
      (value) => typeof value === "string" && value.trim().length > 0,
    ) as string | undefined;
    if (!id) continue;
    const normalizedId = id.trim();
    byId.set(normalizedId, {
      id: normalizedId,
      name: safeText(raw.name ?? raw.unitName, normalizedId),
      groupId: safeText(raw.groupId, ""),
    });
  }
  return [...byId.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "zh-Hant"),
  );
}

export async function readReviewRecords(
  indicatorId: string,
  year: number,
  profile: FirebaseProfile,
): Promise<ReviewRecord[]> {
  const { db, firestore } = await getServices();
  const collection = firestore.collection(db, "reviewRecords");
  const roles = new Set(profile.roles);
  const fullHospital = ["主任", "副主任", "督導", "系統管理員"].some((role) =>
    roles.has(role),
  );
  const groupScope = ["各組召集人", "執行幹事", "品管執行幹事"].some((role) =>
    roles.has(role),
  );
  const unitScope = roles.has("護理長");
  const ownScope = roles.has("審查員") || roles.has("一般人員");
  const filters = [
    firestore.where("indicatorId", "==", indicatorId),
    firestore.where("year", "==", year),
  ];

  if (!fullHospital) {
    if (groupScope) {
      const groupIds = [
        ...new Set([...profile.groupIds, profile.groupId].filter(Boolean)),
      ];
      if (!groupIds.length && profile.unitCode) {
        const unitById = await firestore.getDoc(
          firestore.doc(db, "units", profile.unitCode),
        );
        let inferredGroupId = unitById.exists()
          ? String(unitById.data().groupId ?? "")
          : "";
        if (!inferredGroupId) {
          const unitByCode = await firestore.getDocs(
            firestore.query(
              firestore.collection(db, "units"),
              firestore.where("code", "==", profile.unitCode),
              firestore.limit(1),
            ),
          );
          inferredGroupId = String(unitByCode.docs[0]?.data().groupId ?? "");
        }
        if (inferredGroupId) groupIds.push(inferredGroupId);
      }
      if (!groupIds.length && unitScope && profile.unitCode) {
        filters.push(firestore.where("unitId", "==", profile.unitCode));
      } else if (!groupIds.length) {
        throw new Error(
          "帳號未設定組別範圍，請先在 users 文件設定 groupId 或 groupIds。",
        );
      } else if (groupIds.length > 30) {
        throw new Error("此帳號所屬組別超過 Firestore 單次查詢上限。");
      } else {
        const unitSnapshot = await firestore.getDocs(
          firestore.query(
            firestore.collection(db, "units"),
            firestore.where("groupId", "in", groupIds),
            firestore.limit(500),
          ),
        );
        const unitIds = [
          ...new Set(
            unitSnapshot.docs.flatMap((unit) => {
              const data = unit.data();
              return [
                String(data.code ?? ""),
                String(data.unitCode ?? ""),
                unit.id,
              ].filter(Boolean);
            }),
          ),
        ];
        if (!unitIds.length)
          throw new Error("此帳號所屬組別尚未對應任何單位。");
        if (unitIds.length > 30)
          throw new Error(
            "組別範圍超過 Firestore 單次查詢上限，請縮小組別設定。",
          );
        filters.push(firestore.where("unitId", "in", unitIds));
      }
    } else if (unitScope) {
      if (!profile.unitCode)
        throw new Error("帳號未設定所屬單位，無法查詢結果。");
      const unitById = await firestore.getDoc(
        firestore.doc(db, "units", profile.unitCode),
      );
      const unitByCode = await firestore.getDocs(
        firestore.query(
          firestore.collection(db, "units"),
          firestore.where("code", "==", profile.unitCode),
          firestore.limit(1),
        ),
      );
      const unitIds = [
        ...new Set(
          [
            profile.unitCode,
            unitById.exists() ? unitById.id : "",
            ...unitByCode.docs.flatMap((unit) => {
              const data = unit.data();
              return [
                unit.id,
                String(data.code ?? ""),
                String(data.unitCode ?? ""),
              ];
            }),
          ].filter(Boolean),
        ),
      ];
      filters.push(firestore.where("unitId", "in", unitIds));
    } else if (ownScope) {
      filters.push(firestore.where("reviewerId", "==", profile.staffId));
    } else {
      throw new Error("此帳號角色尚未設定結果分析範圍。");
    }
  }

  const snapshot = await firestore.getDocs(
    firestore.query(collection, ...filters, firestore.limit(2000)),
  );
  return snapshot.docs.flatMap((document) => {
    const raw = document.data();
    const recordYear = Number(raw.year);
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
      recordYear !== year ||
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12 ||
      !Number.isFinite(normalizedRate) ||
      normalizedRate < 0 ||
      normalizedRate > 100 ||
      !hasSubmittedEvidence
    )
      return [];
    return [
      {
        id: document.id,
        indicatorId: safeText(raw.indicatorId, ""),
        unitId: safeText(raw.unitId, "未指定單位"),
        reviewerId: safeText(raw.reviewerId, ""),
        reviewerName: safeText(raw.reviewerName, "未命名審查員"),
        year: recordYear,
        month,
        rate: normalizedRate,
      },
    ];
  });
}

export async function readIndicatorYearSchedule(
  indicatorId: string,
  year: number,
): Promise<IndicatorYearSchedule | null> {
  const { db, firestore } = await getServices();
  const result = await firestore.getDocs(
    firestore.query(
      firestore.collection(db, "indicatorYearSchedules"),
      firestore.where("indicatorId", "==", indicatorId),
      firestore.where("year", "==", year),
      firestore.limit(1),
    ),
  );
  const item = result.docs[0];
  if (!item) return null;
  const raw = item.data();
  return {
    indicatorId,
    year,
    months: Array.isArray(raw.months)
      ? raw.months
          .filter(
            (value): value is number =>
              Number.isInteger(value) && value >= 1 && value <= 12,
          )
          .sort((a, b) => a - b)
      : [],
    unitIds: Array.isArray(raw.unitIds)
      ? [
          ...new Set(
            raw.unitIds.filter(
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

export async function saveIndicatorYearSchedule(
  schedule: IndicatorYearSchedule,
  staffId: string,
): Promise<void> {
  const { db, firestore } = await getServices();
  const collection = firestore.collection(db, "indicatorYearSchedules");
  const existing = await firestore.getDocs(
    firestore.query(
      collection,
      firestore.where("indicatorId", "==", schedule.indicatorId),
      firestore.where("year", "==", schedule.year),
      firestore.limit(1),
    ),
  );
  const payload = {
    indicatorId: schedule.indicatorId,
    year: schedule.year,
    months: [...new Set(schedule.months)].sort((a, b) => a - b),
    monthsPerAudit: schedule.monthsPerAudit,
    unitIds: [...new Set(schedule.unitIds ?? [])],
    updatedAt: firestore.serverTimestamp(),
    updatedBy: staffId,
  };
  if (existing.docs[0]) {
    await firestore.updateDoc(existing.docs[0].ref, payload);
  } else {
    await firestore.addDoc(collection, {
      ...payload,
      createdAt: firestore.serverTimestamp(),
    });
  }
}

function safeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length <= 120 ? value : fallback;
}
function safeNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}
function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}
function getNested(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}
function parsePercent(value: unknown, fallback: number): number {
  if (typeof value === "number") return safeNumber(value, fallback, 0, 100);
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^0-9.]/g, ""));
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100
      ? parsed
      : fallback;
  }
  return fallback;
}
