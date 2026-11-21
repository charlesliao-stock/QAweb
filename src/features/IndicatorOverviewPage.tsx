/**
 * 指標總覽頁（v1.88.31）：
 * 一列一支指標的整合入口；點操作才進各子功能（管理／排程／審查／結果／CAPA）。
 * 清單只讀 indicators＋groups，不新增 Firestore collection；
 * 各子功能沿用現行頁面與權限／dataScope 過濾，本頁只做帶參數跳轉。
 * 年份僅為排程／審查／結果的年度上下文，不隱藏指標列（見 lib/indicatorOverview）。
 */
import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import {
  EmptyState,
  FilterPanel,
  FilterSearchField,
  FormSelect,
  LoadingState,
  PageHeading,
} from "../components/ui";
import { loadRefCollection } from "../lib/refLoad";
import { getFirebaseDb } from "../lib/firebase";
import { doc } from "../lib/db";
import { getCachedRef, SYSTEM_CONFIG_KEY } from "../lib/refCache";
import { getDocCacheFirst } from "../lib/cacheFirst";
import { yearOptionLabel } from "../lib/scheduling";
import {
  canShowOverviewAction,
  filterOverviewRows,
  overviewYearOptions,
  type OverviewAction,
  type OverviewRow,
} from "../lib/indicatorOverview";
import {
  effectiveThreshold,
  indicatorCodeOf,
  parseIndicatorDocId,
} from "../lib/indicators";
import { usePermissions } from "../lib/usePermissions";

const ACTIONS: OverviewAction[] = [
  "manage",
  "schedule",
  "audit",
  "results",
  "capa",
];

const ACTION_LABELS: Record<OverviewAction, string> = {
  manage: "管理",
  schedule: "排程",
  audit: "審查",
  results: "結果",
  capa: "CAPA",
};

export function IndicatorOverviewPage({
  onAction,
  onOpenAction,
  onCreateIndicator,
  onBatchCreateIndicator,
}: {
  onAction: (message: string) => void;
  onOpenAction: (action: OverviewAction, row: OverviewRow, year: number) => void;
  /** 總覽頁首新增指標／批次新增（指標管理無側邊欄入口後的新增進入點）。 */
  onCreateIndicator?: () => void;
  onBatchCreateIndicator?: () => void;
}) {
  const { can } = usePermissions();
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [year, setYear] = useState(() => new Date().getFullYear());
  /** 年別：與排程頁一致，鎖定系統管理「統計週期」設定（不可手動切換）。 */
  const [statsCycle, setStatsCycle] = useState<"year" | "academic">("year");
  const [groupFilter, setGroupFilter] = useState("");
  const [keyword, setKeyword] = useState("");
  const [keywordDraft, setKeywordDraft] = useState("");

  // 年別跟隨系統管理「統計週期」設定（與排程頁、結果分析頁讀同一份
  // systemParams/config；讀不到就用預設「年度」）。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snap = await getCachedRef(SYSTEM_CONFIG_KEY, () =>
          getDocCacheFirst(doc(getFirebaseDb(), "systemParams", "config")),
        );
        if (cancelled) return;
        const data = snap.data() as Record<string, unknown> | undefined;
        setStatsCycle(data?.statsCycle === "academic" ? "academic" : "year");
      } catch {
        if (!cancelled) setStatsCycle("year");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError("");
      try {
        const [iSnap, gSnap] = await Promise.all([
          loadRefCollection("indicators"),
          loadRefCollection("groups"),
        ]);
        if (cancelled) return;
        const groupName = new Map<string, string>();
        const groupList: Array<{ id: string; name: string }> = [];
        gSnap.docs.forEach((d) => {
          const name =
            typeof d.data().name === "string" && d.data().name
              ? (d.data().name as string)
              : d.id;
          groupName.set(d.id, name);
          groupList.push({ id: d.id, name });
        });
        groupList.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
        setGroups(groupList);
        const list: OverviewRow[] = iSnap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>;
          const groupId =
            typeof data.groupId === "string" ? data.groupId : "";
          return {
            id: d.id,
            code:
              parseIndicatorDocId(d.id)?.code ??
              (typeof data.code === "string" ? data.code : d.id),
            name: typeof data.name === "string" ? data.name : d.id,
            groupId,
            groupName: groupName.get(groupId) ?? "未分類",
            threshold: effectiveThreshold(data),
            status: typeof data.status === "string" ? data.status : "",
          };
        });
        list.sort(
          (a, b) =>
            a.groupName.localeCompare(b.groupName, "zh-Hant") ||
            a.code.localeCompare(b.code, "zh-Hant", { numeric: true }),
        );
        setRows(list);
      } catch {
        if (!cancelled) setLoadError("指標清單載入失敗，請確認登入狀態與資料庫連線。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(
    () => filterOverviewRows(rows, { groupId: groupFilter, keyword }),
    [rows, groupFilter, keyword],
  );

  // 頁首統計（隨篩選變動）：全部／啟用中／已停用支數。
  const stats = useMemo(
    () => ({
      total: filtered.length,
      active: filtered.filter((r) => r.status === "啟用").length,
      inactive: filtered.filter((r) => r.status === "停用").length,
    }),
    [filtered],
  );
  // 新增指標與「管理」同一權限（page.indicators），無權限不顯示按鈕。
  const canManage = canShowOverviewAction(can, "manage");

  // 狀態徽章：啟用綠、停用灰、其餘中性；空白狀態顯示 —。
  const renderStatus = (status: string) =>
    status ? (
      <span
        className={`indicator-overview-status${
          status === "啟用"
            ? " is-active"
            : status === "停用"
              ? " is-inactive"
              : ""
        }`}
      >
        {status}
      </span>
    ) : (
      "—"
    );

  // 五顆操作按鈕：桌機表格與手機卡片共用同一組（目的地與權限邏輯不變，
  // 只差外觀 class；手機版由 CSS 的 .action-* 淡彩色區分）。
  const renderActions = (row: OverviewRow) => (
    <div className="indicator-overview-actions">
      {ACTIONS.map((action) => {
        const allowed = canShowOverviewAction(can, action);
        return (
          <button
            key={action}
            type="button"
            className={`button indicator-overview-action action-${action}`}
            data-action={action}
            disabled={!allowed}
            title={allowed ? "" : "無此頁面權限，請聯絡系統管理員"}
            onClick={() => onOpenAction(action, row, year)}
          >
            {ACTION_LABELS[action]}
          </button>
        );
      })}
    </div>
  );

  return (
    <div>
      <PageHeading page="overview" />
      <FilterPanel
        actions={
          (groupFilter || keyword) && (
            <button
              type="button"
              className="button button-outline"
              onClick={() => {
                setGroupFilter("");
                setKeyword("");
                setKeywordDraft("");
              }}
            >
              清除篩選
            </button>
          )
        }
      >
        <FormSelect
          label="年份"
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
        >
          {overviewYearOptions().map((y) => (
            <option key={y} value={y}>
              {yearOptionLabel(y)}
            </option>
          ))}
        </FormSelect>
        <FormSelect
          label="年別"
          value={statsCycle}
          disabled
          title="年別跟隨系統管理「統計週期」設定"
        >
          <option value="year">年度</option>
          <option value="academic">學年度</option>
        </FormSelect>
        <FormSelect
          label="組別"
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
        >
          <option value="">全部組別</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </FormSelect>
        <FilterSearchField
          label="指標名稱"
          placeholder="搜尋指標名稱或編號"
          value={keywordDraft}
          onChange={setKeywordDraft}
          onSearch={() => setKeyword(keywordDraft)}
        />
        {canManage && (
          <div className="filter-panel-end">
            <button
              type="button"
              className="button button-primary"
              onClick={() => onCreateIndicator?.()}
            >
              <Plus size={16} />
              新增指標
            </button>
            <button
              type="button"
              className="button button-outline"
              onClick={() => onBatchCreateIndicator?.()}
            >
              <Plus size={16} />
              批次新增
            </button>
          </div>
        )}
      </FilterPanel>
      <div
        className="indicator-overview-stats"
        aria-label="指標統計"
      >
        <div className="indicator-overview-stat">
          <strong>{stats.total}</strong>
          <span>全部指標</span>
        </div>
        <div className="indicator-overview-stat is-active">
          <strong>{stats.active}</strong>
          <span>啟用中</span>
        </div>
        <div className="indicator-overview-stat is-inactive">
          <strong>{stats.inactive}</strong>
          <span>已停用</span>
        </div>
        <p className="indicator-overview-stats-note">
          年份與年別僅作為排程、審查與結果分析的年度上下文，不會隱藏任何指標；年別跟隨系統管理「統計週期」設定。
        </p>
      </div>
      {loading ? (
        <LoadingState label="指標清單載入中…" />
      ) : loadError ? (
        <section className="panel">
          <p className="settings-note" role="alert">
            {loadError}
          </p>
          <button
            type="button"
            className="button button-outline"
            onClick={() => onAction("請重新整理頁面再試一次")}
          >
            重新整理頁面
          </button>
        </section>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="沒有符合篩選條件的指標"
          description="請調整組別或關鍵字，或清除篩選。"
        />
      ) : (
        <>
          {/* 桌機版：現行表格不變（寬度 ≥768px 顯示，見 CSS）。 */}
          <div className="table-scroll indicator-overview-table">
            <table className="data-table">
              <thead>
                <tr>
                  <th>品管組</th>
                  <th>指標編號</th>
                  <th>指標名稱</th>
                  <th>閾值</th>
                  <th>狀態</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={row.id}>
                    <td>{row.groupName}</td>
                    <td className="indicator-overview-code">
                      {indicatorCodeOf(row.id)}
                    </td>
                    <td className="indicator-overview-name">{row.name}</td>
                    <td className="indicator-overview-threshold">
                      {row.threshold}%
                    </td>
                    <td>{renderStatus(row.status)}</td>
                    <td>{renderActions(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* 手機版（寬度 <768px）：一支指標一張卡片、三行。
              第 1 行指標名稱、第 2 行基本資料、第 3 行淡彩操作按鈕。 */}
          <div className="indicator-overview-cards">
            {filtered.map((row) => (
              <article className="indicator-overview-card" key={row.id}>
                <h3 className="indicator-overview-card-name">{row.name}</h3>
                <dl className="indicator-overview-card-meta">
                  <div>
                    <dt>品管組別</dt>
                    <dd title={row.groupName}>{row.groupName}</dd>
                  </div>
                  <div>
                    <dt>指標編號</dt>
                    <dd title={indicatorCodeOf(row.id)}>
                      {indicatorCodeOf(row.id)}
                    </dd>
                  </div>
                  <div>
                    <dt>閾值</dt>
                    <dd className="indicator-overview-threshold">
                      {row.threshold}%
                    </dd>
                  </div>
                  <div>
                    <dt>狀態</dt>
                    <dd>{renderStatus(row.status)}</dd>
                  </div>
                </dl>
                {renderActions(row)}
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
