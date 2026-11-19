import type { UnitOpt, GroupOpt, IndicatorOpt } from "../model/types";
import { useState, useEffect, Fragment } from "react";
import { pad2, fmtYm, fmtTsDate } from "../../../lib/ym";
import { useTableSort, FilterPanel, ListPanel, SortableTh, EmptyState } from "../../../components/ui";
import { getFirebaseDb } from "../../../lib/firebase";
import { getDocsFromServer, query, collection, where, writeBatch, doc, serverTimestamp } from "../../../lib/db";
import { toErrorMessage } from "../../../lib/errors";
import { stripInternalIdPrefix } from "../../../lib/indicators";
import { Search } from "lucide-react";
import { SelectField, ResultMonthPicker } from "./small";
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
        <SelectField
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
