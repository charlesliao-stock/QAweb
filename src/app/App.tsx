import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  Activity,
  ArrowRight,
  Bell,
  BookOpenCheck,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  FileBarChart2,
  GitBranch,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Menu,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import { DEMO_INDICATORS } from "../data/demo";
import {
  isFirebaseAuditModeEnabled,
  isFirebaseDemoReadEnabled,
  readFirebaseIndicators,
  readDemoIndicators,
  signInWithStaffId,
  signOutFirebaseUser,
  watchFirebaseProfile,
  type FirebaseProfile,
  type DemoDataSource,
} from "../lib/firebase";
import { BrandMark, DemoBanner, PAGE_COPY } from "../components/ui";
import { AdminPage } from "../features/AdminPage";
import { AuditPage } from "../features/AuditPage";
import { CapaPage } from "../features/CapaPage";
import { DashboardPage } from "../features/DashboardPage";
import { GroupsPage } from "../features/GroupsPage";
import { IndicatorsPage } from "../features/IndicatorsPage";
import { ResultsPage } from "../features/ResultsPage";
import { SchedulePage } from "../features/SchedulePage";
import { canView } from "../lib/access";
import { ROLES, type PageId, type Role } from "../types";

interface NavItem {
  id: PageId;
  label: string;
  icon: typeof LayoutDashboard;
}

function isSystemAdminProfile(profile: FirebaseProfile | null): boolean {
  return profile?.roles.includes("系統管理員") ?? false;
}

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "工作台",
    items: [{ id: "dashboard", label: "總覽儀表板", icon: LayoutDashboard }],
  },
  {
    label: "品質管理",
    items: [
      { id: "indicators", label: "指標管理", icon: BookOpenCheck },
      { id: "schedule", label: "審查排程", icon: CalendarDays },
      { id: "audit", label: "指標審查", icon: ClipboardCheck },
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
];

function DemoLogin({ onEnter }: { onEnter: (role: Role) => void }) {
  const [role, setRole] = useState<Role>("品管執行幹事");
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
        <div className="login-eyebrow">
          <span className="live-dot" /> 僅供流程展示
        </div>
        <h1>
          讓品質改善
          <br />
          <em>每一步都有依據。</em>
        </h1>
        <p className="login-lead">
          檢視指標、審查進度與改善成效，從同一個工作台開始。
        </p>
        <div className="login-demo-note">
          <ShieldCheck size={17} />
          <span>
            <strong>展示模式已啟用</strong>
            <br />
            不需要帳號或密碼。系統使用虛構資料，未連接正式登入。
          </span>
        </div>
        <label className="field-label" htmlFor="demo-role">
          選擇展示角色
        </label>
        <div className="select-wrap">
          <select
            id="demo-role"
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
          >
            {ROLES.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
          <ChevronDown size={17} />
        </div>
        <button
          className="button button-primary login-action"
          onClick={() => onEnter(role)}
        >
          進入展示工作台 <ArrowRight size={17} />
        </button>
        <div className="login-foot">
          <LockKeyhole size={13} /> 展示流程不驗證身分，也不儲存輸入內容
        </div>
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

function FirebaseLogin({
  error,
  onLogin,
}: {
  error: string;
  onLogin: (profile: FirebaseProfile) => void;
}) {
  const [staffId, setStaffId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      onLogin(await signInWithStaffId(staffId, password));
    } catch (cause) {
      setMessage(
        cause instanceof Error ? cause.message : "登入失敗，請稍後再試。",
      );
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
        <div className="login-eyebrow">
          <span className="live-dot" /> Firebase Authentication
        </div>
        <h1>登入結果分析</h1>
        <p className="login-lead">
          使用既有系統帳號登入，依 Firestore Security Rules 讀取結果。
        </p>
        <div className="login-demo-note">
          <ShieldCheck size={17} />
          <span>本頁只讀取已送出的測試審查紀錄，不會寫入或修改審查資料。</span>
        </div>
        {(error || message) && (
          <div className="login-error" role="alert">
            {message || error}
          </div>
        )}
        <form onSubmit={submit}>
          <label className="field-label" htmlFor="firebase-staff-id">
            職編
          </label>
          <input
            id="firebase-staff-id"
            className="text-input"
            autoComplete="username"
            value={staffId}
            onChange={(event) => setStaffId(event.target.value)}
            required
          />
          <label className="field-label" htmlFor="firebase-password">
            密碼
          </label>
          <input
            id="firebase-password"
            className="text-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <button
            className="button button-primary login-action"
            type="submit"
            disabled={busy}
          >
            {busy ? "登入中…" : "登入並查看結果"}
          </button>
        </form>
      </section>
      <aside className="login-side-copy">
        <span>護理品質指標管理</span>
        <strong>
          以審查紀錄，
          <br />
          追蹤季度成效。
        </strong>
      </aside>
    </main>
  );
}

function Sidebar({
  page,
  role,
  authMode,
  profile,
  onPage,
  onRole,
  onExit,
  mobileOpen,
  onClose,
}: {
  page: PageId;
  role: Role;
  authMode: boolean;
  profile: FirebaseProfile | null;
  onPage: (page: PageId) => void;
  onRole: (role: Role) => void;
  onExit: () => void;
  mobileOpen: boolean;
  onClose: () => void;
}) {
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
        <div className="org-chip">
          <span className="org-avatar">護</span>
          <span>
            <b>示範醫療機構</b>
            <small>單院區 · 品質管理</small>
          </span>
          <ChevronDown size={14} />
        </div>
        <nav className="main-nav" aria-label="主要導覽">
          {NAV_GROUPS.map((group) => ({
            ...group,
            items: group.items.filter(
              (item) =>
                canView(role, item.id) &&
                (!authMode ||
                  isSystemAdminProfile(profile) ||
                  item.id === "results" ||
                  item.id === "schedule"),
            ),
          }))
            .filter((group) => group.items.length > 0)
            .map((group) => (
              <div className="nav-group" key={group.label}>
                <span className="nav-group-label">{group.label}</span>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      className={`nav-item${page === item.id ? " active" : ""}`}
                      aria-current={page === item.id ? "page" : undefined}
                      onClick={() => {
                        onPage(item.id);
                        onClose();
                      }}
                    >
                      <Icon size={18} strokeWidth={1.8} />
                      <span>{item.label}</span>
                      {item.id === "capa" && <i className="nav-count">3</i>}
                    </button>
                  );
                })}
              </div>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="role-box">
            <span className="role-box-label">目前角色視角</span>
            {authMode ? (
              <div className="select-wrap role-select">
                <span className="auth-role-label">{role}</span>
              </div>
            ) : (
              <div className="select-wrap role-select">
                <select
                  value={role}
                  onChange={(event) => onRole(event.target.value as Role)}
                  aria-label="切換展示角色"
                >
                  {ROLES.map((item) => (
                    <option key={item}>{item}</option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
            )}
            <small>
              {authMode
                ? "角色取自 Firebase users 權限資料"
                : "僅供展示，不代表實際授權"}
            </small>
          </div>
          <div className="profile-row">
            <div className="profile-avatar">示</div>
            <div className="profile-info">
              <b>{profile?.name ?? "示範使用者"}</b>
              <span>
                {profile
                  ? `${profile.staffId} · ${profile.unitCode || "未設定單位"}`
                  : "DEMO-001 · 示範單位"}
              </span>
            </div>
            <button
              className="icon-button profile-exit"
              aria-label="離開展示"
              onClick={onExit}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

export default function App() {
  const authMode = isFirebaseAuditModeEnabled();
  const [entered, setEntered] = useState(false);
  const [demoRole, setDemoRole] = useState<Role>("品管執行幹事");
  const [profile, setProfile] = useState<FirebaseProfile | null>(null);
  const [authReady, setAuthReady] = useState(!authMode);
  const [authError, setAuthError] = useState("");
  const [dataLoadError, setDataLoadError] = useState("");
  const [page, setPage] = useState<PageId>(authMode ? "results" : "dashboard");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [indicators, setIndicators] = useState(DEMO_INDICATORS);
  const [dataSource, setDataSource] = useState<DemoDataSource>("local");

  useEffect(() => {
    if (!authMode) return;
    let mounted = true;
    let unsubscribe: (() => void) | undefined;
    watchFirebaseProfile(
      (nextProfile) => {
        if (!mounted) return;
        setProfile(nextProfile);
        setAuthReady(true);
        if (nextProfile) setAuthError("");
      },
      (error) => {
        if (mounted)
          setAuthError(
            error instanceof Error ? error.message : "無法載入登入帳號資料。",
          );
      },
    )
      .then((stop) => {
        if (mounted) unsubscribe = stop;
        else stop();
      })
      .catch((error: unknown) => {
        if (mounted) {
          setAuthReady(true);
          setAuthError(
            error instanceof Error
              ? error.message
              : "Firebase Authentication 初始化失敗。",
          );
        }
      });
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [authMode]);

  useEffect(() => {
    if (!authMode || !profile) return;
    let mounted = true;
    setIndicators([]);
    readFirebaseIndicators()
      .then((rows) => {
        if (mounted) {
          setIndicators(rows);
          setDataSource("firebase");
          setDataLoadError("");
        }
      })
      .catch((error: unknown) => {
        if (mounted)
          setDataLoadError(
            error instanceof Error ? error.message : "讀取 Firebase 指標失敗。",
          );
      });
    return () => {
      mounted = false;
    };
  }, [authMode, profile]);

  useEffect(() => {
    if (!isFirebaseDemoReadEnabled()) return;
    let mounted = true;
    readDemoIndicators()
      .then((rows) => {
        if (!mounted) return;
        if (rows) {
          setIndicators(rows);
          setDataSource("firebase");
        }
      })
      .catch(() => {
        if (mounted) setDataSource("firebase-unavailable");
      });
    return () => {
      mounted = false;
    };
  }, []);

  const toastTimer = useRef<number | undefined>(undefined);
  const notify = useCallback((message: string) => {
    window.clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => setToast(""), 2600);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  const role: Role =
    authMode && profile
      ? profile.roles.includes("系統管理員")
        ? "系統管理員"
        : ((
            [
              "主任",
              "副主任",
              "督導",
              "各組召集人",
              "執行幹事",
              "品管執行幹事",
              "護理長",
              "指標負責人",
              "系統管理員",
              "審查員",
              "一般人員",
            ] as Role[]
          ).find((item) => profile.roles.includes(item)) ?? "一般人員")
      : demoRole;

  const changeRole = (next: Role) => {
    if (authMode) return;
    setDemoRole(next);
    if (!canView(next, page)) {
      setPage("dashboard");
      notify(`「${next}」視角無此頁面，已回到總覽`);
    }
  };

  const view: PageId = authMode
    ? isSystemAdminProfile(profile)
      ? canView(role, page)
        ? page
        : "admin"
      : page === "schedule" || page === "results"
        ? page
        : "results"
    : canView(role, page)
      ? page
      : "dashboard";

  if (authMode && !authReady)
    return (
      <main className="login-screen">
        <section className="login-card">正在確認 Firebase 登入狀態…</section>
      </main>
    );
  if (authMode && !profile)
    return (
      <FirebaseLogin
        error={authError}
        onLogin={(nextProfile) => {
          setProfile(nextProfile);
          setAuthError("");
        }}
      />
    );

  if (!authMode && !entered)
    return (
      <DemoLogin
        onEnter={(selectedRole) => {
          setDemoRole(selectedRole);
          setEntered(true);
        }}
      />
    );

  return (
    <div className="app-shell">
      <Sidebar
        page={view}
        role={role}
        authMode={authMode}
        profile={profile}
        onPage={setPage}
        onRole={changeRole}
        onExit={() => {
          if (authMode) {
            void signOutFirebaseUser().catch((error: unknown) =>
              setAuthError(
                error instanceof Error ? error.message : "登出失敗。",
              ),
            );
            setProfile(null);
          } else setEntered(false);
        }}
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
      />
      <main className="main-area">
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            aria-label="開啟選單"
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={20} />
          </button>
          <div className="topbar-crumb">
            <span>示範醫療機構</span>
            <ChevronRight size={14} />
            <b>{PAGE_COPY[view].title}</b>
          </div>
          <div className="topbar-actions">
            <div className="connection-status">
              <span className="live-dot" />
              {authMode ? "Firebase 已登入" : "線上展示"}
            </div>
            <button
              className="icon-button notification-button"
              aria-label="通知"
              onClick={() => notify("目前沒有新的展示通知")}
            >
              <Bell size={18} />
              <i />
            </button>
            <div className="topbar-user">
              <span className="profile-avatar small-avatar">
                {profile?.name?.slice(0, 1) ?? "示"}
              </span>
              <div>
                <b>{profile?.name ?? "示範使用者"}</b>
                <small>{role}</small>
              </div>
              <ChevronDown size={14} />
            </div>
          </div>
        </header>
        {authMode ? (
          <div className="demo-banner">
            {isSystemAdminProfile(profile)
              ? "系統管理員完整導覽；結果、年度排程與審查員清單可接 Firebase；授角寫入需 Rules 驗收，稽核事件、完整權限管理與 CAPA 尚未串接"
              : "Firebase 已登入 · 指標及審查結果唯讀；年度排程設定依權限儲存"}
          </div>
        ) : (
          <DemoBanner source={dataSource} />
        )}
        {dataLoadError && (
          <div className="login-error" role="alert">
            {dataLoadError}
          </div>
        )}
        <div className="page-content">
          {view === "dashboard" && (
            <DashboardPage role={role} onAction={notify} />
          )}
          {view === "indicators" && (
            <IndicatorsPage indicators={indicators} onAction={notify} />
          )}
          {view === "schedule" && (
            <SchedulePage
              indicators={indicators}
              firebaseMode={authMode}
              profile={profile}
              onAction={notify}
            />
          )}
          {view === "audit" && <AuditPage onAction={notify} />}
          {view === "results" && (
            <ResultsPage
              indicators={indicators}
              role={role}
              firebaseMode={authMode}
              profile={profile}
              onAction={notify}
            />
          )}
          {view === "groups" && (
            <GroupsPage
              firebaseMode={authMode}
              profile={profile}
              onAction={notify}
            />
          )}
          {view === "capa" && (
            <CapaPage firebaseMode={authMode} onAction={notify} />
          )}
          {view === "admin" && <AdminPage onAction={notify} />}
        </div>
      </main>
      {toast && (
        <div className="toast-message" role="status" aria-live="polite">
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
        {(
          [
            { id: "dashboard", label: "總覽", icon: LayoutDashboard },
            { id: "indicators", label: "指標", icon: BookOpenCheck },
            { id: "audit", label: "審查", icon: ClipboardCheck },
            { id: "results", label: "結果", icon: FileBarChart2 },
          ] as const
        )
          .filter(
            (item) =>
              canView(role, item.id) &&
              (!authMode ||
                isSystemAdminProfile(profile) ||
                item.id === "results"),
          )
          .map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={page === item.id ? "active" : ""}
                aria-current={page === item.id ? "page" : undefined}
                onClick={() => setPage(item.id)}
              >
                <Icon size={19} />
                <span>{item.label}</span>
              </button>
            );
          })}
        <button onClick={() => setMobileOpen(true)} aria-label="開啟完整選單">
          <Menu size={19} />
          <span>更多</span>
        </button>
      </nav>
    </div>
  );
}
