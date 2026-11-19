import { type IndicatorSchedule, type IndicatorAssignment, type AssignmentItem, scheduleReviewCalendarMonths, findDuplicateUnits, filterAssignmentItems, ASSIGNMENT_UNIT_FILTER_UNLIMITED, isLockedAssignmentItem, findDuplicateAssignmentTriples } from "../../../lib/scheduling";
import type { ReviewerLite, UnitLite } from "../model/types";
import { useMemo, useState, useCallback, useEffect } from "react";
import { splitAssignmentItemsByUnit, mergeAssignmentItemsByReviewer } from "../../../lib/dataScope";
import { pad2, normalizeReviewMonths, reviewMonthToYm, fmtYm } from "../../../lib/ym";
import { type PickerOption, InactiveReviewerNotice, OptionMultiPicker, AssignmentOverviewTools } from "./pickers";
import { staffLabel } from "../../../lib/mask";
import { groupDisplayName, mergeItemsUnlimited, mergeItemsWithUnits } from "../model/pure";
import { type ParsedAssignmentRow, mergeImportedAssignments } from "../../../lib/assignmentImport";
import { getFirebaseDb } from "../../../lib/firebase";
import { setDoc, doc, serverTimestamp } from "../../../lib/db";
import { toErrorMessage } from "../../../lib/errors";
import { SectionTitle } from "../../../components/ui";
import { Plus, CircleAlert, Trash2, Pencil } from "lucide-react";
import { AssignmentBatchImporter } from "./AssignmentBatchImporter";
import { AssignmentEditModal } from "./AssignmentEditModal";

export function AssignmentEditor({
  indicatorId,
  indicatorCode,
  schedule,
  reviewersByGroup,
  units,
  groupMap,
  usersMap,
  reviewerRoleIds,
  inactiveIds,
  initial,
  restrictedUnitCodes,
  restrictedUnitName,
  canEdit,
  onAction,
  onSaved,
}: {
  indicatorId: string;
  /** v1.88.13：目前頁面指標的代號（匯入核對用） */
  indicatorCode: string;
  /**
   * v1.88.13：該期「排程／單位設定」（單位與月份來源）；
   * null＝本期尚無排程，單位與月份選項為空。
   */
  schedule: IndicatorSchedule | null;
  reviewersByGroup: Map<string, ReviewerLite[]>;
  units: UnitLite[];
  groupMap: Map<string, string>;
  usersMap: Map<string, string>;
  reviewerRoleIds: Set<string>;
  inactiveIds: Set<string>;
  initial: IndicatorAssignment | null;
  /**
   * v1.88.5：單位排程者的可排單位集合（僅自己單位；null＝不設限）。
   */
  restrictedUnitCodes: ReadonlySet<string> | null;
  /** 受限時顯示用（自己單位名稱） */
  restrictedUnitName: string;
  canEdit: boolean;
  onAction: (m: string) => void;
  onSaved: () => void;
}) {
  const restricted = restrictedUnitCodes != null;
  const restrictedUnitCode = restricted
    ? [...restrictedUnitCodes!][0] ?? ""
    : "";
  // v1.88.5：受限時，初始分工表按單位拆分——state 只留自己單位的部分
  // （不限單位項目整筆保留、鎖定），其餘部分另存，儲存時合併還原，
  // 不因編輯而刪除其他單位的分工。
  const splitInitial = useMemo(
    () =>
      restricted
        ? splitAssignmentItemsByUnit(initial?.items ?? [], restrictedUnitCode)
        : {
            own: initial?.items ?? [],
            other: [] as AssignmentItem[],
          },
    // initial 只在掛載時讀取（與既有 items state 相同語意）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [otherItems] = useState<AssignmentItem[]>(splitInitial.other);
  const [items, setItems] = useState<AssignmentItem[]>(
    splitInitial.own.map((it) => ({
      reviewerId: it.reviewerId,
      units: it.units.map((u) => ({ ...u })),
      ...(it.unlimitedUnits === true
        ? { unlimitedUnits: true as const }
        : {}),
      // v1.88.13：審查月份一併帶入 state（缺值＝全部月份）。
      ...(it.reviewMonths && it.reviewMonths.length > 0
        ? { reviewMonths: [...it.reviewMonths] }
        : {}),
    })),
  );
  const [selReviewers, setSelReviewers] = useState<string[]>([]);
  const [selUnits, setSelUnits] = useState<string[]>([]);
  // v1.51.0：不限單位模式（此審查員不固定單位）
  const [unlimited, setUnlimited] = useState(false);
  // v1.88.13：第 3 步：審查月份（多選，必填；候選＝該期排程的審查曆月）
  const [selMonths, setSelMonths] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  /** 該期排程的審查曆月（"yyyy/mm"，依曆年月排序；無排程為空） */
  const scheduleMonths: string[] = useMemo(
    () =>
      schedule
        ? scheduleReviewCalendarMonths(schedule).map(
            ({ year, month }) => `${year}/${pad2(month)}`,
          )
        : [],
    [schedule],
  );
  const scheduleMonthSet = useMemo(
    () => new Set(scheduleMonths),
    [scheduleMonths],
  );

  // 審查員候選：全部組別的審查員主檔（組別下拉篩選）
  const reviewerOptions: PickerOption[] = useMemo(() => {
    const out: PickerOption[] = [];
    reviewersByGroup.forEach((arr, gid) => {
      for (const r of arr) {
        out.push({
          id: r.personId,
          label: staffLabel(r.personId, r.name),
          sub: groupDisplayName(groupMap, gid),
          groupId: gid,
        });
      }
    });
    return out.sort((a, b) => a.id.localeCompare(b.id, "zh-Hant"));
  }, [reviewersByGroup, groupMap]);

  const unitOptions: PickerOption[] = useMemo(
    () =>
      units
        // v1.88.13：要審查的單位來自該期「排程／單位設定」的 unitIds；
        // 排程不限單位時不設限；無該期排程時選項為空。
        .filter((u) =>
          schedule == null
            ? false
            : schedule.unlimitedUnits
              ? true
              : schedule.unitIds.includes(u.code),
        )
        // v1.88.5：單位排程者只看得到自己單位可選。
        .filter((u) => !restricted || restrictedUnitCodes!.has(u.code))
        .map((u) => ({
          id: u.code,
          label: `${u.name}（${u.code}）`,
          sub: groupDisplayName(groupMap, u.groupId),
          groupId: u.groupId,
        })),
    [units, groupMap, restricted, restrictedUnitCodes, schedule],
  );

  const reviewerName = useCallback(
    (id: string) => {
      for (const arr of reviewersByGroup.values()) {
        const r = arr.find((x) => x.personId === id);
        if (r) return staffLabel(id, r.name);
      }
      return staffLabel(id, usersMap.get(id) ?? "");
    },
    [reviewersByGroup, usersMap],
  );

  const unitNameOf = useCallback(
    (code: string) => units.find((u) => u.code === code)?.name ?? code,
    [units],
  );

  const duplicates = useMemo(() => findDuplicateUnits(items), [items]);

  // v1.88.16：分工總覽篩選＋勾選刪除（只改本地 state，按「儲存分工表」才寫入）
  const [assignSearch, setAssignSearch] = useState("");
  const [assignUnitFilter, setAssignUnitFilter] = useState("");
  // v1.88.16：審查月份篩選（與審查員、單位複合查詢，AND）
  const [assignMonthFilter, setAssignMonthFilter] = useState("");
  const [assignChecked, setAssignChecked] = useState<string[]>([]);
  // v1.88.16：編輯分工（只改本地 state，按「儲存分工表」才寫入）
  const [editingReviewerId, setEditingReviewerId] = useState<string | null>(
    null,
  );
  const filteredItems = useMemo(
    () =>
      filterAssignmentItems(
        items,
        assignSearch,
        assignUnitFilter,
        reviewerName,
        assignMonthFilter,
      ),
    [items, assignSearch, assignUnitFilter, reviewerName, assignMonthFilter],
  );
  // 月份篩選選項＝表內出現的月份聯集（去重排序；缺值列不貢獻選項，但篩選任一月份都算符合）
  const assignMonthOptions = useMemo(() => {
    const months = [
      ...new Set(items.flatMap((it) => normalizeReviewMonths(it.reviewMonths))),
    ].sort();
    return months.map((m) => {
      const ym = reviewMonthToYm(m);
      return { value: m, label: ym ? fmtYm(ym.year, ym.month) : m };
    });
  }, [items]);
  const assignUnitOptions = useMemo(() => {
    const codes = [
      ...new Set(items.flatMap((it) => it.units.map((u) => u.unitId))),
    ].sort();
    const opts = codes.map((code) => ({
      value: code,
      label: `${unitNameOf(code)}（${code}）`,
    }));
    if (items.some((it) => it.unlimitedUnits === true))
      opts.unshift({
        value: ASSIGNMENT_UNIT_FILTER_UNLIMITED,
        label: "不限單位",
      });
    return opts;
  }, [items, unitNameOf]);
  // 可勾選列＝篩選結果中未鎖定的列（受限時不限單位項目鎖定，不可勾選／刪除）
  const selectableItems = useMemo(
    () => filteredItems.filter((it) => !isLockedAssignmentItem(it, restricted)),
    [filteredItems, restricted],
  );
  const allAssignChecked =
    selectableItems.length > 0 &&
    selectableItems.every((it) => assignChecked.includes(it.reviewerId));
  // 分工列被逐列／逐單位移除後，勾選清單一併清除已不在表上的職編
  useEffect(() => {
    setAssignChecked((prev) =>
      prev.filter((id) => items.some((it) => it.reviewerId === id)),
    );
  }, [items]);

  function toggleAssignChecked(reviewerId: string, next: boolean) {
    setAssignChecked((prev) =>
      next ? [...prev, reviewerId] : prev.filter((x) => x !== reviewerId),
    );
  }

  function toggleAssignAll(next: boolean) {
    setAssignChecked((prev) =>
      next
        ? [
            ...new Set([
              ...prev,
              ...selectableItems.map((it) => it.reviewerId),
            ]),
          ]
        : prev.filter(
            (id) => !selectableItems.some((it) => it.reviewerId === id),
          ),
    );
  }

  function removeSelectedAssignments() {
    if (assignChecked.length === 0) return;
    const names = assignChecked.map((id) => reviewerName(id)).join("、");
    const ok = window.confirm(
      `確定刪除以下 ${assignChecked.length} 位審查員的分工？\n${names}\n\n（只改畫面，按「儲存分工表」才寫入；未儲存就離開，分工會復原）`,
    );
    if (!ok) return;
    const toDelete = new Set(assignChecked);
    setItems((prev) =>
      prev.filter(
        (it) =>
          !toDelete.has(it.reviewerId) ||
          isLockedAssignmentItem(it, restricted),
      ),
    );
    setAssignChecked([]);
  }

  const editingItem = useMemo(
    () => items.find((it) => it.reviewerId === editingReviewerId) ?? null,
    [items, editingReviewerId],
  );
  // 編輯單位選項＝該期排程單位選項 ∪ 該列既有單位
  // （舊單位不在本期排程內時併入，避免一開編輯未改就洗掉）。
  const editUnitOptions = useMemo(() => {
    if (editingItem == null) return unitOptions;
    const have = new Set(unitOptions.map((o) => o.id));
    const extra = editingItem.units
      .map((u) => u.unitId)
      .filter((c) => !have.has(c))
      .map((c) => ({
        id: c,
        label: `${unitNameOf(c)}（${c}）`,
        sub: "",
        groupId: units.find((u) => u.code === c)?.groupId ?? "",
      }));
    return [...unitOptions, ...extra];
  }, [editingItem, unitOptions, unitNameOf, units]);

  // v1.88.16：編輯儲存——按 reviewerId 原地取代（取代語意），絕對不用附加新列；
  // 每單位件數沿用原值（編輯不改件數）；「全部月份」寫回 reviewMonths 缺值（保持缺值）。
  function saveAssignmentEdit(next: {
    units: string[];
    unlimited: boolean;
    reviewMonths: string[] | undefined;
  }) {
    if (editingItem == null) return;
    const caseCountByUnit = new Map(
      editingItem.units.map((u) => [u.unitId, u.caseCount]),
    );
    const item: AssignmentItem = {
      reviewerId: editingItem.reviewerId,
      units: next.unlimited
        ? []
        : next.units
            .map((unitId) => ({
              unitId,
              caseCount: caseCountByUnit.get(unitId) ?? null,
            }))
            .sort((a, b) => a.unitId.localeCompare(b.unitId, "zh-Hant")),
      ...(next.unlimited ? { unlimitedUnits: true as const } : {}),
      ...(next.reviewMonths && next.reviewMonths.length > 0
        ? { reviewMonths: normalizeReviewMonths(next.reviewMonths) }
        : {}),
    };
    setItems((prev) =>
      prev.map((it) => (it.reviewerId === item.reviewerId ? item : it)),
    );
    setEditingReviewerId(null);
  }

  function toggleId(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  function removeUnit(reviewerId: string, unitId: string) {
    setItems((prev) =>
      prev
        .map((it) => {
          // v1.51.0：不限單位項目沒有單位列，守旗標不刪項目
          if (it.reviewerId === reviewerId && it.unlimitedUnits === true)
            return it;
          return it.reviewerId === reviewerId
            ? { ...it, units: it.units.filter((u) => u.unitId !== unitId) }
            : it;
        })
        .filter((it) => it.unlimitedUnits === true || it.units.length > 0),
    );
  }

  function applyToTable() {
    if (selReviewers.length === 0) {
      onAction("請先選擇審查員");
      return;
    }
    // v1.88.13：分工表須有該期排程才能加入（單位與月份皆來自排程／單位設定）。
    if (schedule == null) {
      onAction("請先完成排程／單位設定（本期尚無排程，無法選擇單位與月份）");
      return;
    }
    // v1.88.5：防護——單位排程者不得以不限單位加入分工表。
    if (restricted && unlimited) {
      onAction("僅能為自己單位排程，不提供不限單位");
      return;
    }
    // v1.88.13：第 3 步審查月份為必填（不限單位亦同）。
    if (selMonths.length === 0) {
      onAction("請選擇審查月份");
      return;
    }
    if (unlimited) {
      setItems((prev) => mergeItemsUnlimited(prev, selReviewers, selMonths));
      onAction(
        `已加入分工表：${selReviewers.length} 位審查員（不限單位）・${selMonths.join("、")}`,
      );
      setSelReviewers([]);
      setSelMonths([]);
      return;
    }
    if (selUnits.length === 0) {
      onAction("請至少勾選一個單位");
      return;
    }
    setItems((prev) =>
      mergeItemsWithUnits(prev, selReviewers, selUnits, selMonths),
    );
    onAction(
      `已加入分工表：${selReviewers.length} 位審查員 × ${selUnits.length} 個單位・${selMonths.join("、")}`,
    );
    setSelReviewers([]);
    setSelUnits([]);
    setSelMonths([]);
  }

  function removeItem(reviewerId: string) {
    // v1.88.5：受限時不限單位項目鎖定（涵蓋所有單位，單位排程者不得移除）。
    setItems((prev) =>
      prev.filter(
        (it) =>
          it.reviewerId !== reviewerId ||
          (restricted && it.unlimitedUnits === true),
      ),
    );
  }

  // v1.88.4：批次匯入併入分工表 state（只改畫面，儲存時才寫入 Firestore）
  function importAssignments(parsed: ParsedAssignmentRow[]) {
    setItems((prev) => {
      const merged = mergeImportedAssignments(prev, parsed);
      if (!restricted) return merged;
      // v1.88.5：匯入不得把鎖定的不限單位項目改回指定單位項目。
      const locked = new Map(
        prev
          .filter((it) => it.unlimitedUnits === true)
          .map((it) => [it.reviewerId, it]),
      );
      return merged.map((it) => locked.get(it.reviewerId) ?? it);
    });
  }

  async function handleSave() {
    // v1.88.5：受限時把其他單位的部分合併還原後再寫入（只改自己單位）。
    const mergedItems = restricted
      ? mergeAssignmentItemsByReviewer(items, otherItems)
      : items;
    if (mergedItems.length === 0) {
      onAction("分工表尚無資料，請先加入審查員與單位");
      return;
    }
    const dups = findDuplicateUnits(mergedItems);
    if (dups.size > 0) {
      const lines = [...dups.entries()].map(
        ([u, rs]) => `${u}：${rs.map((r) => reviewerName(r)).join("、")}`,
      );
      const ok = window.confirm(
        `以下單位被重複指派給 2 位以上審查員：\n${lines.join("\n")}\n\n確定要儲存嗎？（僅警示，不阻擋）`,
      );
      if (!ok) return;
    }
    // v1.88.16：三元組重疊檢測——同一位審查員、同單位、同一月份重複指派時
    // 跳提醒、拒絕儲存（整張表都不存）。月份缺值列用該期排程曆月展開；
    // 無排程曆月時缺值列不參與比對；不限單位（unitId ""）與具體單位不算重疊。
    const tripleDups = findDuplicateAssignmentTriples(mergedItems, () =>
      scheduleMonths,
    );
    if (tripleDups.length > 0) {
      const lines = tripleDups.slice(0, 10).map((d) => {
        const ym = reviewMonthToYm(d.month);
        const monthLabel = ym ? fmtYm(ym.year, ym.month) : d.month;
        const unitLabel =
          d.unitId === ""
            ? "不限單位"
            : `${unitNameOf(d.unitId)}（${d.unitId}）`;
        return `${reviewerName(d.reviewerId)}・${unitLabel}・${monthLabel} 重複指派`;
      });
      if (tripleDups.length > 10)
        lines.push(`…等共 ${tripleDups.length} 筆重複`);
      window.alert(
        `以下分工有重複指派（同一位審查員、同單位、同一月份），請修正後再儲存：\n${lines.join("\n")}`,
      );
      return;
    }
    setSaving(true);
    try {
      const db = getFirebaseDb();
      await setDoc(doc(db, "indicatorAssignments", indicatorId), {
        indicatorId,
        items: mergedItems,
        updatedAt: serverTimestamp(),
      });
      onAction("已儲存審查員／單位分工表");
      onSaved();
    } catch (error) {
      onAction(`儲存失敗：${toErrorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <section className="panel">
        <SectionTitle
          title="審查員／單位設定"
          note="三步加入分工表：1. 選審查員（可多選），2. 選負責單位（可多選，來自該期「排程／單位設定」的受審單位），3. 選審查月份（必填，可多選）；同一單位可指派給多位審查員（會警示但不阻擋）。審查件數在「排程／單位設定」中按年度設定。"
        />
        {schedule == null && (
          <p className="settings-note">
            本期尚無「排程／單位設定」，請先完成排程／單位設定（單位、月份、件數皆需設定），才能選擇負責單位與審查月份。
          </p>
        )}
        <InactiveReviewerNotice
          reviewerIds={items.map((it) => it.reviewerId)}
          inactiveIds={inactiveIds}
          nameOf={(id) => usersMap.get(id) ?? ""}
        />
        {reviewerOptions.length === 0 ? (
          <p className="settings-note">
            尚未設定審查員，請先到「群組與人員」→「人員」頁籤為人員設定審查員角色。
          </p>
        ) : (
          <OptionMultiPicker
            title="1. 選擇審查員"
            options={reviewerOptions}
            groupMap={groupMap}
            selected={selReviewers}
            onToggle={(id) => setSelReviewers((prev) => toggleId(prev, id))}
            disabled={!canEdit}
            searchPlaceholder="搜尋姓名或職編"
          />
        )}
        <label className="check-row" style={{ marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={unlimited}
            // v1.88.5：單位排程者不提供不限單位。
            disabled={!canEdit || restricted}
            onChange={(e) => setUnlimited(e.target.checked)}
          />
          <b>不限單位</b>
          <span className="muted-text">
            （勾選後不選負責單位；單位顯示為 NA，審查時不用選單位）
            {restricted && "；單位召集人／執行幹事僅能為自己單位排程，不提供此選項"}
          </span>
        </label>
        {restricted && (
          <p className="settings-note">
            僅能為自己單位（{restrictedUnitName || "尚未設定所屬單位"}）設定分工表
            {otherItems.length > 0 &&
              "；其他單位的既有分工會保留，不會因儲存而刪除"}
            。
          </p>
        )}
        <OptionMultiPicker
          title="2. 選擇負責單位"
          options={unitOptions}
          groupMap={groupMap}
          selected={selUnits}
          onToggle={(id) => setSelUnits((prev) => toggleId(prev, id))}
          onToggleAll={(ids, select) =>
            setSelUnits((prev) =>
              select
                ? [...prev, ...ids.filter((id) => !prev.includes(id))]
                : prev.filter((id) => !ids.includes(id)),
            )
          }
          disabled={!canEdit || unlimited}
          searchPlaceholder="搜尋單位名稱或代碼"
        />
        <div style={{ marginTop: 12 }}>
          <b>3. 選擇審查月份（必填，可多選）</b>
          {schedule == null ? (
            <p className="settings-note">
              請先完成排程／單位設定（本期尚無排程，無法選擇審查月份）。
            </p>
          ) : scheduleMonths.length === 0 ? (
            <p className="settings-note">
              本期排程尚未設定審查月份，請先到「排程／單位設定」設定月份。
            </p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", marginTop: 6 }}>
              {scheduleMonths.map((m) => (
                <label key={m} className="check-row">
                  <input
                    type="checkbox"
                    checked={selMonths.includes(m)}
                    disabled={!canEdit}
                    onChange={() =>
                      setSelMonths((prev) => toggleId(prev, m))
                    }
                  />
                  {m}
                </label>
              ))}
            </div>
          )}
        </div>
        {canEdit && (
          <div className="form-actions">
            <button
              className="button button-outline"
              disabled={
                selReviewers.length === 0 ||
                (!unlimited && selUnits.length === 0) ||
                selMonths.length === 0 ||
                schedule == null
              }
              onClick={applyToTable}
            >
              <Plus size={15} /> 加入分工表
            </button>
          </div>
        )}
        {canEdit && (
          <AssignmentBatchImporter
            indicatorCode={indicatorCode}
            allowedReviewMonths={schedule ? scheduleMonthSet : undefined}
            scheduleUnitCodes={
              schedule && !schedule.unlimitedUnits
                ? new Set(schedule.unitIds)
                : undefined
            }
            reviewersByGroup={reviewersByGroup}
            usersMap={usersMap}
            reviewerRoleIds={reviewerRoleIds}
            units={units}
            restrictedUnitCodes={restrictedUnitCodes}
            restrictedUnitName={restrictedUnitName}
            onImport={importAssignments}
            onAction={onAction}
          />
        )}
      </section>

      <section className="panel">
        <SectionTitle
          title="分工總覽"
          note={
            items.length === 0
              ? "尚無分工資料"
              : `${items.length} 位審查員・${items.reduce((n, it) => n + it.units.length, 0)} 單位指派${items.some((it) => it.unlimitedUnits === true) ? "（含不限單位）" : ""}`
          }
        />
        {items.length === 0 ? (
          <p className="settings-note">由上方選擇審查員與單位後加入。</p>
        ) : (
          <>
            <AssignmentOverviewTools
              search={assignSearch}
              onSearchChange={setAssignSearch}
              unitFilter={assignUnitFilter}
              onUnitFilterChange={setAssignUnitFilter}
              unitOptions={assignUnitOptions}
              monthFilter={assignMonthFilter}
              onMonthFilterChange={setAssignMonthFilter}
              monthOptions={assignMonthOptions}
              checkedCount={assignChecked.length}
              onDeleteSelected={removeSelectedAssignments}
              deleteDisabled={!canEdit || assignChecked.length === 0}
            />
            {filteredItems.length === 0 ? (
              <p className="settings-note">無符合篩選條件的分工資料。</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      {canEdit && (
                        <th style={{ width: 36 }}>
                          <input
                            type="checkbox"
                            checked={allAssignChecked}
                            onChange={(e) => toggleAssignAll(e.target.checked)}
                            aria-label="全選"
                          />
                        </th>
                      )}
                      <th>審查員</th>
                      <th>負責單位</th>
                      <th>審查月份</th>
                      {canEdit && <th>操作</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredItems.map((it) => (
                      <tr key={it.reviewerId}>
                        {canEdit && (
                          <td>
                            <input
                              type="checkbox"
                              checked={assignChecked.includes(it.reviewerId)}
                              disabled={isLockedAssignmentItem(it, restricted)}
                              onChange={(e) =>
                                toggleAssignChecked(
                                  it.reviewerId,
                                  e.target.checked,
                                )
                              }
                              aria-label={`選擇 ${it.reviewerId}`}
                            />
                          </td>
                        )}
                        <td>
                          <b>{reviewerName(it.reviewerId)}</b>
                          <div className="muted-text">{it.reviewerId}</div>
                        </td>
                    <td>
                      {it.unlimitedUnits === true ? (
                        <span>不限單位</span>
                      ) : (
                        it.units.map((u) => (
                          <div key={u.unitId} className="assign-unit-row">
                            <span>
                              {u.unitId}
                              {duplicates.has(u.unitId) && (
                                <CircleAlert
                                  size={13}
                                  className="dup-warn"
                                  aria-label="重複指派"
                                />
                              )}
                            </span>
                            {canEdit && (
                              <button
                                className="text-button"
                                onClick={() => removeUnit(it.reviewerId, u.unitId)}
                                aria-label={`移除${u.unitId}`}
                              >
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        ))
                      )}
                    </td>
                    <td>
                      {it.reviewMonths && it.reviewMonths.length > 0
                        ? it.reviewMonths
                            .map((m) => {
                              const ym = reviewMonthToYm(m);
                              return ym ? fmtYm(ym.year, ym.month) : m;
                            })
                            .join("、")
                        : "全部月份"}
                    </td>
                    {canEdit && (
                      <td>
                        {restricted && it.unlimitedUnits === true ? (
                          <span
                            className="muted-text"
                            title="不限單位項目涵蓋所有單位，單位排程者不得移除"
                          >
                            鎖定
                          </span>
                        ) : (
                          <span style={{ display: "inline-flex", gap: 4 }}>
                            <button
                              className="text-button"
                              onClick={() =>
                                setEditingReviewerId(it.reviewerId)
                              }
                            >
                              <Pencil size={13} /> 編輯
                            </button>
                            <button
                              className="text-button"
                              onClick={() => removeItem(it.reviewerId)}
                            >
                              <Trash2 size={13} /> 移除
                            </button>
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
            )}
          </>
        )}
        {duplicates.size > 0 && (
          <p className="dup-note">
            <CircleAlert size={14} /> 以下單位被重複指派（儲存時會再次確認，不阻擋）：
            {[...duplicates.keys()].join("、")}
          </p>
        )}
        {canEdit && (
          <div className="form-actions">
            <button
              className="button button-primary"
              disabled={saving}
              onClick={handleSave}
            >
              {saving ? "儲存中…" : "儲存分工表"}
            </button>
          </div>
        )}
      </section>

      {editingItem != null && (
        <AssignmentEditModal
          key={editingItem.reviewerId}
          reviewerLabel={reviewerName(editingItem.reviewerId)}
          unitOptions={editUnitOptions}
          groupMap={groupMap}
          initialUnits={editingItem.units.map((u) => u.unitId)}
          initialUnlimited={editingItem.unlimitedUnits === true}
          allowUnlimited={!restricted}
          scheduleMonths={scheduleMonths}
          initialMonths={editingItem.reviewMonths}
          onSave={saveAssignmentEdit}
          onClose={() => setEditingReviewerId(null)}
        />
      )}
    </>
  );
}
