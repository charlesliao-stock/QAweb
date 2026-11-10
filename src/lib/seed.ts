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
 * 單一來源：src/lib/indicators.ts 的 TEN_STEP_TITLES（v1.12.0 合併）。
 */
export { TEN_STEP_TITLES as TEN_STEPS_TITLES } from "./indicators";

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
  // v1.21：新角色種子（品管組／單位級；不存在才建立）
  {
    id: "qi-convener",
    name: "品管組召集人",
    description:
      "品管組召集人：所屬群組的排程權限與審查監督（組級）。",
  },
  {
    id: "qi-officer",
    name: "品管組執行幹事",
    description:
      "品管組執行幹事：所屬群組的排程權限與審查執行（組級）。",
  },
  {
    id: "qi-reviewer",
    name: "品管組審查員",
    description: "品管組審查員：依分工表執行審查。",
  },
  {
    id: "unit-convener",
    name: "單位召集人",
    description: "單位召集人：所屬單位的品管審查召集。",
  },
  {
    id: "unit-officer",
    name: "單位執行幹事",
    description: "單位執行幹事：所屬單位的品管審查執行與自審。",
  },
  {
    id: "unit-reviewer",
    name: "單位審查員",
    description: "單位審查員：依分工表執行審查。",
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
  // v1.21：使用者定案的 6 職稱（護理部主任／副主任／督導；不存在才建立）
  { name: "護理部主任", level: "單位" },
  { name: "護理部副主任", level: "單位" },
  { name: "護理部督導", level: "單位" },
  { name: "護理長", level: "單位" },
  { name: "副護理長", level: "單位" },
  { name: "執行幹事", level: "單位" },
  { name: "護理師", level: "單位" },
];

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
  /** 統計週期：報表統計跟隨的週期（'year'＝曆年 1–12 月；'academic'＝學年度 8 月制） */
  statsCycle: "year" | "academic";
}

/**
 * 主題定義（v1.32.0，資料驅動架構，設計 v2 §1.2）。
 * 運行時唯一來源是 Firestore `uiThemes` 集合（每套主題一份文件，doc id＝主題 id）；
 * 此處 `BUILT_IN_THEMES` 只是種子來源＋離線／空庫 fallback，不是第二份運行時真相。
 * 內建主題改色只改此常數，再跑一次種子（或管理介面「補齊內建模板」）；管理員想改色
 * 請用「複製成自訂模板再改」。
 * 亮色（#35D49B／#FFB08A／#FFDE5D／#F6AB4A）絕不作白字按鈕底，只出現在淡底／描邊／
 * 光暈／頂條，或配深字；白字主色對比皆以 WCAG 公式實算 ≥4.5:1。
 */
export interface UiThemeDef {
  id: string;
  name: string;
  source: string;
  builtIn: boolean;
  hidden: boolean;
  order: number;
  teal: string;
  tealDeep: string;
  tealSoft: string;
  accent: string;
  accentDeep: string;
  accentSoft: string;
  accent2: string;
  accent2Deep: string;
  accent2Soft: string;
  /** 頁面底（淺色模式；深色模式由 dark 覆寫接管，不寫入 inline） */
  bg: string;
  radiusBtn: number;
  radiusCard: number;
  /** 卡片 hover 上浮 px（0＝不浮） */
  lift: number;
  /** 卡片頂條漸層 CSS 字串，"none"＝無頂條 */
  grad: string;
  /** 主按鈕 hover 陰影，"none"＝不加光暈（舊主題填按鈕原陰影，外觀不變） */
  shadowHover: string;
  /** 卡片 hover 陰影（舊主題填卡片原陰影，外觀不變） */
  shadowCardHover: string;
  btnHoverBg: string;
  btnHoverColor: string;
  rowHover: string;
  navHover: string;
  updatedAt?: unknown;
  updatedBy?: string;
}

/** 舊主題的殼層預設（v1.32.0 前外觀）：按鈕圓角 8px、卡片 10px、不浮起、無頂條 */
const LEGACY_SHELL = {
  radiusBtn: 8,
  radiusCard: 10,
  lift: 0,
  grad: "none",
  shadowHover:
    "0 4px 12px color-mix(in srgb, var(--teal) 12%, transparent)",
  shadowCardHover: "0 2px 7px rgba(30,54,60,.018)",
  rowHover: "#fcfdfd",
  navHover: "#f5f8f8",
} as const;

/** 9 套內建主題（舊 4 套 9 變數沿用現行值，改版後外觀與改版前相同；
   僅兩處為通過 §2.4 對比驗證而調深一階，肉眼幾乎無差：blue-3 accentDeep
   #237fae→#1f709e（原白字 4.45／淡底 3.97），teal-orange-3 accentDeep
   #b25f1d→#a05518（原淡底 4.12）） */
export const BUILT_IN_THEMES: UiThemeDef[] = [
  {
    id: "green-2",
    name: "雅致綠",
    source: "內建預設",
    builtIn: true,
    hidden: false,
    order: 0,
    teal: "#0f766e",
    tealDeep: "#0d625c",
    tealSoft: "#e9f5f3",
    accent: "#4d7f78",
    accentDeep: "#3d6660",
    accentSoft: "#edf4f2",
    accent2: "#4d7f78",
    accent2Deep: "#3d6660",
    accent2Soft: "#edf4f2",
    bg: "#f5f7f8",
    ...LEGACY_SHELL,
    btnHoverBg: "#0d625c",
    btnHoverColor: "#ffffff",
  },
  {
    id: "blue-3",
    name: "醫療藍",
    source: "內建預設",
    builtIn: true,
    hidden: false,
    order: 1,
    teal: "#1e6fb8",
    tealDeep: "#175a95",
    tealSoft: "#e9f2fb",
    accent: "#2f9fd8",
    accentDeep: "#1f709e",
    accentSoft: "#e6f4fc",
    accent2: "#2f9fd8",
    accent2Deep: "#237fae",
    accent2Soft: "#e6f4fc",
    bg: "#f5f7f8",
    ...LEGACY_SHELL,
    btnHoverBg: "#175a95",
    btnHoverColor: "#ffffff",
  },
  {
    id: "teal-orange-3",
    name: "青橘",
    source: "內建預設",
    builtIn: true,
    hidden: false,
    order: 2,
    teal: "#0f766e",
    tealDeep: "#0d625c",
    tealSoft: "#e9f5f3",
    accent: "#d97a2b",
    accentDeep: "#a05518",
    accentSoft: "#fdf0e2",
    accent2: "#d97a2b",
    accent2Deep: "#b25f1d",
    accent2Soft: "#fdf0e2",
    bg: "#f5f7f8",
    ...LEGACY_SHELL,
    btnHoverBg: "#0d625c",
    btnHoverColor: "#ffffff",
  },
  {
    id: "purple-4",
    name: "沉穩紫",
    source: "內建預設",
    builtIn: true,
    hidden: false,
    order: 3,
    teal: "#6d4fa3",
    tealDeep: "#573d85",
    tealSoft: "#f0eaf8",
    accent: "#0f766e",
    accentDeep: "#0d625c",
    accentSoft: "#e9f5f3",
    accent2: "#c08a2d",
    accent2Deep: "#9a6e22",
    accent2Soft: "#faf3e4",
    bg: "#f5f7f8",
    ...LEGACY_SHELL,
    btnHoverBg: "#573d85",
    btnHoverColor: "#ffffff",
  },
  {
    id: "printmax-green",
    name: "薄荷綠橘",
    source: "借鑑 mobanwang 23167",
    builtIn: true,
    hidden: false,
    order: 4,
    teal: "#0e856c",
    tealDeep: "#0a6e57",
    tealSoft: "#d8f3e6",
    accent: "#12836a",
    accentDeep: "#0e6b53",
    accentSoft: "#e6f6ef",
    accent2: "#b4531a",
    accent2Deep: "#8a3f14",
    accent2Soft: "#fdf0e3",
    bg: "#eef8f1",
    radiusBtn: 999,
    radiusCard: 16,
    lift: 2,
    grad: "linear-gradient(90deg,#35d49b,#ffb08a)",
    shadowHover: "0 6px 18px rgba(53,212,155,.45)",
    shadowCardHover: "0 8px 24px rgba(11,122,95,.14)",
    btnHoverBg: "#0e856c",
    btnHoverColor: "#ffffff",
    rowHover: "#e6f6ef",
    navHover: "#d8f3e6",
  },
  {
    id: "dexon-mint",
    name: "薄荷亮黃",
    source: "借鑑 mobanwang 23160",
    builtIn: true,
    hidden: false,
    order: 5,
    teal: "#0e7a5f",
    tealDeep: "#0a5c48",
    tealSoft: "#d9f2e6",
    accent: "#0b6b52",
    accentDeep: "#084d3c",
    accentSoft: "#d9f2e6",
    accent2: "#8a6d1a",
    accent2Deep: "#6b5413",
    accent2Soft: "#fbf3d3",
    bg: "#eaf9f4",
    radiusBtn: 999,
    radiusCard: 16,
    lift: 2,
    grad: "linear-gradient(90deg,#35d49b,#ffde5d)",
    shadowHover: "0 6px 18px rgba(255,222,93,.5)",
    shadowCardHover: "0 8px 24px rgba(14,122,95,.14)",
    btnHoverBg: "#ffde5d",
    btnHoverColor: "#101210",
    rowHover: "#d9f2e6",
    navHover: "#d9f2e6",
  },
  {
    id: "edu-blue",
    name: "教育寶藍",
    source: "借鑑 mobanwang 23152",
    builtIn: true,
    hidden: false,
    order: 6,
    teal: "#4361ee",
    tealDeep: "#3a0ca3",
    tealSoft: "#e6ebff",
    accent: "#4361ee",
    accentDeep: "#2e3fa8",
    accentSoft: "#e6ebff",
    accent2: "#c9184a",
    accent2Deep: "#9e1239",
    accent2Soft: "#fde8ef",
    bg: "#f4f6ff",
    radiusBtn: 999,
    radiusCard: 14,
    lift: 2,
    grad: "linear-gradient(90deg,#4361ee,#3a0ca3)",
    shadowHover: "0 6px 18px rgba(67,97,238,.35)",
    shadowCardHover: "0 8px 24px rgba(67,97,238,.16)",
    btnHoverBg: "#3a0ca3",
    btnHoverColor: "#ffffff",
    rowHover: "#e6ebff",
    navHover: "#e6ebff",
  },
  {
    id: "bistro-brown",
    name: "陶土棕",
    source: "借鑑 mobanwang 23137",
    builtIn: true,
    hidden: false,
    order: 7,
    teal: "#a85f36",
    tealDeep: "#7e4a2b",
    tealSoft: "#f7ebe2",
    accent: "#a85f36",
    accentDeep: "#7e4a2b",
    accentSoft: "#f7ebe2",
    accent2: "#96600f",
    accent2Deep: "#75500c",
    accent2Soft: "#faf0d9",
    bg: "#fbfaf7",
    radiusBtn: 12,
    radiusCard: 14,
    lift: 2,
    grad: "linear-gradient(90deg,#c17c54,#b36c48)",
    shadowHover: "0 6px 18px rgba(193,124,84,.35)",
    shadowCardHover: "0 8px 24px rgba(168,95,54,.14)",
    btnHoverBg: "#7e4a2b",
    btnHoverColor: "#ffffff",
    rowHover: "#f7ebe2",
    navHover: "#f7ebe2",
  },
  {
    id: "paw-orange",
    name: "暖橘酒紅",
    source: "借鑑 mobanwang 23149",
    builtIn: true,
    hidden: false,
    order: 8,
    teal: "#9c6210",
    tealDeep: "#8a5510",
    tealSoft: "#fbeed3",
    accent: "#7d4b4e",
    accentDeep: "#5f383b",
    accentSoft: "#f3e6e7",
    accent2: "#a06a12",
    accent2Deep: "#7a4e0c",
    accent2Soft: "#fdf0d8",
    bg: "#fff8e8",
    radiusBtn: 999,
    radiusCard: 16,
    lift: 2,
    grad: "linear-gradient(90deg,#f6ab4a,#7d4b4e)",
    shadowHover: "0 6px 18px rgba(246,171,74,.45)",
    shadowCardHover: "0 8px 24px rgba(156,98,16,.14)",
    btnHoverBg: "#8a5510",
    btnHoverColor: "#ffffff",
    rowHover: "#fbeed3",
    navHover: "#fbeed3",
  },
];

/** 主題配色選項（相容舊呼叫端；新程式請走 themeRegistry 的 loadThemes） */
export const UI_THEMES: { id: string; name: string }[] = BUILT_IN_THEMES.map(
  ({ id, name }) => ({ id, name }),
);

export function themeName(id: string): string {
  return BUILT_IN_THEMES.find((t) => t.id === id)?.name ?? id;
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
  statsCycle: "year",
};

/** 統計週期下拉選項 */
export const STATS_CYCLE_OPTIONS: { value: "year" | "academic"; label: string }[] = [
  { value: "year", label: "年度" },
  { value: "academic", label: "學年度" },
];

/**
 * 系統參數中需渲染為下拉選單的欄位 → 選項清單（參數編輯器讀此表）。
 * 未列出的欄位沿用舊規則：boolean→勾選框、number→數字框、string→文字框。
 */
export const SYSTEM_PARAM_SELECT_OPTIONS: Partial<
  Record<keyof SystemParams, { value: string; label: string }[]>
> = {
  statsCycle: STATS_CYCLE_OPTIONS,
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
  statsCycle: "統計週期",
};

/**
 * 系統初始化（v1.37.0）：只寫入 systemParams/config 與內建主題。
 * 職稱／角色不再有預設、也不自動補種，由系統管理員自行建立後再到權限管理設定權限。
 * SEED_ROLES／SEED_TITLES 常數保留（demoData 展示資料仍在引用），不是運行時預設。
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
  // v1.32.0：內建主題種子（uiThemes 集合，僅缺失時寫入，不覆蓋已自訂／已隱藏狀態）
  for (const theme of BUILT_IN_THEMES) {
    const ref = doc(db, "uiThemes", theme.id);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        ...theme,
        createdAt: now,
        updatedAt: now,
        createdBy: staffId,
      });
    }
  }
}
