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
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  type User as FirebaseUser,
} from "firebase/auth";
import { doc, getDoc, updateDoc } from "./db";
import { getFirebaseAuth, getFirebaseDb } from "./firebase";
import { isDemoMode, setDemoMode } from "./demoMode";

/** 登入用 email 合成規則：職編即帳號，phase 1 不寄信故用內部網域 */
export function staffEmail(staffId: string): string {
  return `${staffId.trim()}@nurseboard.internal`;
}

export interface StaffProfile {
  staffId: string;
  name: string;
  unitCode: string;
  unitName: string;
  roles: string[];
  mustChangePassword: boolean;
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
  roles: ["系統管理員"],
  mustChangePassword: false,
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
    case "auth/user-disabled":
      return "此帳號已停用，請聯絡系統管理員";
    case "auth/too-many-requests":
      return "嘗試次數過多，請稍後再試";
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
  const roles = Array.isArray(raw.roles) ? raw.roles.map(String) : [];
  return {
    staffId,
    name: typeof raw.name === "string" ? raw.name : staffId,
    unitCode: typeof raw.unitCode === "string" ? raw.unitCode : "",
    unitName: typeof raw.unitName === "string" ? raw.unitName : "",
    roles,
    mustChangePassword: raw.mustChangePassword === true,
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
        setNeedsPasswordChange(profile.mustChangePassword);
      } catch {
        setUser(null);
        setNeedsPasswordChange(false);
      } finally {
        setLoading(false);
      }
    });
    return unsubscribe;
  }, []);

  const login = useCallback(async (staffId: string, password: string) => {
    const trimmed = staffId.trim();
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
      const profile = await loadProfile(trimmed);
      setUser(profile);
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
