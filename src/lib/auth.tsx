import { loadRefCollection } from "./refLoad";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  type User as FirebaseUser,
} from "firebase/auth";
import { doc, getDoc, updateDoc } from "./db";
// 寄信記錄在「尚未登入」時寫入，不能走雙寫層（Supabase 需登入身分），直接寫 Firestore
import { addDoc, collection as rawCollection, serverTimestamp } from "firebase/firestore";
import { getFirebaseAuth, getFirebaseDb } from "./firebase";
import { isDemoMode, setDemoMode } from "./demoMode";
import { clearRefCache } from "./refCache";
import { activeRolesForReviewerExpiry, isReviewerAccessActive } from "./reviewerValidity";
import { parseMemberships, type Membership } from "./roleIdentity";
import { buildRoleMetaMap, type RoleMetaMap } from "./orgMeta";
import { setMaintenanceAdmin } from "./maintenance";

/** 登入時載入的角色詮釋資料快取（效期計時器共用，避免每 30 秒重讀）。 */
let cachedRoleMeta: RoleMetaMap | undefined;

/** 認證信與登入共用的信箱網域：帳號信箱一律是「職編@kmuh.org.tw」。 */
export const STAFF_MAIL_DOMAIN = "kmuh.org.tw";

/**
 * 整理使用者輸入的職編：全形轉半形、移除所有空白；
 * 若誤輸入完整信箱（含 @），只取 @ 前面的職編。
 */
export function normalizeStaffId(input: string): string {
  const folded = input.normalize("NFKC").replace(/\s+/g, "");
  const at = folded.indexOf("@");
  return at >= 0 ? folded.slice(0, at) : folded;
}

/** 登入用 email 合成規則：職編即帳號，信箱＝職編@kmuh.org.tw（認證連結也寄到此信箱） */
export function staffEmail(staffId: string): string {
  return `${normalizeStaffId(staffId)}@${STAFF_MAIL_DOMAIN}`;
}

/**
 * 帳號開通（v1.83.0）：管理員匯入人員檔後，由 GitHub Actions（provision-auth-accounts）
 * 為尚無登入帳號者建立 Firebase 帳號（隨機密碼、無人知道）。人員在登入頁按「開通帳號／
 * 忘記密碼」，系統以 Firebase 內建信寄認證連結到「職編@kmuh.org.tw」，點連結自設密碼。
 * 不再有「初始密碼＝職編」的約定。展示帳號 demo／demo 不適用。
 */

export interface StaffProfile {
  staffId: string;
  name: string;
  unitCode: string;
  unitName: string;
  /** 職稱名稱（v1.12.0：權限交集判斷用；""＝未設定） */
  title: string;
  /** 新版職稱主檔 ID；舊人員資料可能為空，授權時再以職稱＋單位唯一比對。 */
  titleId: string;
  roles: string[];
  /** 僅保留明確儲存的群組成員角色，不把舊角色聯集擴散至多個群組。 */
  memberships: Membership[];
  reviewerAccessExpiresAt: string;
  /** v1.58.0：督導負責的單位代碼（僅部級職稱為督導時設定；承接舊督導轄區群組） */
  titleUnitCodes: string[];
  mustChangePassword: boolean;
  /** 首次成功登入時間（ISO；空字串＝尚未開通／從未登入） */
  activatedAt: string;
}

interface AuthContextValue {
  user: StaffProfile | null;
  firebaseUser: FirebaseUser | null;
  loading: boolean;
  needsPasswordChange: boolean;
  login: (staffId: string, password: string) => Promise<void>;
  changePassword: (newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** 展示模式假使用者：不經 Firebase Auth，所有資料走記憶體 */
const DEMO_USER: StaffProfile = {
  staffId: "demo",
  name: "展示管理員",
  unitCode: "",
  unitName: "",
  title: "督導",
  titleId: "",
  roles: ["系統管理員"],
  memberships: [],
  reviewerAccessExpiresAt: "",
  titleUnitCodes: [],
  mustChangePassword: false,
  activatedAt: "",
};

function toAuthErrorMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "職編或密碼錯誤";
    case "auth/invalid-email":
      return "職編格式不正確，請只輸入職編（不需輸入 @kmuh.org.tw）";
    case "auth/user-disabled":
      return "此帳號已停用，請聯絡系統管理員";
    case "auth/too-many-requests":
      return "嘗試次數過多，請稍後再試";
    case "auth/quota-exceeded":
      return "今日寄信額度已用完，請明天再試或聯絡系統管理員";
    case "auth/network-request-failed":
      return "網路連線失敗，請檢查網路後再試";
    case "auth/operation-not-allowed":
      return "登入功能尚未啟用，請聯絡系統管理員";
    case "auth/weak-password":
      return "新密碼強度不足，請使用至少 6 個字元";
    case "auth/requires-recent-login":
      return "安全驗證逾時，請重新登入後再變更密碼";
    default:
      return error instanceof Error && error.message
        ? error.message
        : "登入失敗，請稍後再試";
  }
}

/**
 * 寄送開通／重設密碼認證連結（Firebase 內建信，Spark 每日上限 150 封，見 README）。
 * 一律回傳成功訊息，不透露職編是否存在；實際錯誤只擋格式與頻率。
 */
/**
 * 寄信記錄（v1.84.0，前端回報、僅供參考）：寄信當下尚未登入，Spark 沒有後端可可靠記錄，
 * 所以由登入頁回報到 mailLogs（規則限制欄位與大小，僅管理員可讀）。任何人都可能偽造或灌入，
 * 記錄失敗也不影響寄信。
 */
function logMailAttempt(staffId: string, result: string): void {
  try {
    void addDoc(rawCollection(getFirebaseDb(), "mailLogs"), {
      staffId: staffId.slice(0, 32),
      result,
      source: "client",
      at: serverTimestamp(),
    }).catch(() => undefined);
  } catch {
    /* 記錄失敗不影響寄信 */
  }
}

export async function requestActivationMail(staffId: string): Promise<void> {
  const id = normalizeStaffId(staffId);
  if (!id) throw new Error("請輸入職編");
  try {
    await sendPasswordResetEmail(getFirebaseAuth(), staffEmail(id));
    logMailAttempt(id, "accepted");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "other";
    logMailAttempt(id, code.replace(/^auth\//, "").slice(0, 40));
    // 帳號不存在（尚未建立／職編錯誤）不告知，避免被拿來探測職編
    if (code === "auth/user-not-found") return;
    throw new Error(toAuthErrorMessage(error));
  }
}

async function loadProfile(staffId: string): Promise<StaffProfile> {
  const db = getFirebaseDb();
  const snapshot = await getDoc(doc(db, "users", staffId));
  if (!snapshot.exists()) {
    await signOut(getFirebaseAuth());
    throw new Error("找不到人員資料，請聯絡系統管理員");
  }
  const raw = snapshot.data();
  if (raw.status === "停用") {
    await signOut(getFirebaseAuth());
    throw new Error("此帳號已停用，請聯絡系統管理員");
  }
  const storedRoles = Array.isArray(raw.roles) ? raw.roles.map(String) : [];
  const memberships = parseMemberships(raw.memberships);
  const reviewerAccessExpiresAt = typeof raw.reviewerAccessExpiresAt === "string"
    ? raw.reviewerAccessExpiresAt
    : "";
  // v1.40.5：效期清理改以角色類別判斷（載入 roles 集合建詮釋資料；
  // 讀取失敗時退回舊名稱推導，不阻擋登入）
  let roleMeta;
  try {
    const roleSnap = await loadRefCollection("roles");
    roleMeta = buildRoleMetaMap(
      roleSnap.docs.map((d) => {
        const v = d.data() as Record<string, unknown>;
        return {
          name: typeof v.name === "string" ? v.name : d.id,
          levelId: v.levelId,
        };
      }),
    );
  } catch {
    roleMeta = undefined;
  }
  cachedRoleMeta = roleMeta;
  const roles = activeRolesForReviewerExpiry(storedRoles, reviewerAccessExpiresAt, new Date(), roleMeta);
  const titleUnitCodes = Array.isArray(raw.titleUnitCodes)
    ? raw.titleUnitCodes.map(String)
    : [];
  return {
    staffId,
    name: typeof raw.name === "string" ? raw.name : staffId,
    unitCode: typeof raw.unitCode === "string" ? raw.unitCode : "",
    unitName: typeof raw.unitName === "string" ? raw.unitName : "",
    title: typeof raw.title === "string" ? raw.title : "",
    titleId: typeof raw.titleId === "string" ? raw.titleId : "",
    roles,
    memberships,
    reviewerAccessExpiresAt,
    titleUnitCodes,
    mustChangePassword: raw.mustChangePassword === true,
    activatedAt: typeof raw.activatedAt === "string" ? raw.activatedAt : "",
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [user, setUser] = useState<StaffProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsPasswordChange, setNeedsPasswordChange] = useState(false);

  useEffect(() => {
    // 展示模式：直接恢復 demo session，不訂閱 Firebase Auth
    if (isDemoMode()) {
      setFirebaseUser(null);
      setUser(DEMO_USER);
      setNeedsPasswordChange(false);
      setLoading(false);
      return;
    }
    const auth = getFirebaseAuth();
    const unsubscribe = onAuthStateChanged(auth, async (current) => {
      setFirebaseUser(current);
      if (!current?.email) {
        setUser(null);
        setNeedsPasswordChange(false);
        setLoading(false);
        return;
      }
      const staffId = current.email.split("@")[0] ?? "";
      try {
        const profile = await loadProfile(staffId);
        setUser(profile);
        // v1.41.0 流量控管：管理員在維護期間豁免攔截
        setMaintenanceAdmin(profile.roles.includes("系統管理員"));
        setNeedsPasswordChange(profile.mustChangePassword);
      } catch {
        setUser(null);
        setMaintenanceAdmin(false);
        setNeedsPasswordChange(false);
      } finally {
        setLoading(false);
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const expiry = user?.reviewerAccessExpiresAt;
    if (!expiry || !isReviewerAccessActive(expiry)) return;
    const timer = window.setInterval(() => {
      if (isReviewerAccessActive(expiry)) return;
      window.clearInterval(timer);
      setUser((current) => {
        if (!current) return current;
        const roles = activeRolesForReviewerExpiry(current.roles, expiry, new Date(), cachedRoleMeta);
        return roles.length === current.roles.length ? current : { ...current, roles };
      });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [user?.reviewerAccessExpiresAt]);

  const login = useCallback(async (staffId: string, password: string) => {
    const trimmed = normalizeStaffId(staffId);
    if (!trimmed || !password) {
      throw new Error("請輸入職編與密碼");
    }
    // 展示帳號：不經 Firebase，所有操作只寫入記憶體
    if (trimmed === "demo" && password === "demo") {
      setDemoMode(true);
      setFirebaseUser(null);
      setUser(DEMO_USER);
      setNeedsPasswordChange(false);
      return;
    }
    try {
      const auth = getFirebaseAuth();
      await signInWithEmailAndPassword(auth, staffEmail(trimmed), password);
      let profile = await loadProfile(trimmed);
      // v1.83.0：首次成功登入記下開通時間（供排程提醒「尚未開通的審查員」；失敗不擋登入）
      if (!profile.activatedAt) {
        const activatedAt = new Date().toISOString();
        try {
          await updateDoc(doc(getFirebaseDb(), "users", trimmed), { activatedAt });
          profile = { ...profile, activatedAt };
        } catch {
          /* 寫入失敗不影響登入，下次登入再補 */
        }
      }
      setUser(profile);
      // v1.41.0 流量控管：管理員在維護期間豁免攔截
      setMaintenanceAdmin(profile.roles.includes("系統管理員"));
      setNeedsPasswordChange(profile.mustChangePassword);
    } catch (error) {
      throw new Error(toAuthErrorMessage(error));
    }
  }, []);

  const changePassword = useCallback(
    async (newPassword: string) => {
      // 展示模式：直接成功，不做任何事
      if (isDemoMode()) {
        setNeedsPasswordChange(false);
        return;
      }
      const auth = getFirebaseAuth();
      const current = auth.currentUser;
      if (!current || !user) {
        throw new Error("請先登入");
      }
      if (newPassword.length < 6) {
        throw new Error("新密碼至少需要 6 個字元");
      }
      try {
        await updatePassword(current, newPassword);
        await updateDoc(doc(getFirebaseDb(), "users", user.staffId), {
          mustChangePassword: false,
        });
        setNeedsPasswordChange(false);
        setUser({ ...user, mustChangePassword: false });
      } catch (error) {
        throw new Error(toAuthErrorMessage(error));
      }
    },
    [user],
  );

  const logout = useCallback(async () => {
    // v1.28 階段 4：登出清空參考快取（換帳號不沿用上一人的記憶體快取）
    clearRefCache();
    // v1.41.0 流量控管：登出即取消管理員豁免
    setMaintenanceAdmin(false);
    if (isDemoMode()) {
      setDemoMode(false);
      setUser(null);
      setFirebaseUser(null);
      setNeedsPasswordChange(false);
      return;
    }
    await signOut(getFirebaseAuth());
    setUser(null);
    setFirebaseUser(null);
    setNeedsPasswordChange(false);
  }, []);

  const value = useMemo(
    () => ({
      user,
      firebaseUser,
      loading,
      needsPasswordChange,
      login,
      changePassword,
      logout,
    }),
    [user, firebaseUser, loading, needsPasswordChange, login, changePassword, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth 必須在 AuthProvider 內使用");
  }
  return context;
}
