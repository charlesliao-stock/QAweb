/**
 * 儀表板（v1.88.35 四群設定；取代 7 版變體）。
 * 四群：(1)委員會各角色、部級各職稱；(2)品管組召集人、執行幹事、組長；
 * 單位護理長／副護理長；(3)品管組審查員；(4)護理師。
 * 各群只顯示定案項目＋系統公告；舊版專屬區塊（48h 通報、轄區進度表、
 * 組別達標率、雷達／紅旗等）已從儀表板拿掉，那些是純資訊顯示，底層資料
 * 仍可在品管審查／結果分析查到。注意：解鎖核准／駁回的唯一 UI 原本在
 * OfficerTab（儀表板），本次刪除後目前無入口（useDashboardData 仍載入
 * unlockPending 備用）；去處待用戶定案（建議排程頁或品管審查頁）。
 * CAPA 待審核卡只是快捷入口，審核流程本身在 CAPA 頁完整保留。
 * 舊「匯出摘要」鈕本就是佔位（點了只提示尚未串接），拿掉無功能損失。
 * 顯示設定舊旗標（dashboardSections）不再使用：管理頁「儀表板顯示」
 * 頁籤已移除，旗標鍵保留在 lib 內僅供相容，不再影響畫面。
 */
import { useEffect, useMemo, useState } from "react";
import { Eye } from "lucide-react";
import { PageHeading } from "../components/ui";
import { maskName } from "../lib/mask";
import { useAuth } from "../lib/auth";
import { useOrgMeta } from "../lib/useOrgMeta";
import { getFirebaseDb } from "../lib/firebase";
import { doc } from "../lib/db";
import { getCachedRef, SYSTEM_CONFIG_KEY } from "../lib/refCache";
import { getDocCacheFirst } from "../lib/cacheFirst";
import {
  dashboardGroupFor,
  dashboardGroupScope,
  DASHBOARD_GROUP_LABELS,
  DASHBOARD_GROUP_TITLES,
  type DashboardGroup,
} from "../lib/dashboardGroups";
import { useDashboardData } from "./dashboard/useDashboardData";
import { AnnouncementsSection } from "./dashboard/AnnouncementsSection";
import { Group1Tab } from "./dashboard/Group1Tab";
import { Group2Tab } from "./dashboard/Group2Tab";
import { Group3Tab } from "./dashboard/Group3Tab";
import { Group4Tab } from "./dashboard/Group4Tab";
import {
  ReviewExecutePage,
  type ExecuteTarget,
} from "./ReviewExecutePage";
import type { StatsCycle } from "../lib/resultAnalysis";

const GROUP_ORDER: DashboardGroup[] = ["g1", "g2", "g3", "g4"];

export function DashboardPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  const { user } = useAuth();
  const data = useDashboardData();
  const orgMeta = useOrgMeta();
  const [executing, setExecuting] = useState<ExecuteTarget | null>(null);
  /** 統計週期（systemParams/config.statsCycle；缺值預設 year） */
  const [statsCycle, setStatsCycle] = useState<StatsCycle>("year");
  const [previewGroup, setPreviewGroup] = useState<DashboardGroup | "">("");
  const isAdmin = (user?.roles ?? []).includes("系統管理員");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snap = await getCachedRef(SYSTEM_CONFIG_KEY, () =>
          getDocCacheFirst(doc(getFirebaseDb(), "systemParams", "config")),
        );
        if (cancelled) return;
        const config = snap.data() as Record<string, unknown> | undefined;
        setStatsCycle(config?.statsCycle === "academic" ? "academic" : "year");
      } catch {
        if (!cancelled) setStatsCycle("year");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const roleLevelIdByName = useMemo(
    () =>
      new Map(orgMeta.roleTargets.map((t) => [t.name, t.levelId] as const)),
    [orgMeta.roleTargets],
  );
  const roleLevelNameById = useMemo(
    () =>
      new Map(orgMeta.roleLevels.map((l) => [l.id, l.name] as const)),
    [orgMeta.roleLevels],
  );

  const ownGroup = useMemo(
    () =>
      dashboardGroupFor(
        {
          roles: user?.roles ?? [],
          title: user?.title ?? "",
          titleId: user?.titleId,
          isAdmin,
          roleMeta: orgMeta.roleMeta,
          titleMeta: orgMeta.titleMeta,
          titleMetaById: orgMeta.titleMetaById,
          roleLevelIdByName,
          roleLevelNameById,
        },
      ),
    [user, isAdmin, orgMeta, roleLevelIdByName, roleLevelNameById],
  );

  const active: DashboardGroup =
    isAdmin && previewGroup ? previewGroup : ownGroup;
  const scope = useMemo(
    () =>
      dashboardGroupScope(
        active,
        {
          title: user?.title ?? "",
          titleId: user?.titleId,
          titleUnitCodes: user?.titleUnitCodes ?? [],
          unitCode: user?.unitCode ?? "",
        },
        { titleMeta: orgMeta.titleMeta, titleMetaById: orgMeta.titleMetaById },
      ),
    [active, user, orgMeta.titleMeta, orgMeta.titleMetaById],
  );

  useEffect(() => {
    if (!isAdmin && previewGroup) setPreviewGroup("");
  }, [isAdmin, previewGroup]);

  // 審查表單／查詢執行中 → 顯示執行頁（返回時重讀資料）
  if (executing) {
    return (
      <ReviewExecutePage
        target={executing}
        onBack={() => {
          setExecuting(null);
          data.reload();
        }}
        onAction={onAction}
      />
    );
  }

  const scopeNote =
    scope.kind === "all"
      ? "範圍：全院"
      : scope.kind === "units"
        ? `範圍：負責轄區（${scope.unitCodes.length} 個單位）`
        : "範圍：自己單位";
  const welcomeText = isAdmin
    ? previewGroup
      ? `目前預覽「${DASHBOARD_GROUP_LABELS[previewGroup]}」版面；實際資料與權限仍依系統管理員登入身分。`
      : "目前為系統管理者視角（第 1 群）；您可預覽其他群的儀表板呈現。"
    : `以下為您所屬${DASHBOARD_GROUP_LABELS[active]}的儀表板；頁面與資料權限仍依系統實際授權。`;

  return (
    <div className="dashboard-page" data-dashboard-group={active}>
      <PageHeading page="dashboard" />
      <div className="dashboard-welcome">
        <div>
          <span className="welcome-kicker">QUALITY SNAPSHOT</span>
          <h2>{DASHBOARD_GROUP_TITLES[active]}</h2>
          <p>
            {user?.name ? `${maskName(user.name)}，` : ""}
            {welcomeText} {scopeNote}
          </p>
        </div>
        <div className="welcome-art" aria-hidden="true">
          <div className="art-ring ring-one" />
          <div className="art-ring ring-two" />
          <div className="art-cross">
            <span />
            <i />
          </div>
          <div className="art-dot dot-a" />
          <div className="art-dot dot-b" />
          <div className="art-dot dot-c" />
        </div>
      </div>

      {isAdmin && (
        <section className="dashboard-preview-bar" aria-label="系統管理者儀表板預覽">
          <div className="dashboard-preview-copy">
            <span className="dashboard-preview-kicker"><Eye size={14} />系統管理者專用</span>
            <strong>群組畫面預覽</strong>
            <p>僅預覽版面與顯示項目，不會切換登入身分、資料範圍或頁面權限。</p>
          </div>
          <div className="dashboard-preview-controls">
            <label>
              <span className="sr-only">選擇要預覽的群組</span>
              <select
                value={previewGroup}
                onChange={(event) =>
                  setPreviewGroup(event.target.value as DashboardGroup | "")
                }
                aria-label="選擇要預覽的群組"
              >
                <option value="">系統管理者視角（第 1 群）</option>
                {GROUP_ORDER.map((g) => (
                  <option key={g} value={g}>
                    預覽{DASHBOARD_GROUP_LABELS[g]} · {DASHBOARD_GROUP_TITLES[g]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>
      )}

      {data.loading ? (
        <p className="settings-note">讀取儀表板資料中…</p>
      ) : (
        <>
          {data.correctionSkipped && (
            <p className="settings-note" style={{ color: "#b3372f", fontWeight: 600 }}>
              逾期任務自動校正暫時無法執行（索引建立中），請稍後重新整理；其他內容不受影響。
            </p>
          )}
          {data.correctionFailed && (
            <p className="settings-note" style={{ color: "#b3372f", fontWeight: 600 }}>
              部分任務狀態自動校正寫入失敗，下次載入會再試；若持續出現請通知系統管理員。
            </p>
          )}
          <AnnouncementsSection group={active} />
          {active === "g1" && <Group1Tab data={data} scope={scope} />}
          {active === "g2" && (
            <Group2Tab data={data} unitCode={user?.unitCode ?? ""} />
          )}
          {active === "g3" && (
            <Group3Tab
              data={data}
              staffId={user?.staffId ?? ""}
              onExecute={setExecuting}
            />
          )}
          {active === "g4" && (
            <Group4Tab
              data={data}
              staffId={user?.staffId ?? ""}
              unitCode={user?.unitCode ?? ""}
              cycle={statsCycle}
            />
          )}
        </>
      )}
    </div>
  );
}
