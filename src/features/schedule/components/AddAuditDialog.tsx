import type { RowItem, UnitLite, UserLite, ReviewerLite } from "../model/types";
import { type IndicatorAssignment, type IndicatorSchedule, type AssignmentItem, findDuplicateUnits, filterAssignmentItems, ASSIGNMENT_UNIT_FILTER_UNLIMITED, isLockedAssignmentItem, findDuplicateTempSchedule, MONTH_LABELS, findDuplicateAssignmentTriples, createTempSchedule, parseCaseCount } from "../../../lib/scheduling";
import { useMemo, useState, useCallback, useEffect } from "react";
import { tempCycleMonths, type TempCycleMonth } from "../../../lib/cycle";
import { useCaseCountInput, type PickerOption, CalendarMonthPicker, OptionMultiPicker, AssignmentOverviewTools, InactiveReviewerNotice } from "./pickers";
import { defaultAddAuditReviewers, groupDisplayName, mergeItemsUnlimited, mergeItemsWithUnits } from "../model/pure";
import { type BelowThresholdRow, buildBelowThresholdRows, nextCalendarMonth } from "../../../lib/belowThreshold";
import { staffLabel } from "../../../lib/mask";
import { getFirebaseDb } from "../../../lib/firebase";
import { getDocs, query, collection, where, getDoc, doc } from "../../../lib/db";
import { effectiveThreshold } from "../../../lib/indicators";
import { toErrorMessage } from "../../../lib/errors";
import { pad2, fmtDateTime, reviewMonthToYm, fmtYm } from "../../../lib/ym";
import { Modal } from "./Modal";
import { Plus, CircleAlert, Trash2, Pencil, Check } from "lucide-react";
import { SectionTitle } from "../../../components/ui";
import { AssignmentEditModal } from "./AssignmentEditModal";

/* ================= 加審（臨時排程；v1.18：合併兩邊設定＋分工表） ================= */

export function AddAuditDialog({
  row,
  units,
  users,
  groupMap,
  reviewersByGroup,
  assignment,
  restrictedUnitCodes,
  restrictedUnitName,
  actor,
  deadlineDay,
  filterYear,
  cycle,
  existingTemps,
  onAction,
  onClose,
  onDone,
}: {
  row: RowItem;
  units: UnitLite[];
  users: UserLite[];
  groupMap: Map<string, string>;
  reviewersByGroup: Map<string, ReviewerLite[]>;
  assignment: IndicatorAssignment | null;
  /**
   * v1.88.5：單位排程者的可排單位集合（僅自己單位；null＝不設限）。
   */
  restrictedUnitCodes: ReadonlySet<string> | null;
  /** 受限時顯示用（自己單位名稱） */
  restrictedUnitName: string;
  actor: { id: string; name: string };
  deadlineDay: number;
  filterYear: number;
  cycle: "year" | "academic";
  /** 該指標既有的臨時排程（重複加審偵測＋「已加審」判定用） */
  existingTemps: IndicatorSchedule[];
  onAction: (m: string) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const restricted = restrictedUnitCodes != null;
  const restrictedUnitCode = restricted
    ? [...restrictedUnitCodes!][0] ?? ""
    : "";
  // v1.88.19：臨時排程月份選項＝該年度／學年度 12 個月＋結束後下一個月，
  // 合計 13 個明確曆年月（年度：filterYear/1–12＋(filterYear+1)/1；
  // 學年度：filterYear/8 起連續 12 個月＋次年 8 月）。
  const monthOptions = useMemo(
    () => tempCycleMonths(cycle, filterYear),
    [cycle, filterYear],
  );
  const [months, setMonths] = useState<TempCycleMonth[]>([]);
  const caseCount = useCaseCountInput();
  const [selUnits, setSelUnits] = useState<string[]>(() => {
    const ids = row.schedule?.unitIds ?? [];
    if (!restricted) return ids;
    // 受限時只帶入自己單位；原排程為不限單位或不含自己單位時預設自己單位。
    const own = ids.filter((c) => restrictedUnitCodes!.has(c));
    return own.length > 0
      ? own
      : restrictedUnitCode
        ? [restrictedUnitCode]
        : [];
  });
  // v1.51.0：不限單位（NA 排程的加審預設為不限單位模式）
  // v1.88.5：單位排程者不提供不限單位。
  const [unlimited, setUnlimited] = useState(
    () => !restricted && row.schedule?.unlimitedUnits === true,
  );
  const [selReviewers, setSelReviewers] = useState<string[]>(() =>
    row.schedule?.unlimitedUnits === true
      ? (assignment?.items ?? []).map((it) => it.reviewerId)
      : defaultAddAuditReviewers(assignment, row.schedule?.unitIds ?? []),
  );
  const [items, setItems] = useState<AssignmentItem[]>([]);
  const inactiveIds = useMemo(
    () => new Set(users.filter((u) => !u.activated && u.status !== "停用").map((u) => u.id)),
    [users],
  );
  const [saving, setSaving] = useState(false);
  // v1.60.0：常駐錯誤區（失敗訊息留著直到關閉或下次成功，不只靠一閃即逝的 toast）
  const [submitError, setSubmitError] = useState<string | null>(null);
  // v1.60.0：未達閾值挑選帶入的目標曆年（月份只是 1–12 數字，年份須明確帶入，否則 2025/7 會變成建立當年的 7 月）
  const [pickedYear, setPickedYear] = useState<number | null>(null);
  // v1.60.0：未達閾值挑選彈窗
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerRows, setPickerRows] = useState<BelowThresholdRow[] | null>(null);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);

  // 審核員候選：全部組別審查員主檔 ∪ 分工表審查員（組別由其單位推導）
  const reviewerMeta = useMemo(() => {
    const map = new Map<string, { name: string; groupId: string }>();
    reviewersByGroup.forEach((arr, gid) => {
      for (const r of arr) {
        if (!map.has(r.personId))
          map.set(r.personId, { name: r.name, groupId: gid });
      }
    });
    for (const it of assignment?.items ?? []) {
      if (map.has(it.reviewerId)) continue;
      const u = users.find((x) => x.id === it.reviewerId);
      if (!u?.reviewerAccessActive) continue;
      const g = units.find((x) => x.code === u?.unitCode)?.groupId ?? "";
      map.set(it.reviewerId, { name: u?.name ?? it.reviewerId, groupId: g });
    }
    return map;
  }, [reviewersByGroup, assignment, users, units]);

  const reviewerOptions: PickerOption[] = useMemo(
    () =>
      [...reviewerMeta.entries()]
        .map(([id, m]) => ({
          id,
          label: staffLabel(id, m.name),
          sub: m.groupId ? groupDisplayName(groupMap, m.groupId) : "分工表",
          groupId: m.groupId,
        }))
        .sort((a, b) => a.id.localeCompare(b.id, "zh-Hant")),
    [reviewerMeta, groupMap],
  );

  const unitOptions: PickerOption[] = useMemo(
    () =>
      units
        // v1.88.5：單位排程者只看得到自己單位可選。
        .filter((u) => !restricted || restrictedUnitCodes!.has(u.code))
        .map((u) => ({
          id: u.code,
          label: `${u.name}（${u.code}）`,
          sub: groupDisplayName(groupMap, u.groupId),
          groupId: u.groupId,
        })),
    [units, groupMap, restricted, restrictedUnitCodes],
  );

  const reviewerNameOf = useCallback(
    (id: string) => staffLabel(id, reviewerMeta.get(id)?.name ?? ""),
    [reviewerMeta],
  );
  const unitNameOf = useCallback(
    (code: string) => units.find((u) => u.code === code)?.name ?? code,
    [units],
  );

  const duplicates = useMemo(() => findDuplicateUnits(items), [items]);

  // v1.88.16：分工總覽篩選＋勾選刪除（只改本地 state，確認加審時才寫入）
  const [assignSearch, setAssignSearch] = useState("");
  const [assignUnitFilter, setAssignUnitFilter] = useState("");
  const [assignChecked, setAssignChecked] = useState<string[]>([]);
  // v1.88.16：編輯分工（只改本地 state，確認加審時才寫入）
  const [editingReviewerId, setEditingReviewerId] = useState<string | null>(
    null,
  );
  const filteredItems = useMemo(
    () =>
      filterAssignmentItems(
        items,
        assignSearch,
        assignUnitFilter,
        reviewerNameOf,
      ),
    [items, assignSearch, assignUnitFilter, reviewerNameOf],
  );
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
    const names = assignChecked.map((id) => reviewerNameOf(id)).join("、");
    const ok = window.confirm(
      `確定刪除以下 ${assignChecked.length} 位審查員的分工？\n${names}\n\n（只改畫面，按「確認加審」才建立；取消即復原）`,
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
  // 編輯單位選項＝本對話框單位選項 ∪ 該列既有單位
  // （舊單位不在選項內時併入，避免一開編輯未改就洗掉）。
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
  // 每單位件數沿用原值（編輯不改件數）；reviewMonths 原值保留（對話框的列無月份欄）。
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
      ...(editingItem.reviewMonths && editingItem.reviewMonths.length > 0
        ? { reviewMonths: [...editingItem.reviewMonths] }
        : {}),
    };
    setItems((prev) =>
      prev.map((it) => (it.reviewerId === item.reviewerId ? item : it)),
    );
    setEditingReviewerId(null);
  }

  // v1.60.0：未達閾值挑選清單（開啟彈窗時載入）：該指標全部審查紀錄
  // （帶 taskId 才能 join 任務判常規／加審）＋任務表＋既有臨時排程。
  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    (async () => {
      setPickerLoading(true);
      setPickerError(null);
      setPickerRows(null);
      try {
        const db = getFirebaseDb();
        const [recSnap, taskSnap, indSnap] = await Promise.all([
          getDocs(
            query(
              collection(db, "reviewRecords"),
              where("indicatorId", "==", row.indicatorId),
            ),
          ),
          getDocs(
            query(
              collection(db, "reviewTasks"),
              where("indicatorId", "==", row.indicatorId),
            ),
          ),
          getDoc(doc(db, "indicators", row.indicatorId)),
        ]);
        if (cancelled) return;
        const threshold = effectiveThreshold(
          indSnap.exists()
            ? (indSnap.data() as Record<string, unknown>)
            : {},
        );
        const records = recSnap.docs.map((d) => {
          const v = d.data() as Record<string, unknown>;
          return {
            taskId: String(v.taskId ?? ""),
            indicatorId: String(v.indicatorId ?? ""),
            unitId: String(v.unitId ?? ""),
            year: Number(v.year ?? 0),
            month: Number(v.month ?? 0),
            rate: typeof v.rate === "number" ? v.rate : null,
            thresholdAtSchedule:
              typeof v.thresholdAtSchedule === "number"
                ? v.thresholdAtSchedule
                : undefined,
          };
        });
        const tasks = taskSnap.docs.map((d) => {
          const v = d.data() as Record<string, unknown>;
          return {
            id: d.id,
            scheduleCategory:
              typeof v.scheduleCategory === "string"
                ? v.scheduleCategory
                : undefined,
          };
        });
        // v1.88.5：單位排程者的未達閾值挑選只列自己單位的列。
        const builtRows = buildBelowThresholdRows({
          records,
          tasks,
          indicatorId: row.indicatorId,
          threshold,
          tempSchedules: existingTemps,
        });
        setPickerRows(
          restricted
            ? builtRows
                .filter((r) =>
                  r.units.some((u) => u.unitId === restrictedUnitCode),
                )
                .map((r) => ({
                  ...r,
                  units: r.units.filter(
                    (u) => u.unitId === restrictedUnitCode,
                  ),
                }))
            : builtRows,
        );
      } catch (error) {
        if (!cancelled)
          setPickerError(`讀取未達閾值清單失敗：${toErrorMessage(error)}`);
      } finally {
        if (!cancelled) setPickerLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pickerOpen, row.indicatorId, existingTemps]);

  /** v1.60.0：點某個失敗年月 → 預填下一個月（完整年月）＋該月未達單位；件數與審查員由使用者補填 */
  function applyBelowThresholdRow(r: BelowThresholdRow) {
    const target = nextCalendarMonth(r.year, r.month);
    setMonths([{ year: target.year, month: target.month }]);
    setPickedYear(target.year);
    // v1.88.5：單位排程者只帶入自己單位。
    const ownUnits = restricted
      ? r.units
          .map((u) => u.unitId)
          .filter((c) => restrictedUnitCodes!.has(c))
      : r.units.map((u) => u.unitId);
    setSelUnits(
      ownUnits.length > 0
        ? ownUnits
        : restricted && restrictedUnitCode
          ? [restrictedUnitCode]
          : [],
    );
    setUnlimited(false);
    setPickerOpen(false);
  }

  function toggleId(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  function applyToTable() {
    if (selReviewers.length === 0) {
      onAction("請先選擇審核員");
      return;
    }
    // v1.88.5：防護——單位排程者不得以不限單位加入分工表。
    if (restricted && unlimited) {
      onAction("僅能為自己單位建立加審，不提供不限單位");
      return;
    }
    if (unlimited) {
      setItems((prev) => mergeItemsUnlimited(prev, selReviewers));
      setSelReviewers([]);
      return;
    }
    if (selUnits.length === 0) {
      onAction("請至少勾選一個單位");
      return;
    }
    setItems((prev) => mergeItemsWithUnits(prev, selReviewers, selUnits));
    setSelReviewers([]);
    setSelUnits([]);
  }

  function removeItem(reviewerId: string) {
    setItems((prev) => prev.filter((it) => it.reviewerId !== reviewerId));
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

  // v1.51.0：不限單位項目每位審查員計 1 組配對（每月份一筆任務）
  const pairCount = items.reduce(
    (n, it) => n + (it.unlimitedUnits === true ? 1 : it.units.length),
    0,
  );
  const previewTasks = months.length * pairCount;

  async function handleConfirm() {
    // v1.60.0：防重入（按鈕 disabled 之外再守一道，避免連點在同一個
    // React 批次內兩次進入建立流程而產生重複加審）
    if (saving) return;
    setSubmitError(null);
    if (months.length === 0) {
      onAction("請至少選擇一個審查月份");
      return;
    }
    if (caseCount.value.trim() === "") {
      onAction("請填寫審查件數");
      return;
    }
    if (items.length === 0) {
      onAction("請先將審核員與單位加入分工表");
      return;
    }
    // v1.60.0：短時間內相同內容（同月份、同單位集合）的加審擋下，
    // 避免重複建立；不同月份／單位／隔天以上的正常第二次加審不受影響
    // v1.88.19：月份為明確曆年月（13 個月可跨曆年），重複比對以曆年月為準。
    const dialogCalendarMonths = months.map(
      (m) => `${m.year}/${pad2(m.month)}`,
    );
    const dup = findDuplicateTempSchedule(
      existingTemps,
      {
        months: [...new Set(months.map((m) => m.month))].sort(
          (a, b) => a - b,
        ),
        calendarMonths: dialogCalendarMonths,
        unitIds: items.flatMap((it) => it.units.map((u) => u.unitId)),
        unlimitedUnits: items.some((it) => it.unlimitedUnits === true),
        selfReview: false,
      },
      Date.now(),
    );
    if (dup) {
      const d = new Date(Number(dup.period));
      const dupTime = Number.isNaN(d.getTime())
        ? ""
        : `（建立於 ${fmtDateTime(d)}）`;
      const dupMonthsLabel =
        dup.calendarMonths && dup.calendarMonths.length > 0
          ? dup.calendarMonths
              .map((ym) => {
                const p = reviewMonthToYm(ym);
                return p ? fmtYm(p.year, p.month) : ym;
              })
              .join("、")
          : [...dup.months]
              .sort((a, b) => a - b)
              .map((m) => MONTH_LABELS[m - 1])
              .join("、");
      const msg = `已有相同內容的加審${dupTime}建立（${dupMonthsLabel}・${dup.unlimitedUnits ? "不限單位" : `${dup.unitIds.length} 單位`}），請先查閱既有加審，確認是否重複。`;
      setSubmitError(msg);
      onAction(msg);
      return;
    }
    // v1.88.16：三元組重疊檢測——同一位審查員、同單位、同一月份重複指派時
    // 跳提醒、拒絕建立（整張表都不存）。對話框的列無 reviewMonths，
    // 有效月份＝全域審查月份＋目標年份；不限單位（unitId ""）與具體單位不算重疊。
    // v1.88.19：三元組比對用明確曆年月（dialogCalendarMonths 已在上方算出）。
    const dialogMonths = dialogCalendarMonths;
    const tripleDups = findDuplicateAssignmentTriples(items, () => dialogMonths);
    if (tripleDups.length > 0) {
      const lines = tripleDups.slice(0, 10).map((d) => {
        const ym = reviewMonthToYm(d.month);
        const monthLabel = ym ? fmtYm(ym.year, ym.month) : d.month;
        const unitLabel =
          d.unitId === ""
            ? "不限單位"
            : `${unitNameOf(d.unitId)}（${d.unitId}）`;
        return `${reviewerNameOf(d.reviewerId)}・${unitLabel}・${monthLabel} 重複指派`;
      });
      if (tripleDups.length > 10)
        lines.push(`…等共 ${tripleDups.length} 筆重複`);
      const tripleMsg = `以下分工有重複指派（同一位審查員、同單位、同一月份），請修正後再建立：\n${lines.join("\n")}`;
      setSubmitError(tripleMsg);
      onAction(tripleMsg);
      return;
    }
    setSaving(true);
    try {
      const db = getFirebaseDb();
      const { taskCount } = await createTempSchedule(db, {
        indicatorId: row.indicatorId,
        unitIds: [],
        months: [...new Set(months.map((m) => m.month))].sort(
          (a, b) => a - b,
        ),
        // v1.88.19：明確曆年月（13 個月可跨曆年），任務曆年以此為準。
        calendarMonths: dialogCalendarMonths,
        caseCount: parseCaseCount(Number(caseCount.value)),
        reviewerIds: [],
        items,
        refYear: pickedYear ?? filterYear,
        // v1.60.0：挑選帶入的目標曆年；未挑選時沿用舊行為（建立當年）
        yearOverride: pickedYear ?? undefined,
        selfReview: false,
        actor,
        deadlineDay,
      });
      onAction(`已建立加審排程（臨時）：${taskCount} 筆任務`);
      onDone();
    } catch (error) {
      const msg = `加審失敗：${toErrorMessage(error)}`;
      setSubmitError(msg);
      console.error("[加審失敗]", error);
      onAction(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Modal
        title={`加審：${row.name}`}
        note={`建立臨時排程並直接產生任務（${cycle === "academic" ? "學年度" : "年度"}月份：${fmtYm(monthOptions[0].year, monthOptions[0].month)}～${fmtYm(monthOptions[monthOptions.length - 1].year, monthOptions[monthOptions.length - 1].month)}，共 13 個月可選）`}
        onClose={onClose}
        medium
      >
      <div className="form-field">
        <label className="field-label">
          審查月份（可複選）
          {months.length > 0 && `：已選 ${months.length} 個月`}
        </label>
        <CalendarMonthPicker
          options={monthOptions}
          selected={months}
          onChange={setMonths}
          disabled={false}
        />
        <p className="settings-note">
          提供該{cycle === "academic" ? "學年度" : "年度"}全部 12
          個月＋結束後下一個月，共 13 個月可選。
        </p>
        <div className="form-actions" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="button button-outline button-sm"
            onClick={() => setPickerOpen(true)}
          >
            由未達閾值挑選
          </button>
          {pickedYear != null && (
            <span className="muted-text">
              目標年份 {pickedYear} 年（由未達閾值挑選帶入，月份／單位仍可手動改）
            </span>
          )}
        </div>
        {cycle === "academic" && (
          <p className="settings-note">
            學年度月份依 8 月制順序排列（8–12 月為前一年曆年、1–7
            月為後一年曆年）。
          </p>
        )}
      </div>

      <div className="form-field">
        <label className="field-label">
          審查件數 *
          <span className="muted-text">（必填，所有單位共用）</span>
        </label>
        <span className="case-count-field">
          <input
            type="number"
            min={1}
            step={1}
            value={caseCount.value}
            placeholder="必填"
            onChange={(e) => caseCount.onInput(e.target.value)}
            aria-label="審查件數"
          />
          件
        </span>
      </div>

      <label className="check-row" style={{ marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={unlimited}
          // v1.88.5：單位排程者不提供不限單位。
          disabled={restricted}
          onChange={(e) => setUnlimited(e.target.checked)}
        />
        <b>不限單位</b>
        <span className="muted-text">
          （不固定單位；單位顯示為 NA，審查時不用選單位）
          {restricted && "；單位召集人／執行幹事僅能為自己單位排程，不提供此選項"}
        </span>
      </label>
      {restricted && (
        <p className="settings-note">
          僅能為自己單位（{restrictedUnitName || "尚未設定所屬單位"}）建立加審。
        </p>
      )}

      <OptionMultiPicker
        title="選擇受審單位"
        options={unitOptions}
        groupMap={groupMap}
        selected={selUnits}
        onToggle={(id) => setSelUnits((prev) => toggleId(prev, id))}
        disabled={unlimited}
        searchPlaceholder="搜尋單位名稱或代碼"
      />

      <OptionMultiPicker
        title="選擇審核員"
        options={reviewerOptions}
        groupMap={groupMap}
        selected={selReviewers}
        onToggle={(id) => setSelReviewers((prev) => toggleId(prev, id))}
        searchPlaceholder="搜尋姓名或職編"
      />

      <div className="form-actions">
        <button
          className="button button-outline"
          disabled={
            selReviewers.length === 0 || (!unlimited && selUnits.length === 0)
          }
          onClick={applyToTable}
        >
          <Plus size={15} /> 加入分工表
        </button>
      </div>

      <SectionTitle
        title="分工總覽"
        note={
          items.length === 0
            ? "尚無分工資料"
            : `${items.length} 位審核員・${pairCount} 組指派${items.some((it) => it.unlimitedUnits === true) ? "（含不限單位）" : ""}`
        }
      />
      {items.length === 0 ? (
        <p className="settings-note">由上方選擇單位與審核員後加入。</p>
      ) : (
        <>
          <AssignmentOverviewTools
            search={assignSearch}
            onSearchChange={setAssignSearch}
            unitFilter={assignUnitFilter}
            onUnitFilterChange={setAssignUnitFilter}
            unitOptions={assignUnitOptions}
            checkedCount={assignChecked.length}
            onDeleteSelected={removeSelectedAssignments}
            deleteDisabled={assignChecked.length === 0}
          />
          {filteredItems.length === 0 ? (
            <p className="settings-note">無符合篩選條件的分工資料。</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>
                      <input
                        type="checkbox"
                        checked={allAssignChecked}
                        onChange={(e) => toggleAssignAll(e.target.checked)}
                        aria-label="全選"
                      />
                    </th>
                    <th>審核員</th>
                    <th>負責單位</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((it) => (
                    <tr key={it.reviewerId}>
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
                      <td>
                        <b>{reviewerNameOf(it.reviewerId)}</b>
                        <div className="muted-text">{it.reviewerId}</div>
                      </td>
                      <td>
                        {it.unlimitedUnits === true ? (
                          <span>不限單位</span>
                        ) : (
                          it.units.map((u) => (
                            <div key={u.unitId} className="assign-unit-row">
                              <span>
                                {unitNameOf(u.unitId)}
                                <span className="muted-text">（{u.unitId}）</span>
                                {duplicates.has(u.unitId) && (
                                  <CircleAlert
                                    size={13}
                                    className="dup-warn"
                                    aria-label="重複指派"
                                  />
                                )}
                              </span>
                              <button
                                className="text-button"
                                onClick={() => removeUnit(it.reviewerId, u.unitId)}
                                aria-label={`移除${u.unitId}`}
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          ))
                        )}
                      </td>
                      <td>
                        {isLockedAssignmentItem(it, restricted) ? (
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <InactiveReviewerNotice
        reviewerIds={items.map((it) => it.reviewerId)}
        inactiveIds={inactiveIds}
        nameOf={(id) => users.find((u) => u.id === id)?.name ?? ""}
      />
      <div className="form-field" style={{ marginTop: 12 }}>
        <label className="field-label">預覽</label>
        <p>
          <b>{previewTasks}</b> 筆任務
          <span className="muted-text">
            （{months.length} 個月 × {pairCount}{" "}
            組審核員{unlimited ? "" : "-單位"}配對
            {items.some((it) => it.unlimitedUnits === true)
              ? "；不限單位項目每位審查員每月一筆任務"
              : ""}
            ）
          </span>
        </p>
      </div>

      {submitError && (
        <div className="form-error" role="alert">
          {submitError}
        </div>
      )}

      <div className="form-actions">
        <button
          className="button button-primary"
          disabled={saving || previewTasks === 0}
          onClick={handleConfirm}
        >
          {saving ? "建立中…" : (
            <>
              <Check size={15} /> 確認加審
            </>
          )}
        </button>
        <button className="button button-ghost" onClick={onClose}>
          取消
        </button>
      </div>
      </Modal>

      {pickerOpen && (
        <Modal
          title={`未達閾值清單：${row.name}`}
          note="常規審查中未達閾值的年月及單位（點年月自動帶入下一個月與該月未達單位）"
          onClose={() => setPickerOpen(false)}
          layer={2}
        >
          {pickerLoading ? (
            <p className="settings-note">讀取中…</p>
          ) : pickerError ? (
            <div className="form-error" role="alert">
              {pickerError}
            </div>
          ) : pickerRows && pickerRows.length === 0 ? (
            <p className="settings-note">
              此指標目前沒有常規審查未達閾值的年月。
            </p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>年月</th>
                    <th>審查結果</th>
                    <th>未達單位</th>
                    <th>狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {(pickerRows ?? []).map((r) => {
                    const target = nextCalendarMonth(r.year, r.month);
                    return (
                      <tr key={`${r.year}-${r.month}`}>
                        <td>
                          <button
                            className="text-button"
                            onClick={() => applyBelowThresholdRow(r)}
                            title={`帶入 ${fmtYm(target.year, target.month)} 與未達單位`}
                          >
                            <b>
                              {r.year}/{r.month}
                            </b>
                          </button>
                        </td>
                        <td>
                          {r.units
                            .map(
                              (u) =>
                                `${u.unitId} ${u.rate}%(${u.pass}/${u.total})`,
                            )
                            .join("、")}
                          <div className="muted-text">
                            閾值 {r.threshold}%
                          </div>
                        </td>
                        <td>
                          {r.units
                            .map(
                              (u) =>
                                `${unitNameOf(u.unitId)}（${u.unitId}）`,
                            )
                            .join("、")}
                        </td>
                        <td>
                          {r.alreadyAddReviewed ? (
                            <span className="status-pill info">已加審</span>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="settings-note">
            點年月自動選取下一個月及該月未達單位；件數與審查員請回加審對話框指定，月份／單位仍可手動增減。
          </p>
          <div className="form-actions">
            <button
              className="button button-ghost"
              onClick={() => setPickerOpen(false)}
            >
              關閉
            </button>
          </div>
        </Modal>
      )}

      {editingItem != null && (
        <AssignmentEditModal
          key={editingItem.reviewerId}
          reviewerLabel={reviewerNameOf(editingItem.reviewerId)}
          unitOptions={editUnitOptions}
          groupMap={groupMap}
          initialUnits={editingItem.units.map((u) => u.unitId)}
          initialUnlimited={editingItem.unlimitedUnits === true}
          allowUnlimited={!restricted}
          onSave={saveAssignmentEdit}
          onClose={() => setEditingReviewerId(null)}
          layer={3}
        />
      )}
    </>
  );
}
