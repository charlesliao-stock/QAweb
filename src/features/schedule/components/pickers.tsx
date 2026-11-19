import type { UnitLite } from "../model/types";
import { useMemo, useState, useCallback } from "react";
import { staffLabel } from "../../../lib/mask";
import { ChevronDown, Trash2 } from "lucide-react";
import { MONTH_LABELS } from "../../../lib/scheduling";
import type { TempCycleMonth } from "../../../lib/cycle";
import { pad2, fmtYm } from "../../../lib/ym";

/** 群組→單位樹（可縮放、總全選、群組全選、單位複選；v1.18） */
export function UnitTreePicker({
  units,
  groupMap,
  selected,
  onChange,
  disabled,
  unitNameOf,
}: {
  units: UnitLite[];
  groupMap: Map<string, string>;
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
  unitNameOf: (code: string) => string;
}) {
  const unitsByGroup = useMemo(() => {
    const map = new Map<string, UnitLite[]>();
    units.forEach((u) => {
      const arr = map.get(u.groupId) ?? [];
      arr.push(u);
      map.set(u.groupId, arr);
    });
    return map;
  }, [units]);
  const sel = useMemo(() => new Set(selected), [selected]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const allCodes = useMemo(
    () => [...unitsByGroup.values()].flat().map((u) => u.code),
    [unitsByGroup],
  );
  const allChecked =
    allCodes.length > 0 && allCodes.every((c) => sel.has(c));

  function toggle(code: string) {
    const next = new Set(sel);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange([...next]);
  }
  function toggleGroup(gid: string) {
    const codes = (unitsByGroup.get(gid) ?? []).map((u) => u.code);
    const next = new Set(sel);
    const groupChecked = codes.length > 0 && codes.every((c) => next.has(c));
    if (groupChecked) codes.forEach((c) => next.delete(c));
    else codes.forEach((c) => next.add(c));
    onChange([...next]);
  }
  function toggleAll() {
    const next = new Set(sel);
    if (allChecked) allCodes.forEach((c) => next.delete(c));
    else allCodes.forEach((c) => next.add(c));
    onChange([...next]);
  }
  function toggleCollapse(gid: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });
  }

  return (
    <>
      <label className="check-row" style={{ marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={allChecked}
          disabled={disabled}
          onChange={toggleAll}
        />
        <b>
          全選（已選 {sel.size}／{allCodes.length}）
        </b>
      </label>
      {[...unitsByGroup.entries()].map(([gid, list]) => {
        const codes = list.map((u) => u.code);
        const groupChecked =
          codes.length > 0 && codes.every((c) => sel.has(c));
        const isCollapsed = collapsed.has(gid);
        return (
          <div key={gid} className="unit-group-block">
            <div className="unit-group-head" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                className="text-button"
                onClick={() => toggleCollapse(gid)}
                aria-label={isCollapsed ? `展開${groupMap.get(gid) ?? gid}` : `收合${groupMap.get(gid) ?? gid}`}
              >
                {isCollapsed ? "展開 ▸" : "收合 ▾"}
              </button>
              <label className="check-row" style={{ margin: 0 }}>
                <input
                  type="checkbox"
                  checked={groupChecked}
                  disabled={disabled}
                  onChange={() => toggleGroup(gid)}
                />
                <b>
                  {groupMap.get(gid) ?? gid}（全選）
                </b>
              </label>
              <span className="muted-text">
                {codes.filter((c) => sel.has(c)).length}/{codes.length}
              </span>
            </div>
            {!isCollapsed && (
              <div className="unit-check-grid">
                {list.map((u) => (
                  <label key={u.code} className="check-row">
                    <input
                      type="checkbox"
                      checked={sel.has(u.code)}
                      disabled={disabled}
                      onChange={() => toggle(u.code)}
                    />
                    <span title={u.code}>{unitNameOf(u.code)}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * 提醒（v1.83.0）：已被指派、但尚未開通帳號的審查員。只提醒，不阻擋排程；
 * 未開通者仍可被選取與指派，但開通前無法自行登入執行審查。
 */
export function InactiveReviewerNotice({
  reviewerIds,
  inactiveIds,
  nameOf,
}: {
  reviewerIds: string[];
  inactiveIds: Set<string>;
  nameOf: (id: string) => string;
}) {
  const pending = [...new Set(reviewerIds)].filter((id) => inactiveIds.has(id));
  if (pending.length === 0) return null;
  return (
    <div className="settings-note" role="status" style={{ marginBottom: 8 }}>
      ⚠ 以下已指派的審查員尚未開通帳號，開通前無法登入執行審查：
      {pending.map((id) => staffLabel(id, nameOf(id))).join("、")}。
      請通知他們在登入頁按「開通帳號」，到「職編@kmuh.org.tw」收認證連結設定密碼。
    </div>
  );
}

/** 選取選項（群組篩選＋搜尋＋複選共用；v1.18 審查員／單位選取用） */
export interface PickerOption {
  id: string;
  label: string;
  sub: string;
  groupId: string;
}

/** 群組下拉篩選＋搜尋框＋複選清單（審查員／單位選取共用） */
export function OptionMultiPicker({
  title,
  options,
  groupMap,
  defaultGroupId,
  selected,
  onToggle,
  onToggleAll,
  disabled,
  searchPlaceholder,
}: {
  title: string;
  options: PickerOption[];
  groupMap: Map<string, string>;
  defaultGroupId?: string;
  selected: string[];
  onToggle: (id: string) => void;
  /** 提供時顯示「全選」：對目前篩選結果全選／取消全選 */
  onToggleAll?: (ids: string[], select: boolean) => void;
  disabled?: boolean;
  searchPlaceholder?: string;
}) {
  const [groupFilter, setGroupFilter] = useState(defaultGroupId ?? "");
  const [kw, setKw] = useState("");
  const sel = useMemo(() => new Set(selected), [selected]);
  const filtered = useMemo(() => {
    const q = kw.trim().toLowerCase();
    return options.filter((o) => {
      if (groupFilter && o.groupId !== groupFilter) return false;
      if (
        q &&
        !(
          o.label.toLowerCase().includes(q) ||
          o.id.toLowerCase().includes(q)
        )
      )
        return false;
      return true;
    });
  }, [options, groupFilter, kw]);
  const allSelected =
    filtered.length > 0 && filtered.every((o) => sel.has(o.id));
  return (
    <div className="form-field">
      <label className="field-label">
        {title}
        {selected.length > 0 && `：已選 ${selected.length}`}
      </label>
      <div
        style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}
      >
        <div className="select-wrap" style={{ maxWidth: 200 }}>
          <select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            disabled={disabled}
            aria-label={`${title}：組別篩選`}
          >
            <option value="">全部組別</option>
            {[...groupMap.entries()].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <ChevronDown size={15} />
        </div>
        <input
          className="text-input"
          style={{ maxWidth: 220 }}
          placeholder={searchPlaceholder ?? "搜尋名稱或代碼"}
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          disabled={disabled}
        />
      </div>
      <div
        style={{
          maxHeight: 220,
          overflow: "auto",
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          padding: 8,
        }}
      >
        {onToggleAll && filtered.length > 0 && (
          <label className="check-row" style={{ marginBottom: 6 }}>
            <input
              type="checkbox"
              checked={allSelected}
              disabled={disabled}
              onChange={() =>
                onToggleAll(
                  filtered.map((o) => o.id),
                  !allSelected,
                )
              }
            />
            <b>全選</b>
            <span className="muted-text">（目前篩選結果 {filtered.length} 項）</span>
          </label>
        )}
        {filtered.length === 0 ? (
          <p className="settings-note">無符合項目</p>
        ) : (
          <div className="unit-check-grid">
            {filtered.map((o) => (
              <label key={o.id} className="check-row">
                <input
                  type="checkbox"
                  checked={sel.has(o.id)}
                  disabled={disabled}
                  onChange={() => onToggle(o.id)}
                />
                <span>
                  {o.label}
                  {o.sub && <span className="muted-text">（{o.sub}）</span>}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 月份複選（顯示順序由呼叫端決定：學年度為 [8..12,1..7]） */
export function MonthPicker({
  order,
  selected,
  onChange,
  disabled,
}: {
  order: number[];
  selected: number[];
  onChange: (months: number[]) => void;
  disabled: boolean;
}) {
  const sel = useMemo(() => new Set(selected), [selected]);
  function toggle(m: number) {
    const next = new Set(sel);
    if (next.has(m)) next.delete(m);
    else next.add(m);
    onChange([...next].sort((a, b) => a - b));
  }
  return (
    <div className="month-grid">
      {order.map((m) => {
        const checked = sel.has(m);
        return (
          <label
            key={m}
            className={`check-row month-cell${checked ? " checked" : ""}`}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={() => toggle(m)}
            />
            <span>{MONTH_LABELS[m - 1]}</span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * 臨時排程月份選擇器（v1.88.19）：選項為明確曆年月（13 個），
 * 同月份數字可能出現兩次（如 2026/1 與 2027/1），故以 "yyyy/mm" 為鍵，
 * 顯示年／月；順序依傳入 options（年度 1–12＋次年 1 月；學年度 8 月起）。
 */
export function CalendarMonthPicker({
  options,
  selected,
  onChange,
  disabled,
}: {
  options: TempCycleMonth[];
  selected: TempCycleMonth[];
  onChange: (months: TempCycleMonth[]) => void;
  disabled: boolean;
}) {
  const sel = useMemo(
    () => new Set(selected.map((m) => `${m.year}/${pad2(m.month)}`)),
    [selected],
  );
  function toggle(opt: TempCycleMonth) {
    const key = `${opt.year}/${pad2(opt.month)}`;
    const next = new Set(sel);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(
      options
        .filter((o) => next.has(`${o.year}/${pad2(o.month)}`)),
    );
  }
  return (
    <div className="month-grid">
      {options.map((o) => {
        const key = `${o.year}/${pad2(o.month)}`;
        const checked = sel.has(key);
        return (
          <label
            key={key}
            className={`check-row month-cell${checked ? " checked" : ""}`}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={() => toggle(o)}
            />
            <span>{fmtYm(o.year, o.month)}</span>
          </label>
        );
      })}
    </div>
  );
}

/** 件數輸入（僅接受 ≥1 整數或清空＝未設定） */
export function useCaseCountInput(initial = "") {
  const [value, setValue] = useState(initial);
  const onInput = useCallback((raw: string) => {
    const t = raw.trim();
    if (t !== "" && (!/^\d+$/.test(t) || Number(t) < 1)) return;
    setValue(t);
  }, []);
  return { value, setValue, onInput };
}

/* ================= 分工總覽共用工具列（v1.88.16：篩選＋刪除所選） ================= */

/**
 * 分工總覽表上方的篩選列與刪除所選按鈕（主表與加審對話框共用）。
 * 篩選只影響顯示，不清除已選狀態；刪除只改本地 state（儲存／確認建立時才寫入）。
 */
export function AssignmentOverviewTools({
  search,
  onSearchChange,
  unitFilter,
  onUnitFilterChange,
  unitOptions,
  monthFilter,
  onMonthFilterChange,
  monthOptions,
  checkedCount,
  onDeleteSelected,
  deleteDisabled,
}: {
  search: string;
  onSearchChange: (v: string) => void;
  unitFilter: string;
  onUnitFilterChange: (v: string) => void;
  unitOptions: { value: string; label: string }[];
  /** v1.88.16：審查月份篩選（只做主表；對話框不傳＝不顯示月份下拉） */
  monthFilter?: string;
  onMonthFilterChange?: (v: string) => void;
  monthOptions?: { value: string; label: string }[];
  checkedCount: number;
  onDeleteSelected: () => void;
  deleteDisabled: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        flexWrap: "wrap",
        alignItems: "flex-end",
        marginBottom: 8,
      }}
    >
      <div style={{ maxWidth: 220, flex: "1 1 180px" }}>
        <label className="field-label">搜尋審查員</label>
        <input
          className="text-input"
          style={{ marginBottom: 0 }}
          placeholder="搜尋姓名或職編"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>
      <div style={{ maxWidth: 220, flex: "1 1 180px" }}>
        <label className="field-label">負責單位</label>
        <div className="select-wrap">
          <select
            value={unitFilter}
            onChange={(e) => onUnitFilterChange(e.target.value)}
            aria-label="負責單位篩選"
          >
            <option value="">全部</option>
            {unitOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <ChevronDown size={15} />
        </div>
      </div>
      {monthOptions != null && (
        <div style={{ maxWidth: 180, flex: "1 1 150px" }}>
          <label className="field-label">審查月份</label>
          <div className="select-wrap">
            <select
              value={monthFilter ?? ""}
              onChange={(e) => onMonthFilterChange?.(e.target.value)}
              aria-label="審查月份篩選"
            >
              <option value="">全部月份</option>
              {monthOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <ChevronDown size={15} />
          </div>
        </div>
      )}
      <div className="form-actions" style={{ marginTop: 0 }}>
        <button
          className="button button-outline"
          disabled={deleteDisabled}
          onClick={onDeleteSelected}
        >
          <Trash2 size={14} /> 刪除所選（{checkedCount}）
        </button>
        <span className="muted-text">已選 {checkedCount} 位</span>
      </div>
    </div>
  );
}
