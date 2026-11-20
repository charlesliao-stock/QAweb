import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Bell,
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  LockKeyhole,
  LogOut,
  User,
  X,
} from "lucide-react";
import { AuthProvider, requestActivationMail, STAFF_MAIL_DOMAIN, normalizeStaffId, staffEmail, useAuth } from "../lib/auth";
import { collection, doc, getDocs, limit, orderBy, query, serverTimestamp, updateDoc, where } from "../lib/db";
import { getFirebaseDb } from "../lib/firebase";
import { getCachedRef, SYSTEM_CONFIG_KEY } from "../lib/refCache";
import { getDocCacheFirst } from "../lib/cacheFirst";
import { clearThemeRegistry, loadThemes } from "../lib/themeRegistry";
import {
  applyTheme,
  applyUiPrefs,
  FONT_SIZE_LABELS,
  getFontSize,
  setFontSize,
  type FontSizeOption,
} from "../lib/uiPrefs";
import { BrandMark } from "../components/ui";
import { BottomNavIcon, type BottomNavIconKind } from "../components/BottomNavIcon";
import { maskName } from "../lib/mask";
import { VERSION_LABEL } from "../version";
import { pagePermissionKey } from "../lib/permissions";
import { usePermissions } from "../lib/usePermissions";
import { MAINTENANCE_EVENT } from "../lib/maintenance";
import { dualHealth, watchDualHealth } from "../lib/dual/bootstrap";
import { describeHealth } from "../lib/dual/status";
import { DashboardPage } from "../features/DashboardPage";
// v1.28 階段 6（A1）：儀表板是登入後首頁，留在首屏 chunk；其餘 7 頁懶載入，
// 切頁時才載入對應 chunk（首次切頁多一次請求，以 Suspense 顯示載入中、不空白卡住）。
// 各頁皆為 named export，lazy 需轉為 default export。
const AdminPage = lazy(() =>
  import("../features/AdminPage").then((m) => ({ default: m.AdminPage })),
);
const AuditPage = lazy(() =>
  import("../features/AuditPage").then((m) => ({ default: m.AuditPage })),
);
const CapaPage = lazy(() =>
  import("../features/CapaPage").then((m) => ({ default: m.CapaPage })),
);
const GroupsPage = lazy(() =>
  import("../features/GroupsPage").then((m) => ({ default: m.GroupsPage })),
);
const PermissionManagementPage = lazy(() =>
  import("../features/PermissionManagementPage").then((m) => ({
    default: m.PermissionManagementPage,
  })),
);
const TaskHandoffPage = lazy(() =>
  import("../features/TaskHandoffPage").then((m) => ({ default: m.TaskHandoffPage })),
);
const IndicatorsPage = lazy(() =>
  import("../features/IndicatorsPage").then((m) => ({
    default: m.IndicatorsPage,
  })),
);
const IndicatorOverviewPage = lazy(() =>
  import("../features/IndicatorOverviewPage").then((m) => ({
    default: m.IndicatorOverviewPage,
  })),
);
const ResultsPage = lazy(() =>
  import("../features/ResultsPage").then((m) => ({
    default: m.ResultsPage,
  })),
);
const SchedulePage = lazy(() =>
  import("../features/SchedulePage").then((m) => ({
    default: m.SchedulePage,
  })),
);
import type { PageId } from "../types";
import type { OverviewAction, OverviewRow } from "../lib/indicatorOverview";
import type { GroupsTab, OrgMemberTarget } from "../features/GroupsPage";
import { toErrorMessage } from "../lib/errors";

type CapaLaunchContext = {
  indicatorId?: string;
  indicatorCode?: string;
  indicatorName?: string;
  threshold?: number;
  period?: string;
  periodKeys?: string[];
  unitCode?: string;
  unitName?: string;
  rate?: number;
  summary?: string;
  caseId?: string;
  snapshots?: Array<{ period: string; rate: number }>;
};

const NAV_GROUPS = [
  {
    label: "工作台",
    items: [{ id: "dashboard", label: "總覽儀表板", kind: "dashboard" as BottomNavIconKind }],
  },
  {
    label: "品質管理",
    items: [
      // 指標總覽：五項功能的整合入口，放在品質管理首位；
      // 指標管理已整合進總覽（每列「管理」直達編輯頁、頁首可新增），
      // 側邊欄不再單列「指標管理」入口，頁面本身保留供總覽深連。
      { id: "overview", label: "指標總覽", kind: "overview" as BottomNavIconKind },
      { id: "schedule", label: "品管審查排程", kind: "schedule" as BottomNavIconKind },
      { id: "audit", label: "品管審查", kind: "audit" as BottomNavIconKind },
      { id: "results", label: "結果分析", kind: "results" as BottomNavIconKind },
      // v1.56.0：任務交接由組織與設定移入品質管理（只改導覽位置與所屬分區，功能與權限不動）。
      { id: "handoff", label: "任務交接", kind: "handoff" as BottomNavIconKind },
      { id: "capa", label: "CAPA 改善追蹤", kind: "capa" as BottomNavIconKind },
    ],
  },
  {
    label: "組織與設定",
    items: [
      { id: "groups", label: "品管組與人員", kind: "groups" as BottomNavIconKind },
      { id: "admin", label: "系統管理", kind: "admin" as BottomNavIconKind },
      { id: "permissions", label: "權限管理", kind: "permissions" as BottomNavIconKind },
    ],
  },
] as const;

function LoginScreen() {
  const { login, changePassword, needsPasswordChange } = useAuth();
  const [staffId, setStaffId] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // v1.83.0：開通帳號／忘記密碼（寄 Firebase 認證連結到「職編@kmuh.org.tw」）
  const [mode, setMode] = useState<"login" | "activate">("login");
  const [notice, setNotice] = useState("");
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const submitActivation = async () => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await requestActivationMail(staffId);
      setNotice(
        `若職編 ${normalizeStaffId(staffId)} 已建檔，認證連結已寄到 ${staffEmail(staffId)}，請到院內信箱點連結設定密碼（連結有時效，信件可能在垃圾郵件匣）。`,
      );
      setCooldown(60);
    } catch (err) {
      setError(toErrorMessage(err, "寄送失敗，請稍後再試"));
    } finally {
      setBusy(false);
    }
  };

  const submitLogin = async () => {
    setError("");
    setBusy(true);
    try {
      await login(staffId, password);
    } catch (err) {
      setError(toErrorMessage(err, "登入失敗"));
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
      setError(toErrorMessage(err, "密碼變更失敗"));
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
            護理品質<span>管理資訊系統</span>
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
            <div className="login-input-wrap has-toggle">
              <span className="login-input-icon" aria-hidden="true">
                <LockKeyhole size={17} />
              </span>
              <input
                id="new-password"
                className="text-input"
                type={showNewPassword ? "text" : "password"}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder="請輸入新密碼"
                autoComplete="new-password"
              />
              <button
                type="button"
                className="login-password-toggle"
                onClick={() => setShowNewPassword((v) => !v)}
                aria-label={showNewPassword ? "隱藏新密碼" : "顯示新密碼"}
                aria-pressed={showNewPassword}
              >
                {showNewPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
            <label className="field-label" htmlFor="confirm-password">
              確認新密碼
            </label>
            <div className="login-input-wrap has-toggle">
              <span className="login-input-icon" aria-hidden="true">
                <LockKeyhole size={17} />
              </span>
              <input
                id="confirm-password"
                className="text-input"
                type={showConfirmPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="請再輸入一次新密碼"
                autoComplete="new-password"
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitPasswordChange();
                }}
              />
              <button
                type="button"
                className="login-password-toggle"
                onClick={() => setShowConfirmPassword((v) => !v)}
                aria-label={showConfirmPassword ? "隱藏確認新密碼" : "顯示確認新密碼"}
                aria-pressed={showConfirmPassword}
              >
                {showConfirmPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
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
        ) : mode === "activate" ? (
          <>
            <div className="login-eyebrow">
              <span className="live-dot" /> 開通帳號／忘記密碼
            </div>
            <h1>
              以院內信箱
              <br />
              <em>設定你的密碼。</em>
            </h1>
            <p className="login-lead">
              輸入職編，系統會寄認證連結到你的院內信箱（職編去掉開頭的 0，@{STAFF_MAIL_DOMAIN}）。點信中連結設定密碼後，回到這裡用職編與新密碼登入。
            </p>
            <label className="field-label" htmlFor="activate-staff-id">
              職編
            </label>
            <div className="login-input-wrap">
              <span className="login-input-icon" aria-hidden="true">
                <User size={17} />
              </span>
              <input
                id="activate-staff-id"
                className="text-input"
                value={staffId}
                onChange={(event) => setStaffId(event.target.value)}
                placeholder={`請輸入職編（不需輸入 @${STAFF_MAIL_DOMAIN}）`}
                autoComplete="username"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && cooldown <= 0) void submitActivation();
                }}
              />
            </div>
            {notice && <div className="login-demo-hint">{notice}</div>}
            {error && <div className="login-error">{error}</div>}
            <button
              className="button button-primary login-action"
              onClick={() => void submitActivation()}
              disabled={busy || cooldown > 0}
            >
              {busy ? "寄送中…" : cooldown > 0 ? `${cooldown} 秒後可重寄` : "寄送認證連結"}
              <ArrowRight size={17} />
            </button>
            <div className="login-foot">
              <button
                className="button button-ghost"
                onClick={() => {
                  setMode("login");
                  setError("");
                  setNotice("");
                }}
              >
                返回登入
              </button>
            </div>
            <div className="login-version">{VERSION_LABEL}</div>
          </>
        ) : (
          <>
            <div className="login-eyebrow">
              <span className="live-dot" /> 護理品質管理資訊
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
            <div className="login-input-wrap">
              <span className="login-input-icon" aria-hidden="true">
                <User size={17} />
              </span>
              <input
                id="staff-id"
                className="text-input"
                value={staffId}
                onChange={(event) => setStaffId(event.target.value)}
                placeholder="請輸入職編"
                autoComplete="username"
              />
            </div>
            <label className="field-label" htmlFor="password">
              密碼
            </label>
            <div className="login-input-wrap has-toggle">
              <span className="login-input-icon" aria-hidden="true">
                <LockKeyhole size={17} />
              </span>
              <input
                id="password"
                className="text-input"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="請輸入密碼"
                autoComplete="current-password"
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitLogin();
                }}
              />
              <button
                type="button"
                className="login-password-toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "隱藏密碼" : "顯示密碼"}
                aria-pressed={showPassword}
              >
                {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
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
            <div className="login-links">
              <button
                type="button"
                className="button button-outline login-link-btn"
                onClick={() => {
                  setMode("activate");
                  setError("");
                }}
              >
                開通帳號
              </button>
              <button
                type="button"
                className="button button-outline login-link-btn"
                onClick={() => {
                  setMode("activate");
                  setError("");
                }}
              >
                忘記密碼
              </button>
            </div>
            <div className="login-demo-hint">
              展示帳號：demo／demo（展示模式，操作不會寫入資料庫）
            </div>
          </>
        )}
      </section>
      <aside className="login-side-copy">
        <span>護理品質管理資訊</span>
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
  canViewPage,
  onPage,
  onExit,
  mobileOpen,
  onClose,
}: {
  page: PageId;
  canViewPage: (page: PageId) => boolean;
  onPage: (page: PageId) => void;
  onExit: () => void;
  mobileOpen: boolean;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const displayName = user?.name ?? "";
  const staffId = user?.staffId ?? "";
  const unitName = user?.unitName || user?.unitCode || "";
  const [fontSize, setFontSizeChoice] = useState<FontSizeOption>(() => getFontSize());
  const [notifications, setNotifications] = useState<{
    id: string; title: string; message: string; read: boolean; createdAt: unknown;
  }[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  async function toggleNotifications() {
    const opening = !notificationsOpen;
    setNotificationsOpen(opening);
    if (!opening || !staffId) return;
    setNotificationsLoading(true);
    try {
      const snapshot = await getDocs(
        query(
          collection(getFirebaseDb(), "notifications"),
          where("userId", "==", staffId),
          orderBy("createdAt", "desc"),
          limit(20),
        ),
      );
      setNotifications(snapshot.docs.map((item) => {
        const data = item.data() as Record<string, unknown>;
        return {
          id: item.id,
          title: typeof data.title === "string" ? data.title : "系統通知",
          message: typeof data.message === "string" ? data.message : "",
          read: data.read === true,
          createdAt: data.createdAt,
        };
      }));
    } catch {
      setNotifications([]);
    } finally {
      setNotificationsLoading(false);
    }
  }
  async function markNotificationRead(id: string) {
    try {
      await updateDoc(doc(getFirebaseDb(), "notifications", id), {
        read: true,
        readAt: serverTimestamp(),
      });
      setNotifications((items) => items.map((item) => item.id === id ? { ...item, read: true } : item));
    } catch {
      // 若規則或網路拒絕更新，保留未讀狀態供稍後重試。
    }
  }
  const unreadNotifications = notifications.filter((item) => !item.read).length;
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
            <span>管理資訊系統</span>
          </div>
          <button
            className="sidebar-close"
            onClick={onClose}
            aria-label="關閉選單"
          >
            <X size={18} />
          </button>
        </div>
        <div className="sidebar-notifications">
          <button
            className="notification-trigger"
            type="button"
            aria-label={`系統通知，${unreadNotifications} 則未讀`}
            aria-expanded={notificationsOpen}
            onClick={() => void toggleNotifications()}
          >
            <Bell size={17} />
            <span>系統通知</span>
            {unreadNotifications > 0 && <b className="notification-count">{unreadNotifications}</b>}
          </button>
          {notificationsOpen && (
            <div className="notification-popover" role="region" aria-label="系統通知清單">
              <div className="notification-popover-title">最近通知</div>
              {notificationsLoading ? (
                <p className="settings-note">載入中…</p>
              ) : notifications.length === 0 ? (
                <p className="settings-note">目前沒有通知。</p>
              ) : notifications.map((item) => (
                <article className={`notification-item${item.read ? " read" : " unread"}`} key={item.id}>
                  <b>{item.title}</b>
                  <p>{item.message}</p>
                  {!item.read && (
                    <button type="button" className="notification-mark-read" onClick={() => void markNotificationRead(item.id)}>
                      標記已讀
                    </button>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
        <nav className="main-nav" aria-label="主要導覽">
          {NAV_GROUPS.map((group) => {
            const visibleItems = group.items.filter((item) =>
              canViewPage(item.id as PageId),
            );
            if (visibleItems.length === 0) return null;
            return (
              <div className="nav-group" key={group.label}>
                <span className="nav-group-label">{group.label}</span>
                {visibleItems.map((item) => {
                  return (
                    <button
                      key={item.id}
                      className={`nav-item${page === item.id ? " active" : ""}`}
                      onClick={() => {
                        onPage(item.id as PageId);
                        onClose();
                      }}
                    >
                      <BottomNavIcon kind={item.kind} size={20} active={page === item.id} />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-font-settings">
            <span>文字大小</span>
            <div className="font-size-options" role="group" aria-label="文字大小">
              {(["standard", "large", "xlarge"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={fontSize === option ? "selected" : ""}
                  aria-pressed={fontSize === option}
                  onClick={() => {
                    setFontSize(option);
                    setFontSizeChoice(option);
                  }}
                  title={`${FONT_SIZE_LABELS[option]}文字`}
                >
                  {FONT_SIZE_LABELS[option]}
                </button>
              ))}
            </div>
          </div>
          <div className="profile-row">
            <div className="profile-avatar">
              {displayName.slice(0, 1) || "使"}
            </div>
            <div className="profile-info">
              <b>{maskName(displayName)}</b>
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
  const { can, ready: permissionsReady } = usePermissions();
  const [page, setPage] = useState<PageId>("dashboard");
  // v1.86.0：人員管理頁籤（獨立頁返回時回到原本頁籤）＋成員／單位管理獨立頁目標
  const [groupsTab, setGroupsTab] = useState<GroupsTab>("groups");
  const [memberTarget, setMemberTarget] = useState<OrgMemberTarget | null>(null);
  const memberPageId: PageId | null = memberTarget
    ? memberTarget.kind === "role"
      ? "role-members"
      : memberTarget.kind === "title"
        ? "title-members"
        : memberTarget.kind === "group"
          ? "group-units"
          : memberTarget.kind === "title-units"
            ? "title-units"
            : "unit-members"
    : null;
  const openMemberPage = useCallback((target: OrgMemberTarget) => {
    setMemberTarget(target);
    setPage(
      target.kind === "role"
        ? "role-members"
        : target.kind === "title"
          ? "title-members"
          : target.kind === "group"
            ? "group-units"
            : target.kind === "title-units"
              ? "title-units"
              : "unit-members",
    );
  }, []);
  const closeMemberPage = useCallback(() => {
    setMemberTarget(null);
    setPage("groups");
  }, []);
  // v1.87.0：成員管理下層頁（職稱下層／督導單位）的返回先回上層，沒有上層才回人員管理
  const handleMemberBack = useCallback(() => {
    if (memberTarget?.parent) {
      openMemberPage(memberTarget.parent);
      return;
    }
    closeMemberPage();
  }, [memberTarget, openMemberPage, closeMemberPage]);
  // 獨立頁是「品管組與人員」的子頁：側邊欄／手機導覽仍標示品管組與人員為使用中
  const navPage: PageId =
    memberPageId && page === memberPageId ? "groups" : page;
  const [capaLaunch, setCapaLaunch] = useState<CapaLaunchContext | null>(null);
  const clearCapaLaunch = useCallback(() => setCapaLaunch(null), []);
  // 指標總覽帶入的各頁 initial 參數（切頁時帶入，離開該頁即清除；
  // 直接由導覽進各頁時為 null，各頁行為與現行完全相同）。
  const [indicatorEdit, setIndicatorEdit] = useState<{ id: string; nonce: number } | null>(null);
  // 從總覽新增指標／批次新增：掛載時直接進建立表單／批次彈窗（指標管理
  // 無側邊欄入口後的新增進入點；離開該頁即清除，返回目的地為總覽）。
  const [indicatorCreate, setIndicatorCreate] = useState<{ nonce: number } | null>(null);
  const [indicatorBatch, setIndicatorBatch] = useState<{ nonce: number } | null>(null);
  const [scheduleLaunch, setScheduleLaunch] = useState<{ indicatorId: string; year: number; nonce: number } | null>(null);
  const [auditLaunch, setAuditLaunch] = useState<{ indicatorId: string; nonce: number } | null>(null);
  const [resultsLaunch, setResultsLaunch] = useState<{ indicatorId: string; nonce: number } | null>(null);
  const [capaFilterLaunch, setCapaFilterLaunch] = useState<{ indicatorId: string; nonce: number } | null>(null);
  const clearLaunches = useCallback(() => {
    setIndicatorEdit(null);
    setIndicatorCreate(null);
    setIndicatorBatch(null);
    setScheduleLaunch(null);
    setAuditLaunch(null);
    setResultsLaunch(null);
    setCapaFilterLaunch(null);
  }, []);
  // 一般導覽切頁：先清掉總覽帶入參數，避免下次直接進頁時殘留上次的指標。
  const goPage = useCallback((target: PageId) => {
    clearLaunches();
    setPage(target);
  }, [clearLaunches]);
  // 手機版底部導覽「更多」選單開關（v1.88.35；桌機維持側邊欄）
  const [moreOpen, setMoreOpen] = useState(false);
  // MORE_PAGE_IDS 只決定「更多」鈕在使用中頁面時是否亮起；"indicators"
  // 雖不在更多選單內，但由總覽深連進指標頁時仍要亮起，故保留。
  const MORE_PAGE_IDS: PageId[] = ["indicators", "schedule", "capa", "handoff", "groups", "admin", "permissions"];
  // 從總覽進指標編輯頁的返回：清掉帶入參數、回到指標總覽
  // （不經指標管理清單；指標頁內部以 fromOverview 決定返回目的地）。
  const backToOverview = useCallback(() => {
    clearLaunches();
    setPage("overview");
  }, [clearLaunches]);
  // 指標總覽五個操作：帶參數切頁（key 換 nonce 強制重新掛載，initial 才會重新生效）。
  const openOverviewAction = useCallback((action: OverviewAction, row: OverviewRow, year: number) => {
    const nonce = Date.now();
    if (action === "manage") {
      setIndicatorEdit({ id: row.id, nonce });
      setPage("indicators");
    } else if (action === "schedule") {
      setScheduleLaunch({ indicatorId: row.id, year, nonce });
      setPage("schedule");
    } else if (action === "audit") {
      setAuditLaunch({ indicatorId: row.id, nonce });
      setPage("audit");
    } else if (action === "results") {
      // v1.88.33：總覽「結果」不再帶入該年全年，改由結果分析預設起迄（Q5 系統設定）。
      setResultsLaunch({ indicatorId: row.id, nonce });
      setPage("results");
    } else {
      setCapaFilterLaunch({ indicatorId: row.id, nonce });
      setPage("capa");
    }
  }, []);
  // 總覽頁首新增指標／批次新增：進指標頁的建立表單／批次彈窗。
  const openIndicatorCreate = useCallback(() => {
    setIndicatorCreate({ nonce: Date.now() });
    setPage("indicators");
  }, []);
  const openIndicatorBatch = useCallback(() => {
    setIndicatorBatch({ nonce: Date.now() });
    setPage("indicators");
  }, []);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 760px)").matches,
  );
  const [toast, setToast] = useState("");
  // 2026-11-19 小螢幕提示：寬度未滿 768px 時出現、可關閉、不擋操作。
  // 門檻理由：768px 是平板直向寬度（iPad mini 直向），低於它即手機直向；
  // 站內手機版規則集中在 ≤720／760px，資料表最小寬 720px，低於 768 的螢幕
  // 看表格一定得左右滑動。建議 1100px 以上：側邊欄 248px＋表格最小寬 780px
  // ＋頁面內距，約 1100px 起才不用左右滑動（與舊 1100px 版面斷點一致）。
  // 關閉後記在 localStorage，不再重複打擾；提示而已，絕不鎖住手機使用。
  const [isSmallScreen, setIsSmallScreen] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767px)").matches,
  );
  const [smallScreenHintDismissed, setSmallScreenHintDismissed] = useState(
    () => {
      try {
        return window.localStorage.getItem("qaweb:small-screen-hint-dismissed:v1") === "1";
      } catch {
        return false;
      }
    },
  );
  const dismissSmallScreenHint = useCallback(() => {
    setSmallScreenHintDismissed(true);
    try {
      window.localStorage.setItem("qaweb:small-screen-hint-dismissed:v1", "1");
    } catch {
      /* 無痕模式等寫入失敗時不阻擋關閉 */
    }
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setIsSmallScreen(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  // v1.41.0 流量控管：攔截到維護中阻擋時，db.ts 會發出事件，這裡顯示橫幅
  const [maintenanceBanner, setMaintenanceBanner] = useState("");
  // 雙寫模式：主資料庫失聯、改由備援服務時，所有人都看得到提示（平常不顯示）
  const [dbBanner, setDbBanner] = useState("");
  useEffect(() => {
    const check = (): void => {
      const h = dualHealth();
      setDbBanner(h && h.mode === "failover" ? describeHealth(h).text : "");
    };
    check();
    return watchDualHealth(check);
  }, []);
  useEffect(() => {
    const handler = (event: Event) => {
      setCapaLaunch((event as CustomEvent<CapaLaunchContext>).detail ?? {});
      setPage("capa");
    };
    window.addEventListener("capa:open", handler);
    return () => window.removeEventListener("capa:open", handler);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason ?? "";
      setMaintenanceBanner(
        reason && reason.length > 0 ? `系統維護中：${reason}` : "系統維護中，暫時無法存取資料。",
      );
    };
    window.addEventListener(MAINTENANCE_EVENT, handler);
    return () => window.removeEventListener(MAINTENANCE_EVENT, handler);
  }, []);
  const canViewPage = useCallback(
    (target: PageId) => {
      // 指標總覽無獨立權限鍵：五項功能任一有權限即可見入口；
      // 列內各操作按鈕再依各自 page 權限顯示／停用。
      if (target === "overview") {
        return (
          ["page.indicators", "page.schedule", "page.audit", "page.results", "page.capa"] as const
        ).some((key) => can(key));
      }
      const key = pagePermissionKey(target);
      return Boolean(key && can(key));
    },
    [can],
  );

  useEffect(() => {
    if (!permissionsReady || canViewPage(page)) return;
    const pageIds: PageId[] = [];
    NAV_GROUPS.forEach((group) => group.items.forEach((item) => pageIds.push(item.id as PageId)));
    const firstAccessible = pageIds.find((target) => canViewPage(target));
    if (firstAccessible) setPage(firstAccessible);
  }, [canViewPage, page, permissionsReady]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // v1.27.2：notify 必須是穩定引用。若每次渲染都產生新函式，各頁以 onAction 為依賴的
  // 載入 effect 會在 toast 顯示／消失（2 次重渲染）時整頁重拉 Firestore。
  const toastTimer = useRef<number | undefined>(undefined);
  const notify = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2600);
  }, []);

  // 個人顯示設定（本機）＋ 全院主題配色（系統參數）
  // v1.32.0：主題改資料驅動，config 與 uiThemes 並行讀取後再套用；
  // loadThemes 失敗時回內建常數，applyTheme 仍有 fallback，不擋登入。
  useEffect(() => {
    applyUiPrefs();
    // 登入前失敗時 registry 會被內建常數佔住；登入後清掉才會重讀 uiThemes
    if (user) clearThemeRegistry();
    Promise.all([
      getCachedRef(SYSTEM_CONFIG_KEY, () =>
        getDocCacheFirst(doc(getFirebaseDb(), "systemParams", "config")),
      ),
      loadThemes(),
    ])
      .then(([snap]) => {
        const t = snap.exists()
          ? (snap.data() as { uiTheme?: unknown }).uiTheme
          : undefined;
        applyTheme(typeof t === "string" ? t : "green-2");
      })
      .catch(() => applyTheme("green-2"));
    // 登入狀態改變時必須重讀：雙寫模式不走本機快取，登入前讀 systemParams 會被
    // 權限擋下而落到 green-2，若不重套，全院主題設定登入後永遠不生效。
  }, [user?.staffId]);

  if (loading) {
    return (
      <main className="login-screen">
        <div className="login-backdrop" />
        <section className="login-card">
          <div className="login-brand">
            <BrandMark />
            <span>
              護理品質<span>管理資訊系統</span>
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
    <div className={`app-shell${sidebarHidden ? " sidebar-hidden" : ""}`}>
      <Sidebar
        page={navPage}
        canViewPage={canViewPage}
        onPage={goPage}
        onExit={() => void logout()}
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
      />
      <button
        className={`sidebar-handle icon-button${
          isMobile && mobileOpen ? " mobile-open" : ""
        }`}
        type="button"
        aria-label={
          isMobile
            ? mobileOpen
              ? "收合側邊功能表"
              : "開啟側邊功能表"
            : sidebarHidden
              ? "開啟側邊功能表"
              : "收合側邊功能表"
        }
        title={
          isMobile
            ? mobileOpen
              ? "收合側邊功能表"
              : "開啟側邊功能表"
            : sidebarHidden
              ? "開啟側邊功能表"
              : "收合側邊功能表"
        }
        onClick={() => {
          if (isMobile) setMobileOpen((open) => !open);
          else setSidebarHidden((hidden) => !hidden);
        }}
      >
        {(isMobile ? mobileOpen : !sidebarHidden) ? (
          <ChevronLeft size={18} />
        ) : (
          <ChevronRight size={18} />
        )}
      </button>
      <main className="main-area">
        {dbBanner && (
          <div className="maintenance-banner" role="alert">
            <span>{dbBanner}</span>
          </div>
        )}
        {maintenanceBanner && (
          <div className="maintenance-banner" role="alert">
            <span>{maintenanceBanner}</span>
            <button
              type="button"
              onClick={() => setMaintenanceBanner("")}
              aria-label="關閉維護提示"
            >
              <X size={14} />
            </button>
          </div>
        )}
        {isSmallScreen && !smallScreenHintDismissed && (
          <div className="maintenance-banner" role="status">
            <span>目前使用小螢幕（寬度未滿 768px）瀏覽，表格需左右滑動查看；建議改用平板橫放或電腦（寬度 1100px 以上），畫面最完整。</span>
            <button
              type="button"
              onClick={dismissSmallScreenHint}
              aria-label="關閉小螢幕提示"
            >
              <X size={14} />
            </button>
          </div>
        )}
        <div className="page-content">
          <Suspense
            fallback={<p className="settings-note">頁面載入中…</p>}
          >
            {!canViewPage(page) ? (
              <section className="panel"><p className="settings-note">此帳號尚未取得此頁面權限，請聯絡系統管理員。</p></section>
            ) : (
              <>
                {page === "dashboard" && <DashboardPage onAction={notify} />}
                {page === "overview" && (
                  <IndicatorOverviewPage
                    onAction={notify}
                    onOpenAction={openOverviewAction}
                    onCreateIndicator={openIndicatorCreate}
                    onBatchCreateIndicator={openIndicatorBatch}
                  />
                )}
                {page === "indicators" && (
                  <IndicatorsPage
                    key={
                      indicatorCreate
                        ? `ind-create-${indicatorCreate.nonce}`
                        : indicatorBatch
                          ? `ind-batch-${indicatorBatch.nonce}`
                          : indicatorEdit
                            ? `ind-edit-${indicatorEdit.nonce}`
                            : "ind-list"
                    }
                    onAction={notify}
                    initialEditId={indicatorEdit?.id}
                    initialCreate={Boolean(indicatorCreate)}
                    initialBatch={Boolean(indicatorBatch)}
                    fromOverview={Boolean(indicatorEdit || indicatorCreate || indicatorBatch)}
                    onBackToOverview={backToOverview}
                  />
                )}
                {page === "schedule" && (
                  <SchedulePage
                    key={scheduleLaunch ? `sched-${scheduleLaunch.nonce}` : "sched"}
                    onAction={notify}
                    initial={scheduleLaunch ? { indicatorId: scheduleLaunch.indicatorId, year: scheduleLaunch.year } : null}
                  />
                )}
                {page === "audit" && (
                  <AuditPage
                    key={auditLaunch ? `audit-${auditLaunch.nonce}` : "audit"}
                    onAction={notify}
                    initialIndicatorId={auditLaunch?.indicatorId}
                  />
                )}
                {page === "results" && (
                  <ResultsPage
                    key={resultsLaunch ? `results-${resultsLaunch.nonce}` : "results"}
                    onAction={notify}
                    initial={resultsLaunch ? { indicatorId: resultsLaunch.indicatorId } : null}
                  />
                )}
                {page === "groups" && (
                  <GroupsPage
                    onAction={notify}
                    initialTab={groupsTab}
                    onTabChange={setGroupsTab}
                    onOpenMemberPage={openMemberPage}
                  />
                )}
                {memberTarget && memberPageId && page === memberPageId && (
                  <GroupsPage
                    // v1.87.0：成員管理下層頁跳轉時以 key 強制重新掛載，
                    // 使 managing* state 從新的 memberPage 重新帶入
                    key={`${memberPageId}:${memberTarget.id}`}
                    onAction={notify}
                    initialTab={groupsTab}
                    memberPage={memberTarget}
                    onOpenMemberPage={openMemberPage}
                    onBackToGroups={handleMemberBack}
                  />
                )}
                {page === "handoff" && <TaskHandoffPage onAction={notify} />}
                {page === "capa" && <CapaPage key={capaFilterLaunch ? `capa-${capaFilterLaunch.nonce}` : "capa"} onAction={notify} launchContext={capaLaunch} onLaunchConsumed={clearCapaLaunch} initialIndicatorId={capaFilterLaunch?.indicatorId} />}
                {page === "admin" && <AdminPage onAction={notify} />}
                {page === "permissions" && <PermissionManagementPage onAction={notify} />}
              </>
            )}
          </Suspense>
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
          { id: "dashboard", label: "首頁", kind: "dashboard" as BottomNavIconKind },
          { id: "overview", label: "總覽", kind: "overview" as BottomNavIconKind },
          { id: "audit", label: "審查", kind: "audit" as BottomNavIconKind },
          { id: "results", label: "分析", kind: "results" as BottomNavIconKind },
        ].filter((item) => canViewPage(item.id as PageId)).map((item) => {
          return (
            <button
              key={item.id}
              className={navPage === item.id ? "active" : ""}
              onClick={() => { setMoreOpen(false); goPage(item.id as PageId); }}
            >
              <BottomNavIcon kind={item.kind} size={22} active={navPage === item.id} />
              <span>{item.label}</span>
            </button>
          );
        })}
        <button
          className={moreOpen || MORE_PAGE_IDS.includes(navPage) ? "active" : ""}
          aria-expanded={moreOpen}
          aria-haspopup="true"
          onClick={() => setMoreOpen((v) => !v)}
        >
          <BottomNavIcon kind="more" size={22} active={moreOpen || MORE_PAGE_IDS.includes(navPage)} />
          <span>更多</span>
        </button>
        {moreOpen && (
          <>
            <button
              className="mobile-bottom-nav-backdrop"
              aria-label="關閉更多選單"
              onClick={() => setMoreOpen(false)}
            />
            <div className="mobile-bottom-nav-more" role="menu">
              {[
                // 「指標管理」已整合進指標總覽，更多選單不再單列入口；
                // 指標頁本身仍可由總覽深連進入（見 MORE_PAGE_IDS 註解）。
                { id: "schedule", label: "排程", kind: "schedule" as BottomNavIconKind },
                { id: "capa", label: "CAPA", kind: "capa" as BottomNavIconKind },
                { id: "handoff", label: "任務交接", kind: "handoff" as BottomNavIconKind },
                { id: "groups", label: "品管組與人員", kind: "groups" as BottomNavIconKind },
                { id: "admin", label: "系統管理", kind: "admin" as BottomNavIconKind },
                { id: "permissions", label: "權限管理", kind: "permissions" as BottomNavIconKind },
              ].filter((item) => canViewPage(item.id as PageId)).map((item) => {
                return (
                  <button
                    key={item.id}
                    role="menuitem"
                    className={navPage === item.id ? "active" : ""}
                    onClick={() => { setMoreOpen(false); goPage(item.id as PageId); }}
                  >
                    <BottomNavIcon kind={item.kind} size={19} active={navPage === item.id} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
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
