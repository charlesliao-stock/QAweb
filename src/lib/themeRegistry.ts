/**
 * 主題 registry（v1.32.0，資料驅動架構，設計 v2 §1–§3）。
 *
 * 運行時唯一來源是 Firestore `uiThemes` 集合；`BUILT_IN_THEMES`（seed.ts）
 * 只是種子來源＋離線／空庫 fallback。有效主題＝registry 內有的 id，
 * 不再有任何寫死的主題 id 陣列（根治 v1.31.0 白名單 bug：65a8da0 寫死的
 * 4 套白名單漏了第 5 套，導致新主題存得到、選得到、套不上）。
 *
 * 讀取走既有漏斗：refCache 記憶體快取＋cache-first 持久快取；寫入走
 * lib/db.ts 統一出口，成功後自動失效 uiThemes 快取。
 */
import {
  collection,
  doc,
  getDoc,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from "./db";
import { getDocsCacheFirst } from "./cacheFirst";
import { getFirebaseDb } from "./firebase";
import { getCachedRefCollection } from "./refCache";
import { BUILT_IN_THEMES, type UiThemeDef } from "./seed";

export type { UiThemeDef };

/** 內建主題預設殼層（文件缺欄位時補值用；與 seed.ts LEGACY_SHELL 對應） */
const FALLBACK_SHELL: Omit<
  UiThemeDef,
  "id" | "name" | "source" | "builtIn" | "hidden" | "order"
> = {
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
  radiusBtn: 8,
  radiusCard: 10,
  lift: 0,
  grad: "none",
  shadowHover: "0 4px 12px color-mix(in srgb, var(--teal) 12%, transparent)",
  shadowCardHover: "0 2px 7px rgba(30,54,60,.018)",
  btnHoverBg: "#0d625c",
  btnHoverColor: "#ffffff",
  rowHover: "#fcfdfd",
  navHover: "#f5f8f8",
};

let registry: UiThemeDef[] | null = null;
let inflight: Promise<UiThemeDef[]> | null = null;

/** 測試接縫：直接注入 registry（test-v1.32.mjs 用，不碰 Firestore）。 */
export function setThemeRegistry(defs: UiThemeDef[]): void {
  registry = [...defs].sort((a, b) => a.order - b.order);
}

/** 寫入主題後失效 registry（db.ts 的 refCache 失效管不到此模組快取）。 */
export function clearThemeRegistry(): void {
  registry = null;
}

/** 目前 registry 快照；尚未載入時回內建常數（不拋錯、不擋登入）。 */
export function getRegistrySnapshot(): UiThemeDef[] {
  return registry ?? BUILT_IN_THEMES;
}

export function getThemeDef(id: string): UiThemeDef | undefined {
  return getRegistrySnapshot().find((t) => t.id === id);
}

export function isValidThemeId(id: string): boolean {
  return getThemeDef(id) !== undefined;
}

/** 可見主題（未隱藏），依 order 排序。 */
export function visibleThemes(): UiThemeDef[] {
  return getRegistrySnapshot()
    .filter((t) => !t.hidden)
    .sort((a, b) => a.order - b.order);
}

/** 將 Firestore 文件資料正規化為完整定義：缺欄位時以同 id 內建主題補值。 */
export function normalizeThemeDef(
  id: string,
  data: Record<string, unknown>,
): UiThemeDef {
  const builtIn = BUILT_IN_THEMES.find((t) => t.id === id);
  const base = { ...FALLBACK_SHELL, ...(builtIn ?? {}) };
  const str = (key: string, fallback: string): string =>
    typeof data[key] === "string" && (data[key] as string).length > 0
      ? (data[key] as string)
      : fallback;
  const num = (key: string, fallback: number): number =>
    typeof data[key] === "number" && Number.isFinite(data[key] as number)
      ? (data[key] as number)
      : fallback;
  return {
    id,
    name: str("name", builtIn?.name ?? id),
    source: str("source", builtIn?.source ?? "管理員自訂"),
    builtIn: typeof data.builtIn === "boolean" ? data.builtIn : !!builtIn,
    hidden: data.hidden === true,
    order: num("order", builtIn?.order ?? 999),
    teal: str("teal", base.teal),
    tealDeep: str("tealDeep", base.tealDeep),
    tealSoft: str("tealSoft", base.tealSoft),
    accent: str("accent", base.accent),
    accentDeep: str("accentDeep", base.accentDeep),
    accentSoft: str("accentSoft", base.accentSoft),
    accent2: str("accent2", base.accent2),
    accent2Deep: str("accent2Deep", base.accent2Deep),
    accent2Soft: str("accent2Soft", base.accent2Soft),
    bg: str("bg", base.bg),
    radiusBtn: num("radiusBtn", base.radiusBtn),
    radiusCard: num("radiusCard", base.radiusCard),
    lift: num("lift", base.lift),
    grad: str("grad", base.grad),
    shadowHover: str("shadowHover", base.shadowHover),
    shadowCardHover: str("shadowCardHover", base.shadowCardHover),
    btnHoverBg: str("btnHoverBg", base.btnHoverBg),
    btnHoverColor: str("btnHoverColor", base.btnHoverColor),
    rowHover: str("rowHover", base.rowHover),
    navHover: str("navHover", base.navHover),
  };
}

/**
 * 載入全部主題（cache-first＋refCache 漏斗）。失敗或空集合時回內建常數。
 * 啟動多 1 次 list 查詢（首載約 9 筆文件讀取，之後快取命中為 0 次）。
 */
export function loadThemes(): Promise<UiThemeDef[]> {
  if (registry) return Promise.resolve(registry);
  if (inflight) return inflight;
  inflight = getCachedRefCollection("uiThemes", () =>
    getDocsCacheFirst(
      query(
        collection(getFirebaseDb(), "uiThemes"),
        orderBy("order", "asc"),
      ),
    ),
  )
    .then((snap) => {
      const defs = snap.docs.map((d) =>
        normalizeThemeDef(d.id, d.data() as Record<string, unknown>),
      );
      registry = defs.length > 0 ? defs : [...BUILT_IN_THEMES];
      return registry;
    })
    .catch(() => {
      registry = [...BUILT_IN_THEMES];
      return registry;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * 補齊內建主題（僅管理員呼叫）：缺失者 setDoc 補齊，不覆蓋已存在者
 *（不動 hidden／自訂內容）。補齊後清掉 registry，下次 loadThemes 重拉。
 */
export async function ensureBuiltIns(staffId: string): Promise<void> {
  const db = getFirebaseDb();
  for (const theme of BUILT_IN_THEMES) {
    const ref = doc(db, "uiThemes", theme.id);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        ...theme,
        updatedAt: serverTimestamp(),
        updatedBy: staffId,
      });
    }
  }
  registry = null;
}

/** 主題定義 → CSS 變數（kebab-case，供 applyTheme 與管理介面迷你預覽共用）。 */
export function themeToCssVars(def: UiThemeDef): Record<string, string> {
  return {
    "--teal": def.teal,
    "--teal-deep": def.tealDeep,
    "--teal-soft": def.tealSoft,
    "--accent": def.accent,
    "--accent-deep": def.accentDeep,
    "--accent-soft": def.accentSoft,
    "--accent2": def.accent2,
    "--accent2-deep": def.accent2Deep,
    "--accent2-soft": def.accent2Soft,
    "--bg": def.bg,
    "--radius-btn": `${def.radiusBtn}px`,
    "--radius-card": `${def.radiusCard}px`,
    "--lift": String(def.lift),
    "--grad": def.grad,
    "--shadow-hover": def.shadowHover,
    "--shadow-card-hover": def.shadowCardHover,
    "--btn-hover-bg": def.btnHoverBg,
    "--btn-hover-color": def.btnHoverColor,
    "--row-hover": def.rowHover,
    "--nav-hover": def.navHover,
  };
}
