/**
 * 指標總覽頁（v1.88.31）：
 * 一列一支指標的整合入口；點操作才進各子功能（管理／排程／審查／結果／CAPA）。
 * 清單只讀 indicators＋groups，不新增 Firestore collection；
 * 各子功能沿用現行頁面與權限／dataScope 過濾，本頁只做帶參數跳轉。
 * 年份僅為排程／審查／結果的年度上下文，不隱藏指標列（見 lib/indicatorOverview）。
 */
import { useEffect, useMemo, useState } from "react";
import {
  EmptyState,
  FilterPanel,
  FilterSearchField,
  FormSelect,
  LoadingState,
  PageHeading,
} from "../components/ui";
import { loadRefCollection } from "../lib/refLoad";
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
}: {
  onAction: (message: string) => void;
  onOpenAction: (action: OverviewAction, row: OverviewRow, year: number) => void;
}) {
  const { can } = usePermissions();
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [groupFilter, setGroupFilter] = useState("");
  const [keyword, setKeyword] = useState("");
  const [keywordDraft, setKeywordDraft] = useState("");

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
              {y} 年
            </option>
          ))}
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
      </FilterPanel>
      <p className="settings-note">
        年份僅作為排程、審查與結果分析的年度上下文，不會隱藏任何指標；共{" "}
        {filtered.length} 支指標。
      </p>
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
        <div className="table-scroll">
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
                  <td>{indicatorCodeOf(row.id)}</td>
                  <td>{row.name}</td>
                  <td>{row.threshold}%</td>
                  <td>{row.status || "—"}</td>
                  <td>
                    <div className="indicator-overview-actions">
                      {ACTIONS.map((action) => {
                        const allowed = canShowOverviewAction(can, action);
                        return (
                          <button
                            key={action}
                            type="button"
                            className="button button-outline"
                            disabled={!allowed}
                            title={
                              allowed
                                ? ""
                                : "無此頁面權限，請聯絡系統管理員"
                            }
                            onClick={() => onOpenAction(action, row, year)}
                          >
                            {ACTION_LABELS[action]}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
