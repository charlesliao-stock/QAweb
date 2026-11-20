import type { UnitOpt, GroupOpt, IndicatorOpt } from "../model/types";
import { useState, useEffect, Fragment } from "react";
import { pad2, fmtYm, fmtTsDate } from "../../../lib/ym";
import { useTableSort, FilterPanel, ListPanel, SortableTh, EmptyState } from "../../../components/ui";
import { getFirebaseDb } from "../../../lib/firebase";
import { getDoc, getDocsFromServer, query, collection, where, writeBatch, doc, serverTimestamp } from "../../../lib/db";
import { toErrorMessage } from "../../../lib/errors";
import { stripInternalIdPrefix, asOptionSet, optionLabelsOf } from "../../../lib/indicators";
import { computeOptionSetScore } from "../../../lib/reviewRecords";
import { Search } from "lucide-react";
import { SelectField, SearchableSelect, ResultMonthPicker } from "./small";
import { mergeNoteParts } from "../../../lib/import";
import { staffLabel } from "../../../lib/mask";

export interface ManagedResult {
  id: string;
  year: number;
  month: number;
  unitId: string;
  indicatorId: string;
  rate: number | null;
  reviewerEmpNo: string;
  reviewerName: string;
  /** 受審人員職編（v1.50.0：被審人員顯示職編/遮罩姓名） */
  reviewedPersonEmpNo: string;
  reviewedPersonName: string;
  submittedAt: unknown;
  /** 逐題作答快照（v1.41.1：明細展開顯示常見錯誤與補充說明） */
  answers: {
    questionId: string;
    itemText: string;
    optionLabel: string;
    commonErrors: string[];
    note: string;
  }[];
}

export function ReviewResultManager({
  units,
  groups,
  indicators,
  user,
  onAction,
  onDone,
}: {
  units: UnitOpt[];
  groups: GroupOpt[];
  indicators: IndicatorOpt[];
  user: { staffId: string; name: string } | null;
  onAction: (message: string) => void;
  onDone: (years: number[]) => void;
}) {
  const now = new Date();
  const [unitId, setUnitId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [indicatorId, setIndicatorId] = useState("");
  const [start, setStart] = useState(`${now.getFullYear()}-01`);
  const [end, setEnd] = useState(
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`,
  );
  const [rows, setRows] = useState<ManagedResult[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [queried, setQueried] = useState(false);
  const [error, setError] = useState("");
  /** 展開明細的紀錄 id（v1.41.1：逐題常見錯誤與補充說明） */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /**
   * v1.88.33 Q2：修正單筆審查紀錄（僅系統管理員）。
   * 可改：逐題作答（選項／備註）、受審人員、審查人員、床號、審核項目、審查日期；
   * 改完重算總分與正確率、寫 editHistory＋auditLogs。
   * 不可改：指標、年月、單位與排程快照（firestore.rules preservesReviewSnapshot
   * 禁止更動，改了會被 rules 擋下；要改須另案放寬 rules）。
   */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [editBase, setEditBase] = useState<{
    rate: number | null;
    quotaGroupId?: string;
    version?: number;
    editHistory: Record<string, unknown>[];
    answers: ManagedResult["answers"];
  } | null>(null);
  const [editForm, setEditForm] = useState<{
    answers: { questionId: string; itemText: string; optionLabel: string; note: string }[];
    reviewedPersonEmpNo: string;
    reviewedPersonName: string;
    reviewerEmpNo: string;
    reviewerName: string;
    bedNo: string;
    auditItem: string;
    reviewDate: string;
  } | null>(null);

  useEffect(() => {
    setRows([]);
    setSelected([]);
    setQueried(false);
    setError("");
    setExpandedId(null);
  }, [unitId, groupId, indicatorId, start, end]);

  const unitName = (id: string) =>
    units.find((unit) => unit.code === id)?.name ?? (id === "" ? "NA" : id);
  const indicatorName = (id: string) =>
    indicators.find((indicator) => indicator.id === id)?.name ?? id;

  const {
    sortedRows: sortedResults,
    sort: resultSort,
    toggleSort: toggleResultSort,
  } = useTableSort<
    ManagedResult,
    "date" | "unit" | "indicator" | "reviewer" | "reviewed" | "rate" | "submitted"
  >(rows, {
    date: (r) => r.year * 100 + r.month,
    unit: (r) => unitName(r.unitId),
    indicator: (r) => indicatorName(r.indicatorId),
    reviewer: (r) => r.reviewerEmpNo,
    reviewed: (r) => r.reviewedPersonEmpNo,
    rate: (r) => r.rate,
    submitted: (r) => submittedMillis(r.submittedAt),
  });

  const queryResults = async () => {
    if (busy || !start || !end || start > end) return;
    setBusy(true);
    setError("");
    setSelected([]);
    setExpandedId(null);    try {
      const db = getFirebaseDb();
      const firstYear = Number(start.slice(0, 4));
      const lastYear = Number(end.slice(0, 4));
      const years = Array.from(
        { length: lastYear - firstYear + 1 },
        (_, index) => firstYear + index,
      );
      const snaps = await Promise.all(
        years.map((year) =>
          getDocsFromServer(
            query(
              collection(db, "reviewRecords"),
              where("year", "==", year),
            ),
          ),
        ),
      );
      const result: ManagedResult[] = [];
      snaps.forEach((snapshot) => {
        snapshot.docs.forEach((document) => {
          const value = document.data() as Record<string, unknown>;
          const year = Number(value.year ?? 0);
          const month = Number(value.month ?? 0);
          const yearMonth = `${year}-${pad2(month)}`;
          const recordUnitId = String(value.unitId ?? "");
          const recordIndicatorId = String(value.indicatorId ?? "");
          const recordGroupId =
            indicators.find((indicator) => indicator.id === recordIndicatorId)
              ?.groupId ?? "";
          if (
            yearMonth < start ||
            yearMonth > end ||
            (unitId && recordUnitId !== unitId) ||
            (indicatorId && recordIndicatorId !== indicatorId) ||
            (groupId && recordGroupId !== groupId)
          )
            return;
          result.push({
            id: document.id,
            year,
            month,
            unitId: recordUnitId,
            indicatorId: recordIndicatorId,
            rate: typeof value.rate === "number" ? value.rate : null,
            reviewerEmpNo: String(value.reviewerEmpNo ?? value.reviewerId ?? ""),
            reviewerName: String(value.reviewerName ?? value.reviewerId ?? ""),
            reviewedPersonEmpNo: String(value.reviewedPersonEmpNo ?? ""),
            reviewedPersonName: String(value.reviewedPersonName ?? ""),
            submittedAt: value.submittedAt,
            answers: Array.isArray(value.answers)
              ? value.answers.map((raw) => {
                  const answer = (raw ?? {}) as Record<string, unknown>;
                  return {
                    questionId: String(answer.questionId ?? ""),
                    itemText: String(answer.itemText ?? ""),
                    optionLabel: String(answer.optionLabel ?? ""),
                    commonErrors: Array.isArray(answer.commonErrors)
                      ? answer.commonErrors.filter(
                          (word): word is string => typeof word === "string",
                        )
                      : [],
                    note: typeof answer.note === "string" ? answer.note : "",
                  };
                })
              : [],
          });
        });
      });
      result.sort(
        (a, b) =>
          b.year - a.year ||
          b.month - a.month ||
          a.unitId.localeCompare(b.unitId, "zh-Hant"),
      );
      setRows(result);
      setQueried(true);
    } catch (queryError) {
      setRows([]);
      setQueried(true);
      setError(
        `查詢失敗：${toErrorMessage(queryError)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  /** 修正：讀取該筆完整文件，開修正表單。 */
  const openEdit = async (row: ManagedResult) => {
    if (busy || editSaving) return;
    setEditLoading(true);
    setEditError("");
    setEditingId(row.id);
    try {
      const db = getFirebaseDb();
      const snap = await getDoc(doc(db, "reviewRecords", row.id));
      const value = (snap.data() ?? {}) as Record<string, unknown>;
      const answers = Array.isArray(value.answers)
        ? value.answers.map((raw) => {
            const a = (raw ?? {}) as Record<string, unknown>;
            return {
              questionId: String(a.questionId ?? ""),
              itemText: String(a.itemText ?? ""),
              optionLabel: String(a.optionLabel ?? ""),
              commonErrors: Array.isArray(a.commonErrors)
                ? a.commonErrors.filter((w): w is string => typeof w === "string")
                : [],
              note: typeof a.note === "string" ? a.note : "",
            };
          })
        : row.answers;
      setEditBase({
        rate: typeof value.rate === "number" ? value.rate : row.rate,
        quotaGroupId:
          typeof value.quotaGroupId === "string" ? value.quotaGroupId : undefined,
        version: typeof value.version === "number" ? value.version : undefined,
        editHistory: Array.isArray(value.editHistory)
          ? [...(value.editHistory as Record<string, unknown>[]) ]
          : [],
        answers,
      });
      setEditForm({
        answers: answers.map((a) => ({
          questionId: a.questionId,
          itemText: a.itemText,
          optionLabel: a.optionLabel,
          note: a.note,
        })),
        reviewedPersonEmpNo: String(value.reviewedPersonEmpNo ?? row.reviewedPersonEmpNo),
        reviewedPersonName: String(value.reviewedPersonName ?? row.reviewedPersonName),
        reviewerEmpNo: String(value.reviewerEmpNo ?? row.reviewerEmpNo),
        reviewerName: String(value.reviewerName ?? row.reviewerName),
        bedNo: typeof value.bedNo === "string" ? value.bedNo : "",
        auditItem: typeof value.auditItem === "string" ? value.auditItem : "",
        reviewDate: typeof value.reviewDate === "string" ? value.reviewDate : "",
      });
    } catch (e) {
      setEditError(`讀取紀錄失敗：${toErrorMessage(e)}`);
      setEditingId(null);
    } finally {
      setEditLoading(false);
    }
  };

  /** 修正存檔：依作答重算總分／正確率，寫回紀錄＋editHistory＋auditLogs。 */
  const saveEdit = async () => {
    if (!editingId || !editForm || !editBase || !user) return;
    const row = rows.find((r) => r.id === editingId);
    if (!row) return;
    const indicator = indicators.find((i) => i.id === row.indicatorId);
    const optionScore = (label: string): { score: number; excluded: boolean } =>
      label === "是"
        ? { score: 1, excluded: false }
        : label === "不適用"
          ? { score: 0, excluded: true }
          : { score: 0, excluded: false };
    const nextAnswers = editForm.answers.map((a, i) => {
      const base = editBase.answers[i] ?? {};
      const { score, excluded } = optionScore(a.optionLabel);
      return {
        questionId: a.questionId,
        itemText: a.itemText,
        optionLabel: a.optionLabel,
        score,
        excluded,
        note: a.note,
        commonErrors: Array.isArray(base.commonErrors) ? base.commonErrors : [],
        ...(Array.isArray((base as Record<string, unknown>).photoUrls)
          ? { photoUrls: (base as Record<string, unknown>).photoUrls as string[] }
          : {}),
      };
    });
    const { totalScore, maxScore, rate } = computeOptionSetScore(
      nextAnswers.map((a) => ({ score: a.score, excluded: a.excluded })),
    );
    const changes: Record<string, [string, string]> = {};
    editForm.answers.forEach((a, i) => {
      const base = editBase.answers[i];
      if (!base) return;
      if (a.optionLabel !== base.optionLabel)
        changes[a.itemText || `第 ${i + 1} 題`] = [base.optionLabel || "—", a.optionLabel];
      if (a.note !== (base.note ?? ""))
        changes[`${a.itemText || `第 ${i + 1} 題`}備註`] = [base.note ?? "", a.note];
    });
    if (editForm.reviewedPersonEmpNo !== row.reviewedPersonEmpNo)
      changes["受審人員職編"] = [row.reviewedPersonEmpNo, editForm.reviewedPersonEmpNo];
    if (editForm.reviewedPersonName !== row.reviewedPersonName)
      changes["受審人員姓名"] = [row.reviewedPersonName, editForm.reviewedPersonName];
    if (editForm.reviewerEmpNo !== row.reviewerEmpNo)
      changes["審查人員職編"] = [row.reviewerEmpNo, editForm.reviewerEmpNo];
    if (editForm.reviewerName !== row.reviewerName)
      changes["審查人員姓名"] = [row.reviewerName, editForm.reviewerName];
    if (Object.keys(changes).length === 0 && rate === editBase.rate) {
      setEditingId(null);
      setEditForm(null);
      setEditBase(null);
      return;
    }
    setEditSaving(true);
    setEditError("");
    try {
      const db = getFirebaseDb();
      const editHistory = [...editBase.editHistory.slice(-99)];
      editHistory.push({
        actorId: user.staffId,
        actorName: user.name,
        editedAt: new Date().toISOString(),
        changes,
      });
      const batch = writeBatch(db);
      batch.update(doc(db, "reviewRecords", editingId), {
        answers: nextAnswers,
        totalScore,
        maxScore,
        rate,
        reviewedPersonEmpNo: editForm.reviewedPersonEmpNo,
        reviewedPersonName: editForm.reviewedPersonName,
        reviewerEmpNo: editForm.reviewerEmpNo,
        reviewerName: editForm.reviewerName,
        bedNo: editForm.bedNo,
        auditItem: editForm.auditItem,
        reviewDate: editForm.reviewDate,
        ...(editBase.quotaGroupId
          ? { version: Number(editBase.version ?? 1) + 1 }
          : {}),
        editHistory,
        lastModifiedAt: serverTimestamp(),
        lastModifiedBy: user.staffId,
        lastModifiedByName: user.name,
      });
      batch.set(doc(collection(db, "auditLogs")), {
        actor: user.staffId,
        actorName: user.name,
        action: "修正審查結果",
        targetType: "reviewRecords",
        targetId: editingId,
        detail: `指標 ${indicator ? `${indicator.code}・${indicator.name}` : row.indicatorId}；${fmtYm(row.year, row.month)}；單位 ${unitName(row.unitId)}；正確率 ${editBase.rate == null ? "—" : `${editBase.rate}%`} → ${rate == null ? "—" : `${rate}%`}；更動：${Object.entries(changes).map(([k, v]) => `${k} ${v[0]} → ${v[1]}`).join("；") || "無"}`,
        before: { rate: editBase.rate },
        after: { rate },
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      setRows((current) =>
        current.map((r) =>
          r.id === editingId
            ? {
                ...r,
                rate,
                reviewedPersonEmpNo: editForm.reviewedPersonEmpNo,
                reviewedPersonName: editForm.reviewedPersonName,
                reviewerEmpNo: editForm.reviewerEmpNo,
                reviewerName: editForm.reviewerName,
                answers: nextAnswers.map((a) => ({
                  questionId: a.questionId,
                  itemText: a.itemText,
                  optionLabel: a.optionLabel,
                  commonErrors: a.commonErrors,
                  note: a.note,
                })),
              }
            : r,
        ),
      );
      onDone([row.year]);
      onAction(
        `已修正 1 筆審查結果，正確率 ${editBase.rate == null ? "—" : `${editBase.rate}%`} → ${rate == null ? "—" : `${rate}%`}。`,
      );
      setEditingId(null);
      setEditForm(null);
      setEditBase(null);
    } catch (e) {
      setEditError(`修正失敗：${toErrorMessage(e)}`);
    } finally {
      setEditSaving(false);
    }
  };

  const deleteSelected = async () => {
    if (busy || !user || selected.length === 0) return;
    const ids = [...selected];
    if (
      !window.confirm(
        `即將永久刪除 ${ids.length} 筆審查結果，且無法復原。確定刪除？`,
      )
    )
      return;
    setBusy(true);
    setError("");
    const removed: string[] = [];
    const affectedYears: number[] = [];
    try {
      const db = getFirebaseDb();
      for (let index = 0; index < ids.length; index += 400) {
        const chunk = ids.slice(index, index + 400);
        const batch = writeBatch(db);
        chunk.forEach((id) =>
          batch.delete(doc(db, "reviewRecords", id)),
        );
        const criteria = {
          unitId: unitId || null,
          groupId: groupId || null,
          indicatorId: indicatorId || null,
          startMonth: start,
          endMonth: end,
        };
        batch.set(doc(collection(db, "auditLogs")), {
          actor: user.staffId,
          actorName: user.name,
          action: "批次刪除審查結果",
          targetType: "reviewRecords",
          targetId: `${start}～${end}・${chunk.length} 筆`,
          detail: `篩選條件：單位 ${criteria.unitId ?? "全部"}；組別 ${criteria.groupId ?? "全部"}；指標 ${criteria.indicatorId ? stripInternalIdPrefix(criteria.indicatorId) : "全部"}；文件 ID：${chunk.join(", ")}`,
          criteria,
          documentIds: chunk,
          count: chunk.length,
          createdAt: serverTimestamp(),
        });
        await batch.commit();
        removed.push(...chunk);
        affectedYears.push(
          ...rows
            .filter((row) => chunk.includes(row.id))
            .map((row) => row.year),
        );
      }
      const years = [...new Set(affectedYears)];
      setRows((current) => current.filter((row) => !removed.includes(row.id)));
      setSelected([]);
      onDone(years);
      onAction(`已永久刪除 ${removed.length} 筆審查結果。`);
    } catch (deleteError) {
      const years = [
        ...new Set(
          rows
            .filter((row) => removed.includes(row.id))
            .map((row) => row.year),
        ),
      ];
      setRows((current) => current.filter((row) => !removed.includes(row.id)));
      setSelected((current) => current.filter((id) => !removed.includes(id)));
      if (removed.length > 0) onDone(years);
      const message = `刪除部分失敗：已成功刪除 ${removed.length} 筆，尚有 ${ids.length - removed.length} 筆未完成。${toErrorMessage(deleteError)}`;
      setError(message);
      onAction(message);
    } finally {
      setBusy(false);
    }
  };
  const allSelected = rows.length > 0 && rows.every((row) => selected.includes(row.id));

  return (
    <section className="review-results-manager">
      <FilterPanel
        actions={
          <button
            className="button button-primary"
            type="button"
            disabled={busy || start > end}
            onClick={queryResults}
          >
            <Search size={16} />
            搜尋
          </button>
        }
      >
        <SelectField
          label="組別"
          value={groupId}
          onChange={(value) => {
            setGroupId(value);
            setIndicatorId("");
          }}
          options={[
            { value: "", label: "全部組別" },
            ...Array.from(
              new Set(indicators.map((indicator) => indicator.groupId).filter(Boolean)),
            ).map((id) => ({
              value: id,
              label: groups.find((group) => group.id === id)?.name ?? id,
            })),
          ]}
        />
        <SelectField
          label="單位"
          value={unitId}
          onChange={setUnitId}
          options={[
            { value: "", label: "全部單位" },
            ...units.map((unit) => ({
              value: unit.code,
              label: `${unit.code}・${unit.name}`,
            })),
          ]}
        />
        <SearchableSelect
          label="指標名稱"
          value={indicatorId}
          onChange={setIndicatorId}
          options={[
            { value: "", label: "全部指標" },
            ...indicators
              .filter((indicator) => !groupId || indicator.groupId === groupId)
              .map((indicator) => ({
                value: indicator.id,
                label: `${indicator.code}・${indicator.name}`,
              })),
          ]}
          placeholder="輸入編號或名稱搜尋"
        />
        <ResultMonthPicker
          label="起始西元年月"
          value={start}
          onChange={setStart}
          ariaLabel="起始西元年月"
        />
        <ResultMonthPicker
          label="結束西元年月"
          value={end}
          onChange={setEnd}
          ariaLabel="結束西元年月"
        />
      </FilterPanel>
      {error && (
        <p className="results-range-error" role="alert">
          {error}
        </p>
      )}
      {editingId && (
        <section className="panel review-edit-panel" aria-label="修正審查結果">
          <h3>修正審查結果</h3>
          {editLoading || !editForm ? (
            <p className="settings-note">讀取紀錄中…</p>
          ) : (
            (() => {
              const row = rows.find((r) => r.id === editingId);
              const indicator = indicators.find((i) => i.id === row?.indicatorId);
              const qById = new Map((indicator?.questions ?? []).map((q) => [q.id, q]));
              const { rate: newRate } = computeOptionSetScore(
                editForm.answers.map((a) => ({
                  score: a.optionLabel === "是" ? 1 : 0,
                  excluded: a.optionLabel === "不適用",
                })),
              );
              return (
                <>
                  <p className="settings-note">
                    {row ? `${fmtYm(row.year, row.month)}・${unitName(row.unitId)}・${indicatorName(row.indicatorId)}` : ""}
                    ；指標、年月、單位依系統規則不可改。改完自動重算正確率：
                    {editBase?.rate == null ? "—" : `${editBase.rate}%`} →{" "}
                    {newRate == null ? "—" : `${newRate}%`}。
                  </p>
                  <div className="analysis-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>題目</th>
                          <th>作答</th>
                          <th>備註</th>
                        </tr>
                      </thead>
                      <tbody>
                        {editForm.answers.map((a, i) => {
                          const q = qById.get(a.questionId);
                          const labels = optionLabelsOf(asOptionSet(q?.optionSet));
                          return (
                            <tr key={`${a.questionId}-${i}`}>
                              <td>{a.itemText || `第 ${i + 1} 題`}</td>
                              <td>
                                <div className="select-wrap">
                                  <select
                                    value={a.optionLabel}
                                    aria-label={`${a.itemText || `第 ${i + 1} 題`}作答`}
                                    onChange={(e) =>
                                      setEditForm((f) =>
                                        f
                                          ? {
                                              ...f,
                                              answers: f.answers.map((x, j) =>
                                                j === i ? { ...x, optionLabel: e.target.value } : x,
                                              ),
                                            }
                                          : f,
                                      )
                                    }
                                  >
                                    {labels.map((label) => (
                                      <option key={label} value={label}>
                                        {label}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              </td>
                              <td>
                                <input
                                  type="text"
                                  value={a.note}
                                  aria-label={`${a.itemText || `第 ${i + 1} 題`}備註`}
                                  onChange={(e) =>
                                    setEditForm((f) =>
                                      f
                                        ? {
                                            ...f,
                                            answers: f.answers.map((x, j) =>
                                              j === i ? { ...x, note: e.target.value } : x,
                                            ),
                                          }
                                        : f,
                                    )
                                  }
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="review-edit-fields">
                    <label className="field-label">
                      受審人員職編
                      <input
                        type="text"
                        value={editForm.reviewedPersonEmpNo}
                        onChange={(e) =>
                          setEditForm((f) => (f ? { ...f, reviewedPersonEmpNo: e.target.value } : f))
                        }
                      />
                    </label>
                    <label className="field-label">
                      受審人員姓名
                      <input
                        type="text"
                        value={editForm.reviewedPersonName}
                        onChange={(e) =>
                          setEditForm((f) => (f ? { ...f, reviewedPersonName: e.target.value } : f))
                        }
                      />
                    </label>
                    <label className="field-label">
                      審查人員職編
                      <input
                        type="text"
                        value={editForm.reviewerEmpNo}
                        onChange={(e) =>
                          setEditForm((f) => (f ? { ...f, reviewerEmpNo: e.target.value } : f))
                        }
                      />
                    </label>
                    <label className="field-label">
                      審查人員姓名
                      <input
                        type="text"
                        value={editForm.reviewerName}
                        onChange={(e) =>
                          setEditForm((f) => (f ? { ...f, reviewerName: e.target.value } : f))
                        }
                      />
                    </label>
                    <label className="field-label">
                      床號
                      <input
                        type="text"
                        value={editForm.bedNo}
                        onChange={(e) =>
                          setEditForm((f) => (f ? { ...f, bedNo: e.target.value } : f))
                        }
                      />
                    </label>
                    <label className="field-label">
                      審核項目
                      <input
                        type="text"
                        value={editForm.auditItem}
                        onChange={(e) =>
                          setEditForm((f) => (f ? { ...f, auditItem: e.target.value } : f))
                        }
                      />
                    </label>
                    <label className="field-label">
                      審查日期
                      <input
                        type="date"
                        value={editForm.reviewDate}
                        onChange={(e) =>
                          setEditForm((f) => (f ? { ...f, reviewDate: e.target.value } : f))
                        }
                      />
                    </label>
                  </div>
                  {editError && (
                    <p className="results-range-error" role="alert">
                      {editError}
                    </p>
                  )}
                  <div className="review-edit-actions">
                    <button
                      type="button"
                      className="button button-primary"
                      disabled={editSaving}
                      onClick={saveEdit}
                    >
                      {editSaving ? "儲存中…" : "儲存修正"}
                    </button>
                    <button
                      type="button"
                      className="button button-ghost"
                      disabled={editSaving}
                      onClick={() => {
                        setEditingId(null);
                        setEditForm(null);
                        setEditBase(null);
                        setEditError("");
                      }}
                    >
                      取消
                    </button>
                  </div>
                </>
              );
            })()
          )}
        </section>
      )}
      {queried && (
        <ListPanel
          title="審查結果"
          count={rows.length}
          actions={
            <>
            {selected.length > 0 && (
              <span className="list-panel-count">已選 {selected.length} 筆</span>
            )}
            <button
              type="button"
              className="button button-outline"
              disabled={busy || rows.length === 0}
              onClick={() =>
                setSelected(allSelected ? [] : rows.map((row) => row.id))
              }
            >
              {allSelected ? "取消全選" : "全選"}
            </button>
            <button
              type="button"
              className="button button-danger"
              disabled={busy || selected.length === 0}
              onClick={deleteSelected}
            >
              {busy ? "處理中…" : `永久刪除所選（${selected.length}）`}
            </button>
            </>
          }
        >
          <div className="analysis-table-wrap review-results-table-wrap">
            <table className="review-results-table">
              <thead>
                <tr>
                  <th>選取</th>
                  <SortableTh label="結果日期" sortKey="date" sort={resultSort} onSort={toggleResultSort} />
                  <SortableTh label="單位" sortKey="unit" sort={resultSort} onSort={toggleResultSort} />
                  <SortableTh label="指標" sortKey="indicator" sort={resultSort} onSort={toggleResultSort} />
                  <SortableTh label="審查人員" sortKey="reviewer" sort={resultSort} onSort={toggleResultSort} />
                  <SortableTh label="被審人員" sortKey="reviewed" sort={resultSort} onSort={toggleResultSort} />
                  <SortableTh label="正確率" sortKey="rate" sort={resultSort} onSort={toggleResultSort} />
                  <SortableTh label="提交時間" sortKey="submitted" sort={resultSort} onSort={toggleResultSort} />
                  <th>明細</th>
                </tr>
              </thead>
              <tbody>
                {sortedResults.map((row) => {
                  const noted = row.answers.filter(
                    (a) => a.note.trim() !== "" || a.commonErrors.length > 0,
                  );
                  // v1.43.0：補充說明彙整為一則（單則為備註原文、多則每則附題號）
                  const mergedNote = mergeNoteParts(
                    row.answers.map((a, i) => ({
                      questionNo: i + 1,
                      note: a.note,
                    })),
                  );
                  const expanded = expandedId === row.id;
                  return (
                    <Fragment key={row.id}>
                      <tr>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`選取 ${fmtYm(row.year, row.month)} ${indicatorName(row.indicatorId)} ${row.reviewedPersonName || "審查結果"}`}
                            checked={selected.includes(row.id)}
                            disabled={busy}
                            onChange={(event) =>
                              setSelected((current) =>
                                event.target.checked
                                  ? [...current, row.id]
                                  : current.filter((id) => id !== row.id),
                              )
                            }
                          />
                        </td>
                        <td>
                          {fmtYm(row.year, row.month)}
                        </td>
                        <td>{unitName(row.unitId)}</td>
                        <td>{indicatorName(row.indicatorId)}</td>
                        <td>{staffLabel(row.reviewerEmpNo, row.reviewerName)}</td>
                        <td>{staffLabel(row.reviewedPersonEmpNo, row.reviewedPersonName)}</td>
                        <td>{row.rate == null ? "—" : `${row.rate}%`}</td>
                        <td>{formatSubmittedAt(row.submittedAt)}</td>
                        <td>
                          <button
                            type="button"
                            className="button button-ghost button-sm"
                            disabled={busy || editSaving}
                            onClick={() => openEdit(row)}
                          >
                            修正
                          </button>
                          {noted.length > 0 ? (
                            <button
                              type="button"
                              className="button button-ghost button-sm"
                              onClick={() =>
                                setExpandedId(expanded ? null : row.id)
                              }
                              aria-expanded={expanded}
                            >
                              {expanded ? "收合" : `明細（${noted.length}）`}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="review-record-expanded">
                          <td colSpan={9}>
                            <table className="data-table supp-note-table">
                              <thead>
                                <tr>
                                  <th>題目</th>
                                  <th>結果</th>
                                  <th>常見錯誤</th>
                                </tr>
                              </thead>
                              <tbody>
                                {noted.map((a, i) => (
                                  <tr key={`${a.questionId}-${i}`}>
                                    <td>{a.itemText || `第 ${i + 1} 題`}</td>
                                    <td>{a.optionLabel || "—"}</td>
                                    <td>
                                      {a.commonErrors.length > 0
                                        ? a.commonErrors.join("、")
                                        : "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {mergedNote ? (
                              <div className="supp-notes-block">
                                <p className="supp-notes-title">補充說明</p>
                                <p className="supp-note-text">{mergedNote}</p>
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="review-results-cards" aria-label="審查紀錄摘要清單">
            {rows.length === 0 && (
              <p className="review-results-empty">沒有符合條件的審查紀錄。</p>
            )}
            {sortedResults.map((row) => {
              const noted = row.answers.filter(
                (answer) => answer.note.trim() !== "" || answer.commonErrors.length > 0,
              );
              const mergedNote = mergeNoteParts(
                row.answers.map((answer, index) => ({
                  questionNo: index + 1,
                  note: answer.note,
                })),
              );
              const expanded = expandedId === row.id;
              return (
                <article className="review-result-card" key={row.id}>
                  <header>
                    <label className="review-result-card-select">
                      <input
                        type="checkbox"
                        aria-label={`選取 ${fmtYm(row.year, row.month)} ${indicatorName(row.indicatorId)} ${row.reviewedPersonName || "審查結果"}`}
                        checked={selected.includes(row.id)}
                        disabled={busy}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, row.id]
                              : current.filter((id) => id !== row.id),
                          )
                        }
                      />
                      <span>{fmtYm(row.year, row.month)}</span>
                    </label>
                    <strong>{row.rate == null ? "—" : `${row.rate}%`}</strong>
                  </header>
                  <h3>{indicatorName(row.indicatorId)}</h3>
                  <dl>
                    <div><dt>單位</dt><dd>{unitName(row.unitId)}</dd></div>
                    <div><dt>審查人員</dt><dd>{staffLabel(row.reviewerEmpNo, row.reviewerName)}</dd></div>
                    <div><dt>受審人員</dt><dd>{staffLabel(row.reviewedPersonEmpNo, row.reviewedPersonName)}</dd></div>
                    <div><dt>提交時間</dt><dd>{formatSubmittedAt(row.submittedAt)}</dd></div>
                  </dl>
                  <button
                    type="button"
                    className="button button-ghost button-sm"
                    disabled={busy || editSaving}
                    onClick={() => openEdit(row)}
                  >
                    修正
                  </button>
                  {noted.length > 0 && (
                    <>
                      <button
                        type="button"
                        className="button button-ghost button-sm review-result-card-detail-toggle"
                        onClick={() => setExpandedId(expanded ? null : row.id)}
                        aria-expanded={expanded}
                      >
                        {expanded ? "收合明細" : `查看明細與備註（${noted.length}）`}
                      </button>
                      {expanded && (
                        <div className="review-result-card-detail">
                          {noted.map((answer, index) => (
                            <div key={`${answer.questionId}-${index}`}>
                              <b>{answer.itemText || `第 ${index + 1} 題`}</b>
                              <span>
                                {answer.optionLabel || "—"}
                                {answer.commonErrors.length > 0
                                  ? ` · ${answer.commonErrors.join("、")}`
                                  : ""}
                              </span>
                            </div>
                          ))}
                          {mergedNote && <p><b>補充說明：</b>{mergedNote}</p>}
                        </div>
                      )}
                    </>
                  )}
                </article>
              );
            })}
          </div>
        </ListPanel>
      )}
      {!queried && (
        <EmptyState
          title="尚未搜尋"
          description="設定篩選條件後按「搜尋」讀取審查結果。"
        />
      )}
    </section>
  );
}

export function submittedMillis(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const t = value as { toDate?: () => Date; seconds?: number };
  if (typeof t.toDate === "function") return t.toDate().getTime();
  return typeof t.seconds === "number" ? t.seconds * 1000 : null;
}

export function formatSubmittedAt(value: unknown): string {
  // v1.88.15：走 ym.ts 共用函式（不補零）；非 Timestamp 回 "—"。
  return fmtTsDate(value);
}
