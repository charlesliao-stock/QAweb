/**
 * 品管審查排程頁（v1.16.0 重寫）。
 * 三類別排程（年度／學年度／臨時）：一列＝一支指標＋一個類別（當期），
 * 含「尚無排程」列以便建立；操作＝產生排程／加審／查閱；自審（護理長）。
 * 排程讀寫一律走 src/lib/scheduling.ts 的新模型（indicatorSchedules），
 * 稽核由 lib 內自動寫入。
 */
import { ArrowLeft } from "lucide-react";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { stripInternalIdPrefix } from "../lib/indicators";
import { ScheduleDetailPage } from "./ScheduleDetailPage";
import { type View } from "./schedule/model/types";
import { ScheduleEditor } from "./schedule/components/ScheduleEditor";
import { AssignmentEditor } from "./schedule/components/AssignmentEditor";
import type { SchedulePageProps } from "./schedule/model/pageProps";
import { useScheduleCtx } from "./schedule/hooks/useScheduleCtx";
import { ScheduleListView } from "./schedule/views/ScheduleListView";
export { type PickerOption } from "./schedule/components/pickers";
export { schedulePillState, mergeItemsWithUnits, mergeItemsUnlimited, assignmentPillState, previewTempTaskCount, defaultPeriodForStatsCycle, defaultSelfAuditReviewers, defaultAddAuditReviewers } from "./schedule/model/pure";

export function SchedulePage(props: SchedulePageProps) {
  const ctx = useScheduleCtx(props);
  const { view, canEdit, groupMap, rows, myUnitCode, assignments, units, reviewersByGroup, scheduleRestrictedUnits, unitNameOf, actor, schedules, onAction, usersMap, indicatorOf, backToList, reviewerRoleIds, inactiveIds, scheduleScopeUnits, user } = ctx;

  // ================= 主畫面 =================
  if (view.kind === "list") {
    return (
      <ScheduleListView ctx={ctx} />
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
