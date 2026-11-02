import { useMemo, useState } from "react";
import {
  CircleHelp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Filter,
  MoreHorizontal,
  Plus,
  Search,
} from "lucide-react";
import { PageHeading, RagBadge, SummaryCell } from "../components/ui";
import type { Indicator } from "../types";

export function IndicatorsPage({
  indicators,
  onAction,
}: {
  indicators: Indicator[];
  onAction: (message: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("全部狀態");
  const rows = useMemo(
    () =>
      indicators.filter(
        (item) =>
          `${item.code} ${item.name} ${item.group}`
            .toLowerCase()
            .includes(search.toLowerCase()) &&
          (filter === "全部狀態" || item.status === filter),
      ),
    [indicators, search, filter],
  );
  return (
    <>
      <PageHeading
        page="indicators"
        action={
          <button
            className="button button-primary"
            onClick={() => onAction("展示版不會建立或寫入真實指標資料")}
          >
            <Plus size={16} />
            新增指標
          </button>
        }
      />
      <div className="summary-strip">
        <SummaryCell label="啟用中指標" value="24" note="跨 5 個組別" />
        <SummaryCell label="待審核申請" value="3" note="待品管確認" />
        <SummaryCell label="本月平均達標" value="92.4%" note="較上月 +2.3%" />
        <SummaryCell label="版本即將生效" value="2" note="預計 12 月 1 日" />
      </div>
      <section className="panel data-panel">
        <div className="toolbar">
          <div className="search-box">
            <Search size={16} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜尋指標名稱、編號或組別"
            />
          </div>
          <div className="toolbar-actions">
            <div className="select-wrap toolbar-select">
              <select
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option>全部狀態</option>
                <option>啟用</option>
                <option>審核中</option>
                <option>草稿</option>
              </select>
              <ChevronDown size={14} />
            </div>
            <button
              className="button button-outline"
              onClick={() => onAction("篩選條件僅作用於本地展示資料")}
            >
              <Filter size={15} />
              更多篩選
            </button>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>指標名稱</th>
                <th>組別</th>
                <th>閾值</th>
                <th>本月結果</th>
                <th>審查進度</th>
                <th>版本</th>
                <th>狀態</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div className="indicator-title">
                      <b>{item.name}</b>
                      <span>
                        {item.code} · {item.resultLabel}
                      </span>
                    </div>
                  </td>
                  <td>{item.group}</td>
                  <td className="threshold-cell">{item.threshold}%</td>
                  <td>
                    <RagBadge
                      value={item.attainment}
                      threshold={item.threshold}
                      compact
                    />
                  </td>
                  <td>
                    <span className="table-progress-text">
                      {item.audited} / {item.planned}
                    </span>
                    <div className="mini-progress">
                      <i
                        style={{
                          width: `${Math.round((item.audited / item.planned) * 100)}%`,
                        }}
                      />
                    </div>
                  </td>
                  <td>
                    <span className="version-chip">{item.version}</span>
                  </td>
                  <td>
                    <span
                      className={`status-pill ${item.status === "啟用" ? "success" : item.status === "審核中" ? "warning" : "muted"}`}
                    >
                      {item.status}
                    </span>
                  </td>
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`查看${item.name}`}
                      onClick={() => onAction(`已開啟展示指標：${item.name}`)}
                    >
                      <MoreHorizontal size={17} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && (
          <div className="empty-state">找不到符合條件的展示指標</div>
        )}
        <div className="table-footer">
          <span>顯示 {rows.length} 筆展示指標</span>
          <div className="pagination">
            <button className="icon-button" aria-label="上一頁" disabled>
              <ChevronLeft size={16} />
            </button>
            <span className="page-num">1</span>
            <button
              className="icon-button"
              aria-label="下一頁"
              onClick={() => onAction("展示資料共一頁")}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </section>
      <div className="dashboard-footnote">
        <CircleHelp size={14} /> 10 steps
        與審核表內容為唯讀展示；指標版本如已有審查草稿或結果，正式系統須鎖定並複製新版本修改。
      </div>
    </>
  );
}
