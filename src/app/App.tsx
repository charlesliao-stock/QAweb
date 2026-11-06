import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  BookOpenCheck,
  CalendarDays,
  Check,
  ClipboardCheck,
  FileBarChart2,
  GitBranch,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Menu,
  Settings2,
  X,
} from "lucide-react";
import { AuthProvider, useAuth } from "../lib/auth";
import { doc, getDoc } from "../lib/db";
import { getFirebaseDb } from "../lib/firebase";
import {
  applyTheme,
  applyUiPrefs,
} from "../lib/uiPrefs";
import { BrandMark } from "../components/ui";
import { VERSION_LABEL } from "../version";
import { AdminPage } from "../features/AdminPage";
import { AuditPage } from "../features/AuditPage";
import { CapaPage } from "../features/CapaPage";
import { DashboardPage } from "../features/DashboardPage";
import { GroupsPage } from "../features/GroupsPage";
import { IndicatorsPage } from "../features/IndicatorsPage";
import { ResultsPage } from "../features/ResultsPage";
import { SchedulePage } from "../features/SchedulePage";
import type { PageId } from "../types";

const NAV_GROUPS = [
  {
    label: "工作台",
    items: [{ id: "dashboard", label: "總覽儀表板", icon: LayoutDashboard }],
  },
  {
    label: "品質管理",
    items: [
      { id: "indicators", label: "指標管理", icon: BookOpenCheck },
      { id: "schedule", label: "品管審查排程", icon: CalendarDays },
      { id: "audit", label: "品管審查", icon: ClipboardCheck },
      { id: "results", label: "結果分析", icon: FileBarChart2 },
      { id: "capa", label: "CAPA 改善追蹤", icon: Activity },
    ],
  },
  {
    label: "組織與設定",
    items: [
      { id: "groups", label: "群組與人員", icon: GitBranch },
      { id: "admin", label: "系統管理", icon: Settings2 },
    ],
  },
] as const;

function LoginScreen() {
  const { login, changePassword, needsPasswordChange } = useAuth();
  const [staffId, setStaffId] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submitLogin = async () => {
    setError("");
    setBusy(true);
    try {
      await login(staffId, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登入失敗");
    } finally {
      setBusy(false);
    }
  };

  const submitPasswordChange = async () => {
    setError("");
    if (newPassword !== confirmPassword) {
      setError("兩次輸入的新密碼不一致");
      return;
    }
    setBusy(true);
    try {
      await changePassword(newPassword);
    } catch (err) {
      setError(err instanceof Error ? err.message : "密碼變更失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-screen">
      <div className="login-backdrop" />
      <section className="login-card">
        <div className="login-brand">
          <BrandMark />
          <span>
            護理品質<span>管理系統</span>
          </span>
        </div>
        {needsPasswordChange ? (
          <>
            <div className="login-eyebrow">
              <span className="live-dot" /> 首次登入
            </div>
            <h1>
              請先<em>變更密碼</em>
            </h1>
            <p className="login-lead">
              為保障帳號安全，首次登入須設定新密碼（至少 6 個字元）。
            </p>
            <label className="field-label" htmlFor="new-password">
              新密碼
            </label>
            <input
              id="new-password"
              className="text-input"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder="請輸入新密碼"
              autoComplete="new-password"
            />
            <label className="field-label" htmlFor="confirm-password">
              確認新密碼
            </label>
            <input
              id="confirm-password"
              className="text-input"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="請再輸入一次新密碼"
              autoComplete="new-password"
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitPasswordChange();
              }}
            />
            {error && <div className="login-error">{error}</div>}
            <button
              className="button button-primary login-action"
              onClick={() => void submitPasswordChange()}
              disabled={busy}
            >
              {busy ? "變更中…" : "變更密碼並進入"}
              <ArrowRight size={17} />
            </button>
          </>
        ) : (
          <>
            <div className="login-eyebrow">
              <span className="live-dot" /> 護理品質指標管理
            </div>
            <h1>
              讓品質改善
              <br />
              <em>每一步都有依據。</em>
            </h1>
            <p className="login-lead">
              檢視指標、審查進度與改善成效，從同一個工作台開始。
            </p>
            <label className="field-label" htmlFor="staff-id">
              職編
            </label>
            <input
              id="staff-id"
              className="text-input"
              value={staffId}
              onChange={(event) => setStaffId(event.target.value)}
              placeholder="請輸入職編"
              autoComplete="username"
            />
            <label className="field-label" htmlFor="password">
              密碼
            </label>
            <input
              id="password"
              className="text-input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="請輸入密碼"
              autoComplete="current-password"
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitLogin();
              }}
            />
            {error && <div className="login-error">{error}</div>}
            <button
              className="button button-primary login-action"
              onClick={() => void submitLogin()}
              disabled={busy}
            >
              {busy ? "登入中…" : "登入"}
              <ArrowRight size={17} />
            </button>
            <div className="login-foot">
              <LockKeyhole size={13} /> 連續錯誤 5 次將鎖定 15 分鐘
            </div>
            <div className="login-version">{VERSION_LABEL}</div>
            <div className="login-demo-hint">
              展示帳號：demo／demo（展示模式，操作不會寫入資料庫）
            </div>
          </>
        )}
      </section>
      <aside className="login-side-copy">
        <span>護理品質指標管理</span>
        <strong>
          把日常查核，
          <br />
          轉化為持續改善。
        </strong>
        <div className="login-side-stats">
          <div>
            <b>10</b>
            <span>步驟指引</span>
          </div>
          <div>
            <b>RAG</b>
            <span>即時狀態</span>
          </div>
          <div>
            <b>CAPA</b>
            <span>改善閉環</span>
          </div>
        </div>
      </aside>
    </main>
  );
}

function Sidebar({
  page,
  onPage,
  onExit,
  mobileOpen,
  onClose,
}: {
  page: PageId;
  onPage: (page: PageId) => void;
  onExit: () => void;
  mobileOpen: boolean;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const displayName = user?.name ?? "";
  const staffId = user?.staffId ?? "";
  const unitName = user?.unitName || user?.unitCode || "";
  return (
    <>
      {mobileOpen && (
        <button
          className="mobile-scrim"
          aria-label="關閉選單"
          onClick={onClose}
        />
      )}
      <aside className={`sidebar${mobileOpen ? " open" : ""}`}>
        <div className="sidebar-brand">
          <BrandMark />
          <div>
            <b>護理品質</b>
            <span>指標管理系統</span>
          </div>
          <button
            className="sidebar-close"
            onClick={onClose}
            aria-label="關閉選單"
          >
            <X size={18} />
          </button>
        </div>
        <nav className="main-nav" aria-label="主要導覽">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-group-label">{group.label}</span>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    className={`nav-item${page === item.id ? " active" : ""}`}
                    onClick={() => {
                      onPage(item.id as PageId);
                      onClose();
                    }}
                  >
                    <Icon size={18} strokeWidth={1.8} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="profile-row">
            <div className="profile-avatar">
              {displayName.slice(0, 1) || "使"}
            </div>
            <div className="profile-info">
              <b>{displayName}</b>
              <span>
                {staffId}
                {unitName ? ` · ${unitName}` : ""}
              </span>
            </div>
            <button
              className="icon-button profile-exit"
              aria-label="登出"
              onClick={onExit}
            >
              <LogOut size={16} />
            </button>
          </div>
          <div className="sidebar-version" title="系統版本">
            {VERSION_LABEL}
          </div>
        </div>
      </aside>
    </>
  );
}

function Shell() {
  const { user, loading, needsPasswordChange, logout } = useAuth();
  const [page, setPage] = useState<PageId>("dashboard");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [toast, setToast] = useState("");

  // v1.27.2：notify 必須是穩定引用。若每次渲染都產生新函式，各頁以 onAction 為依賴的
  // 載入 effect 會在 toast 顯示／消失（2 次重渲染）時整頁重拉 Firestore。
  const toastTimer = useRef<number | undefined>(undefined);
  const notify = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2600);
  }, []);

  // 個人顯示設定（本機）＋ 全院主題配色（系統參數）
  useEffect(() => {
    applyUiPrefs();
    getDoc(doc(getFirebaseDb(), "systemParams", "config"))
      .then((snap) => {
        const t = snap.exists()
          ? (snap.data() as { uiTheme?: unknown }).uiTheme
          : undefined;
        applyTheme(typeof t === "string" ? t : "green-2");
      })
      .catch(() => applyTheme("green-2"));
  }, []);

  if (loading) {
    return (
      <main className="login-screen">
        <div className="login-backdrop" />
        <section className="login-card">
          <div className="login-brand">
            <BrandMark />
            <span>
              護理品質<span>管理系統</span>
            </span>
          </div>
          <p className="login-lead">載入中…</p>
        </section>
      </main>
    );
  }

  if (!user || needsPasswordChange) {
    return <LoginScreen />;
  }

  return (
    <div className="app-shell">
      <Sidebar
        page={page}
        onPage={setPage}
        onExit={() => void logout()}
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
      />
      <main className="main-area">
        <div className="page-content">
          <button
            className="mobile-menu icon-button"
            aria-label="開啟選單"
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={20} />
          </button>
          {page === "dashboard" && <DashboardPage onAction={notify} />}
          {page === "indicators" && <IndicatorsPage onAction={notify} />}
          {page === "schedule" && <SchedulePage onAction={notify} />}
          {page === "audit" && <AuditPage onAction={notify} />}
          {page === "results" && <ResultsPage onAction={notify} />}
          {page === "groups" && <GroupsPage onAction={notify} />}
          {page === "capa" && <CapaPage onAction={notify} />}
          {page === "admin" && <AdminPage onAction={notify} />}
        </div>
      </main>
      {toast && (
        <div className="toast-message">
          <span>
            <Check size={15} />
          </span>
          {toast}
          <button onClick={() => setToast("")} aria-label="關閉提示">
            <X size={14} />
          </button>
        </div>
      )}
      <nav className="mobile-bottom-nav" aria-label="手機主要導覽">
        {[
          { id: "dashboard", label: "總覽", icon: LayoutDashboard },
          { id: "indicators", label: "指標", icon: BookOpenCheck },
          { id: "audit", label: "品管", icon: ClipboardCheck },
          { id: "results", label: "結果", icon: FileBarChart2 },
          { id: "groups", label: "更多", icon: Menu },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={page === item.id ? "active" : ""}
              onClick={() => setPage(item.id as PageId)}
            >
              <Icon size={19} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
