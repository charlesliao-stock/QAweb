import { useCallback, useEffect, useRef, useState } from "react";
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
  isFirebaseDemoReadEnabled,
  readDemoIndicators,
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

function Sidebar({
  page,
  role,
  onPage,
  onRole,
  onExit,
  mobileOpen,
  onClose,
}: {
  page: PageId;
  role: Role;
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
            items: group.items.filter((item) => canView(role, item.id)),
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
            <small>僅供展示，不代表實際授權</small>
          </div>
          <div className="profile-row">
            <div className="profile-avatar">示</div>
            <div className="profile-info">
              <b>示範使用者</b>
              <span>DEMO-001 · 示範單位</span>
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
  const [entered, setEntered] = useState(false);
  const [role, setRole] = useState<Role>("品管執行幹事");
  const [page, setPage] = useState<PageId>("dashboard");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [indicators, setIndicators] = useState(DEMO_INDICATORS);
  const [dataSource, setDataSource] = useState<DemoDataSource>("local");

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

  const changeRole = (next: Role) => {
    setRole(next);
    if (!canView(next, page)) {
      setPage("dashboard");
      notify(`「${next}」視角無此頁面，已回到總覽`);
    }
  };

  const view: PageId = canView(role, page) ? page : "dashboard";

  if (!entered)
    return (
      <DemoLogin
        onEnter={(selectedRole) => {
          setRole(selectedRole);
          setEntered(true);
        }}
      />
    );

  return (
    <div className="app-shell">
      <Sidebar
        page={view}
        role={role}
        onPage={setPage}
        onRole={changeRole}
        onExit={() => setEntered(false)}
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
              線上展示
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
              <span className="profile-avatar small-avatar">示</span>
              <div>
                <b>示範使用者</b>
                <small>{role}</small>
              </div>
              <ChevronDown size={14} />
            </div>
          </div>
        </header>
        <DemoBanner source={dataSource} />
        <div className="page-content">
          {view === "dashboard" && (
            <DashboardPage role={role} onAction={notify} />
          )}
          {view === "indicators" && (
            <IndicatorsPage indicators={indicators} onAction={notify} />
          )}
          {view === "schedule" && <SchedulePage onAction={notify} />}
          {view === "audit" && <AuditPage onAction={notify} />}
          {view === "results" && (
            <ResultsPage indicators={indicators} onAction={notify} />
          )}
          {view === "groups" && <GroupsPage onAction={notify} />}
          {view === "capa" && <CapaPage onAction={notify} />}
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
          .filter((item) => canView(role, item.id))
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
