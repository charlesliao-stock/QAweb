/**
 * 品管審查排程頁（v1.16.0 重寫）。
 * 三類別排程（年度／學年度／臨時）：一列＝一支指標＋一個類別（當期），
 * 含「尚無排程」列以便建立；操作＝產生排程／加審／查閱；自審（護理長）。
 * 排程讀寫一律走 src/lib/scheduling.ts 的新模型（indicatorSchedules），
 * 稽核由 lib 內自動寫入。
 */
import { ArrowLeft, CalendarPlus, CircleCheck, CircleDashed, Eye, Plus, Trash2 } from "lucide-react";
import { EmptyState, FilterPanel, FilterSearchField, ListPanel, PageHeading, SectionTitle, SortableTh, FormSelect } from "../components/ui";
import { stripInternalIdPrefix } from "../lib/indicators";
import { assignmentItemInvolvesUnit, scheduleInvolvesUnit } from "../lib/dataScope";
import { ScheduleDetailPage } from "./ScheduleDetailPage";
import { categoryLabel, periodLabel } from "../lib/cycle";
import { YEAR_FILTER_OPTIONS, yearOptionLabel } from "../lib/scheduling";
import { fmtTsDate } from "../lib/ym";
import { type View } from "./schedule/model/types";
import { PILL_OK, PILL_NONE, schedulePillState } from "./schedule/model/pure";
import { ScheduleEditor } from "./schedule/components/ScheduleEditor";
import { SelfAuditDialog } from "./schedule/components/SelfAuditDialog";
import { AssignmentEditor } from "./schedule/components/AssignmentEditor";
import { AddAuditDialog } from "./schedule/components/AddAuditDialog";
import { useScheduleState } from "./schedule/hooks/useScheduleState";
import { useScheduleScope } from "./schedule/hooks/useScheduleScope";
import { useScheduleData } from "./schedule/hooks/useScheduleData";
import { useScheduleRows } from "./schedule/hooks/useScheduleRows";
import type { SchedulePageProps } from "./schedule/model/pageProps";
export { type PickerOption } from "./schedule/components/pickers";
export { schedulePillState, mergeItemsWithUnits, mergeItemsUnlimited, assignmentPillState, previewTempTaskCount, defaultPeriodForStatsCycle, defaultSelfAuditReviewers, defaultAddAuditReviewers } from "./schedule/model/pure";

export function SchedulePage(props: SchedulePageProps) {
  const { onAction } = props;
  const s0 = useScheduleState();
  const { users, user, units, myUnitCode, indicators, queried, filterYear, statsCycle, filterGroup, filterIndicator, filterKeyword, groupMap, schedules, showTemp, assignments, canEdit, setView, actor, deadlineDay, view, isHeadNurse, setSelfAuditOpen, setFilterGroup, setFilterIndicator, setFilterKeyword, setFilterYear, setShowTemp, loading, generatingKey, setAddAuditRow, addAuditRow, reviewersByGroup, selfAuditOpen } = s0;
  const s1 = useScheduleScope(s0);
  const { isUnitScheduler, unitNameOf, scheduleRestrictedUnits, usersMap, indicatorOf, reviewerRoleIds, inactiveIds, scheduleScopeUnits } = s1;
  const s2 = useScheduleData(props, { ...s0, ...s1 });
  const { loadData } = s2;
  const s3 = useScheduleRows(props, { ...s0, ...s1, ...s2 });
  const { indicatorOptions, rows, rowSort, toggleRowSort, compact, sortedRows, taskCountsFor, tempCountByIndicator, cycle, period, handleGenerate, canDeleteRow, handleDeleteSchedule, myUnitName, myUnitUsers, backToList } = s3;

  // ================= 主畫面 =================
  if (view.kind === "list") {
    return (
      <>
        <PageHeading
          page="schedule"
          action={
            isHeadNurse && canEdit ? (
              <button
                className="button button-outline"
                onClick={() => setSelfAuditOpen(true)}
              >
                <Plus size={15} /> 新增自審
              </button>
            ) : undefined
          }
        />
        <FilterPanel
          actions={
            (filterGroup || filterIndicator || filterKeyword) && (
              <button
                type="button"
                className="button button-outline"
                onClick={() => {
                  setFilterGroup("");
                  setFilterIndicator("");
                  setFilterKeyword("");
                }}
              >
                清除篩選
              </button>
            )
          }
        >
            <FormSelect label="年份" value={filterYear}
                  onChange={(e) => setFilterYear(Number(e.target.value))}>
                  {YEAR_FILTER_OPTIONS.map((y) => (
                    <option key={y} value={y}>
                      {yearOptionLabel(y)}
                    </option>
                  ))}
                </FormSelect>
            <FormSelect label="年別" value={statsCycle}
                  disabled
                  title="年別跟隨系統管理「統計週期」設定">
                  <option value="year">年度</option>
                  <option value="academic">學年度</option>
                </FormSelect>
            <div className="form-field">
              <label className="field-label">&nbsp;</label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={showTemp}
                  onChange={(e) => setShowTemp(e.target.checked)}
                />
                <span>顯示加審</span>
              </label>
            </div>
            <FormSelect label="組別篩選" value={filterGroup}
                  onChange={(e) => {
                    const g = e.target.value;
                    setFilterGroup(g);
                    // 組別切換後，已選指標若不在該組別內則重置
                    if (filterIndicator && g) {
                      const ind = indicators.find(
                        (i) => i.id === filterIndicator,
                      );
                      if (!ind || ind.groupId !== g) setFilterIndicator("");
                    }
                  }}>
                  <option value="">全部組別</option>
                  {[...groupMap.entries()].map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </FormSelect>
            <FormSelect label="指標篩選" value={filterIndicator}
                  onChange={(e) => setFilterIndicator(e.target.value)}>
                  <option value="">全部指標</option>
                  {indicatorOptions.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}（{i.id}）
                    </option>
                  ))}
                </FormSelect>
            <FilterSearchField
              label="指標關鍵字"
              placeholder="搜尋指標名稱或編號"
              value={filterKeyword}
              onChange={setFilterKeyword}
              onSearch={() => void loadData()}
              disabled={loading}
            />
        </FilterPanel>
        <p className="settings-note">
          年別跟隨系統管理「統計週期」設定（年度＝1–12 月；學年度＝8 月制，8
          月～隔年 7 月）。清單只列出已啟用的指標。
        </p>

        {!queried ? (
          <EmptyState
            title="請先查詢"
            description="設定年份與篩選條件後，按上方「查詢」載入排程資料。"
          />
        ) : loading ? (
          <section className="panel">
            <p className="settings-note">讀取中…</p>
          </section>
        ) : rows.length === 0 ? (
          <EmptyState
            title="尚無指標"
            description="請先到「指標管理」建立指標，再回來設定排程。"
          />
        ) : (
          <ListPanel title="排程清單" count={rows.length}>
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableTh label="組別" sortKey="group" sort={rowSort} onSort={toggleRowSort} />
                    {compact ? (
                      <SortableTh label="編號／指標名稱" sortKey="code" sort={rowSort} onSort={toggleRowSort} />
                    ) : (
                      <>
                        <SortableTh label="年別" sortKey="year" sort={rowSort} onSort={toggleRowSort} />
                        <SortableTh label="指標編號" sortKey="code" sort={rowSort} onSort={toggleRowSort} />
                        <SortableTh label="指標名稱" sortKey="name" sort={rowSort} onSort={toggleRowSort} />
                      </>
                    )}
                    <th>排程/單位設定</th>
                    <th>審查員/單位設定</th>
                    <th>操作</th>
                    <SortableTh label="最後編輯" sortKey="updated" sort={rowSort} onSort={toggleRowSort} />
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((r) => {
                    const sched = r.schedule;
                    // v1.88.5：單位排程者的 pill 只反映自己單位的設定狀態。
                    const schedDone =
                      schedulePillState(sched) === "done" &&
                      (!isUnitScheduler ||
                        !sched ||
                        scheduleInvolvesUnit(sched, myUnitCode));
                    const asg = assignments.get(r.indicatorId);
                    const asgOwnItems = (
                      isUnitScheduler && myUnitCode
                        ? (asg?.items ?? []).filter((it) =>
                            assignmentItemInvolvesUnit(it, myUnitCode),
                          )
                        : (asg?.items ?? [])
                    );
                    const asgDone = asgOwnItems.length > 0;
                    const { pending, done } = taskCountsFor(r);
                    const hasTasks = pending + done > 0;
                    // v1.18：產生排程需兩邊設定都完成（排程／單位設定：
                    // 單位≥1、月份≥1、件數>0；審查員／單位設定：分工表≥1 筆）
                    const canGenerate =
                      canEdit && !!sched && schedDone && asgDone;
                    const isTemp = r.category === "temp";
                    const tempCount =
                      tempCountByIndicator.get(r.indicatorId) ?? 0;
                    return (
                      <tr key={r.key}>
                        <td>{r.groupName}</td>
                        {compact ? (
                          <td>
                            <div className="muted-text">
                              {isTemp && (
                                <>
                                  {sched?.selfReview ? (
                                    <span className="status-pill info">自審</span>
                                  ) : (
                                    <span className="status-pill danger">加審</span>
                                  )}{" "}
                                </>
                              )}
                              {r.code}
                            </div>
                            <div>
                              <b>{r.name}</b>
                            </div>
                          </td>
                        ) : (
                          <>
                            <td>
                              {isTemp ? (
                                sched?.selfReview ? (
                                  <span className="status-pill info">自審</span>
                                ) : (
                                  <span className="status-pill danger">加審</span>
                                )
                              ) : (
                                <>
                                  {categoryLabel(r.category)}
                                  <div className="muted-text">
                                    {periodLabel(r.category, r.period)}
                                  </div>
                                </>
                              )}
                            </td>
                            <td className="muted-text">{r.code}</td>
                            <td>
                              <b>{r.name}</b>
                            </td>
                          </>
                        )}
                        <td>
                          {isTemp ? (
                            <span className={schedDone ? PILL_OK : PILL_NONE}>
                              {schedDone ? (
                                <>
                                  <CircleCheck size={13} /> 已排
                                </>
                              ) : (
                                <>
                                  <CircleDashed size={13} /> 未排
                                </>
                              )}
                            </span>
                          ) : (
                            <button
                              className="text-button"
                              onClick={() =>
                                setView({
                                  kind: "schedule",
                                  indicatorId: r.indicatorId,
                                  category: r.category as "year" | "academic",
                                  year: filterYear,
                                })
                              }
                              title={
                                sched
                                  ? "編輯排程設定"
                                  : "建立排程設定"
                              }
                            >
                              <span
                                className={schedDone ? PILL_OK : PILL_NONE}
                              >
                                {schedDone ? (
                                  <>
                                    <CircleCheck size={13} /> 已排
                                  </>
                                ) : (
                                  <>
                                    <CircleDashed size={13} /> 未排
                                  </>
                                )}
                              </span>
                            </button>
                          )}
                        </td>
                        <td>
                          <button
                            className="text-button"
                            onClick={() =>
                              setView({
                                kind: "assignment",
                                indicatorId: r.indicatorId,
                                // v1.88.13：帶入當前篩選期別（年別＋週期鍵），
                                // 分工表的單位與月份以該期「排程／單位設定」為準。
                                category: cycle,
                                period,
                              })
                            }
                            title="進入單位／審查員設定"
                          >
                            <span className={asgDone ? PILL_OK : PILL_NONE}>
                              {asgDone ? (
                                <>
                                  <CircleCheck size={13} /> 已排
                                </>
                              ) : (
                                <>
                                  <CircleDashed size={13} /> 未排
                                </>
                              )}
                            </span>
                          </button>
                          {asgDone && (
                            <div className="muted-text">
                              {asgOwnItems.length} 位審查員・
                              {asgOwnItems.reduce(
                                (n, it) => n + it.units.length,
                                0,
                              )}{" "}
                              單位
                              {asgOwnItems.some(
                                (it) => it.unlimitedUnits === true,
                              ) && "（含不限單位）"}
                            </div>
                          )}
                        </td>
                        <td>
                          <div
                            style={{
                              display: "flex",
                              gap: 10,
                              alignItems: "flex-start",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: 2,
                              }}
                            >
                              {!!sched && !isTemp && (
                                <>
                                  <button
                                    className="button button-outline button-sm"
                                    disabled={
                                      !canGenerate || generatingKey === r.key
                                    }
                                    title={
                                      !canEdit
                                        ? "需排程建立／改派權限"
                                        : !schedDone
                                          ? "請先完成排程／單位設定（單位、月份、件數皆需設定）"
                                          : !asgDone
                                            ? "請先完成審查員／單位設定（分工表至少一筆）"
                                            : "依排程展開審查任務"
                                    }
                                    onClick={() => handleGenerate(r)}
                                  >
                                    <CalendarPlus size={14} />{" "}
                                    {generatingKey === r.key
                                      ? "產生中…"
                                      : "產生排程"}
                                  </button>
                                  <span
                                    className={hasTasks ? PILL_OK : PILL_NONE}
                                  >
                                    {hasTasks ? (
                                      <>
                                        <CircleCheck size={13} /> 已排程
                                      </>
                                    ) : (
                                      <>
                                        <CircleDashed size={13} /> 未排程
                                      </>
                                    )}
                                  </span>
                                </>
                              )}
                            </div>
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: 2,
                              }}
                            >
                              {!isTemp && canEdit && (
                                <>
                                  <button
                                    className="button button-outline button-sm"
                                    onClick={() => setAddAuditRow(r)}
                                    title="建立臨時加審排程"
                                  >
                                    <Plus size={14} /> 加審
                                  </button>
                                  <div className="muted-text">
                                    加審 {tempCount} 筆
                                  </div>
                                </>
                              )}
                            </div>
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: 2,
                              }}
                            >
                              {!!sched && (
                                <button
                                  className="button button-outline button-sm"
                                  onClick={() =>
                                    setView({
                                      kind: "detail",
                                      indicatorId: r.indicatorId,
                                      category: r.category,
                                      period: r.period,
                                    })
                                  }
                                  title="查閱設定內容"
                                >
                                  <Eye size={14} /> 查閱
                                </button>
                              )}
                            </div>
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: 2,
                              }}
                            >
                              {!!sched && canDeleteRow(r) && (
                                <button
                                  className="button button-outline button-sm"
                                  onClick={() => handleDeleteSchedule(r)}
                                  title="刪除此排程（含其未完成任務；已完成任務與審查紀錄保留）"
                                >
                                  <Trash2 size={14} /> 刪除
                                </button>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="muted-text">
                          {sched ? (
                            <>
                              {sched.updatedByName || "—"}
                              <br />
                              {fmtTsDate(sched.updatedAt)}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
          </ListPanel>
        )}

        {addAuditRow && (
          <AddAuditDialog
            row={addAuditRow}
            units={units}
            users={users}
            groupMap={groupMap}
            reviewersByGroup={reviewersByGroup}
            assignment={assignments.get(addAuditRow.indicatorId) ?? null}
            restrictedUnitCodes={scheduleRestrictedUnits}
            restrictedUnitName={unitNameOf(myUnitCode)}
            actor={actor}
            deadlineDay={deadlineDay}
            filterYear={filterYear}
            cycle={cycle}
            existingTemps={schedules.filter(
              (s) =>
                s.indicatorId === addAuditRow.indicatorId &&
                s.category === "temp",
            )}
            onAction={onAction}
            onClose={() => setAddAuditRow(null)}
            onDone={() => {
              setAddAuditRow(null);
              loadData();
            }}
          />
        )}
        {selfAuditOpen && (
          <SelfAuditDialog
            indicators={indicators}
            userUnitCode={myUnitCode}
            userUnitName={myUnitName}
            unitUsers={myUnitUsers}
            usersMap={usersMap}
            actor={actor}
            deadlineDay={deadlineDay}
            onAction={onAction}
            onClose={() => setSelfAuditOpen(false)}
            onDone={() => {
              setSelfAuditOpen(false);
              loadData();
            }}
          />
        )}
      </>
    );
  }

  // ================= 子畫面 =================
  const subView = view as Exclude<View, { kind: "list" }>;
  const indicator = indicatorOf(subView.indicatorId);
  // v1.88.6：查閱整頁式的列（指標＋類別＋週期鍵定位；找不到即顯示「找不到排程」）
  const detailRow =
    view.kind === "detail"
      ? (rows.find(
          (r) =>
            r.indicatorId === view.indicatorId &&
            r.category === view.category &&
            r.period === view.period,
        ) ?? null)
      : null;
  // v1.88.13：分工表期別上下文——該期「排程／單位設定」（單位與月份來源）；
  // 無該期排程時為 null（單位與月份選項為空，提示先完成排程／單位設定）。
  const assignmentSchedule =
    view.kind === "assignment"
      ? (schedules.find(
          (s) =>
            s.indicatorId === subView.indicatorId &&
            s.category === view.category &&
            s.period === view.period,
        ) ?? null)
      : null;
  return (
    <>
      <PageHeading page="schedule" />
      {!indicator ? (
        <EmptyState title="找不到指標" description="該指標可能已被刪除。" />
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <button className="button button-outline" onClick={backToList}>
              <ArrowLeft size={15} /> 返回品管審查排程
            </button>
          </div>
          <SectionTitle
            title={indicator.name}
            note={`指標編號 ${stripInternalIdPrefix(indicator.id)}・組別 ${groupMap.get(indicator.groupId) ?? "—"}`}
          />
          {view.kind === "schedule" && (
            <ScheduleEditor
              indicatorId={indicator.id}
              indicatorName={indicator.name}
              category={view.category}
              initialYear={view.year}
              units={units}
              groupMap={groupMap}
              restrictedUnitCodes={scheduleRestrictedUnits}
              restrictedUnitName={unitNameOf(myUnitCode)}
              canEdit={canEdit}
              actor={actor}
              onAction={onAction}
              onSaved={backToList}
            />
          )}
          {view.kind === "assignment" && (
            <AssignmentEditor
              indicatorId={indicator.id}
              indicatorCode={indicator.code}
              schedule={assignmentSchedule}
              reviewersByGroup={reviewersByGroup}
              units={units}
              groupMap={groupMap}
              usersMap={usersMap}
              reviewerRoleIds={reviewerRoleIds}
              inactiveIds={inactiveIds}
              initial={assignments.get(indicator.id) ?? null}
              restrictedUnitCodes={scheduleRestrictedUnits}
              restrictedUnitName={unitNameOf(myUnitCode)}
              canEdit={canEdit}
              onAction={onAction}
              onSaved={backToList}
            />
          )}
          {view.kind === "detail" &&
            (detailRow && detailRow.schedule ? (
              <ScheduleDetailPage
                row={detailRow}
                assignment={assignments.get(detailRow.indicatorId) ?? null}
                usersMap={usersMap}
                unitNameOf={unitNameOf}
                visibleUnitCodes={scheduleScopeUnits}
                viewerStaffId={user?.staffId ?? ""}
                onAction={onAction}
              />
            ) : (
              <EmptyState
                title="找不到排程"
                description="該排程可能已被刪除，或尚未建立。"
              />
            ))}
        </>
      )}
    </>
  );
}
