import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  type Firestore,
} from "./db";

/**
 * 10 steps 正式標題（需求規格書 v2.1 §3，全院統一，僅系統管理員可修改標題）。
 * 「閾值」以百分比數字存於指標文件的 threshold 欄位，此處標題僅供顯示對應。
 */
export const TEN_STEPS_TITLES = [
  "負責單位",
  "照護範圍",
  "照護面",
  "標準依據",
  "閾值",
  "資料收集",
  "評值",
  "採取行動",
  "評估活動之有效性",
  "溝通",
] as const;

export interface SeedRoleDef {
  id: string;
  name: string;
  description: string;
}

/** 七個預設角色（需求規格書 v2.1 §1.2） */
export const SEED_ROLES: SeedRoleDef[] = [
  {
    id: "general",
    name: "一般人員",
    description:
      "全院護理人員（被審對象）；可登入查詢自己的被審結果與歷史紀錄；預設看不到審查員姓名",
  },
  {
    id: "reviewer",
    name: "審查員",
    description:
      "執行指標審查，可查詢／修改本人經手的審查紀錄；同時也可能是被審人員",
  },
  {
    id: "head-nurse",
    name: "護理長",
    description: "查看所屬單位的排程、進度與結果；接收審查提交通知；CAPA 預設填寫人",
  },
  {
    id: "supervisor",
    name: "督導",
    description:
      "督導長、護理部主管；查看全院完成率、異常單位、全院統計；可看全部照片與明細",
  },
  {
    id: "indicator-owner",
    name: "指標負責人",
    description:
      "各組維護自己組別的指標（填 10 steps 與審核表）；每組可設多位負責人及協同負責人；提出新增／修訂／廢止申請；初期由品管執行幹事與系統管理員代管",
  },
  {
    id: "qi-officer",
    name: "品管執行幹事",
    description:
      "全院排程專責制定（單筆／批次／複製）、改派加派；設定各組指標審核關卡與審核人；審查員離職時代改；逾期補審解鎖；初期與系統管理員統一維護指標",
  },
  {
    id: "sysadmin",
    name: "系統管理員",
    description:
      "人員、單位、角色權限、系統參數；動態建立新角色並對應權限；維護單位沿革對應；唯一可修改 10 steps 標題者",
  },
];

export interface SeedTitleDef {
  name: string;
  /** 群組層級（召集人／執行幹事／組長）或單位層級（主任／副主任／督導／護理長／副護理長／執行幹事） */
  level: "群組" | "單位";
}

/** 預設職稱（需求規格書 v2.1 §6 系統管理：職稱分群組與單位兩層） */
export const SEED_TITLES: SeedTitleDef[] = [
  { name: "召集人", level: "群組" },
  { name: "執行幹事", level: "群組" },
  { name: "組長", level: "群組" },
  { name: "主任", level: "單位" },
  { name: "副主任", level: "單位" },
  { name: "督導", level: "單位" },
  { name: "護理長", level: "單位" },
  { name: "副護理長", level: "單位" },
  { name: "執行幹事", level: "單位" },
  { name: "護理師", level: "單位" },
];

/** 七個系統角色名稱（批次上傳人員時驗證用） */
export const SYSTEM_ROLE_NAMES: string[] = SEED_ROLES.map((r) => r.name);

export interface SystemParams {
  /** RAG 黃燈區間：閾值以下幾個百分點為「接近閾值」 */
  ragYellowBand: number;
  /** 補審截止：排程月份次月幾日 */
  supplementDeadlineDay: number;
  /** 伺服器端草稿保留天數 */
  draftRetentionDays: number;
  /** 草稿到期前幾天提醒 */
  draftExpiryReminderDays: number;
  /** 審查資料保存年數 */
  dataRetentionYears: number;
  /** 照片保存年數（預設與審查資料相同） */
  photoRetentionYears: number;
  /** 通知開關（第一階段僅控制儀表板警示） */
  notificationsEnabled: boolean;
  /** 批次匯入免審開關 */
  allowImportWithoutReview: boolean;
  /** 隱私提醒頻率：每次／間隔／組織級開關 */
  privacyReminderFrequency: string;
  /** 密碼到期前幾天提醒 */
  passwordExpiryReminderDays: number;
  /** 一般人員是否可見審查員姓名 */
  showReviewerNameToStaff: boolean;
  /** 主題配色：green-2／blue-3／teal-orange-3／purple-4（全院統一，管理員設定） */
  uiTheme: string;
}

/** 主題配色選項（id 需與 styles.css 的 [data-theme] 對應） */
export const UI_THEMES: { id: string; name: string }[] = [
  { id: "green-2", name: "雅致綠（雙色）" },
  { id: "blue-3", name: "醫療藍（三色）" },
  { id: "teal-orange-3", name: "青橘（三色）" },
  { id: "purple-4", name: "沉穩紫（四色）" },
];

export function themeName(id: string): string {
  return UI_THEMES.find((t) => t.id === id)?.name ?? id;
}

/** 系統參數預設值（需求規格書 v2.1） */
export const DEFAULT_SYSTEM_PARAMS: SystemParams = {
  ragYellowBand: 5,
  supplementDeadlineDay: 10,
  draftRetentionDays: 30,
  draftExpiryReminderDays: 5,
  dataRetentionYears: 3,
  photoRetentionYears: 3,
  notificationsEnabled: true,
  allowImportWithoutReview: false,
  privacyReminderFrequency: "每次",
  passwordExpiryReminderDays: 7,
  showReviewerNameToStaff: false,
  uiTheme: "green-2",
};

export const SYSTEM_PARAM_LABELS: Record<keyof SystemParams, string> = {
  ragYellowBand: "RAG 黃燈區間（閾值以下百分點）",
  supplementDeadlineDay: "補審截止（次月幾日）",
  draftRetentionDays: "伺服器草稿保留天數",
  draftExpiryReminderDays: "草稿到期前提醒天數",
  dataRetentionYears: "審查資料保存年數",
  photoRetentionYears: "照片保存年數",
  notificationsEnabled: "通知開關",
  allowImportWithoutReview: "批次匯入免審",
  privacyReminderFrequency: "隱私提醒頻率",
  passwordExpiryReminderDays: "密碼到期前提醒天數",
  showReviewerNameToStaff: "一般人員可見審查員姓名",
  uiTheme: "主題配色",
};

/**
 * 系統初始化：一鍵寫入 systemParams/config 與 7 個預設角色。
 * systemParams 僅在不存在時寫入；roles 以 merge 寫入，不覆蓋已自訂的角色。
 */
export async function runSystemSeed(
  db: Firestore,
  staffId: string,
): Promise<void> {
  const now = serverTimestamp();
  const configRef = doc(db, "systemParams", "config");
  const configSnap = await getDoc(configRef);
  if (!configSnap.exists()) {
    await setDoc(configRef, {
      ...DEFAULT_SYSTEM_PARAMS,
      createdAt: now,
      updatedAt: now,
      createdBy: staffId,
    });
  }
  for (const role of SEED_ROLES) {
    await setDoc(
      doc(db, "roles", role.id),
      {
        name: role.name,
        description: role.description,
        createdAt: now,
        updatedAt: now,
        createdBy: staffId,
      },
      { merge: true },
    );
  }
  // 預設職稱：文件 ID 以「層級-名稱」固定，避免重複寫入；merge 不覆蓋自訂
  for (const title of SEED_TITLES) {
    await setDoc(
      doc(db, "titles", `${title.level}-${title.name}`),
      {
        name: title.name,
        level: title.level,
        createdAt: now,
        updatedAt: now,
        createdBy: staffId,
      },
      { merge: true },
    );
  }
}
