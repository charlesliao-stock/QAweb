/**
 * 執行幹事儀表板頁籤（v1.15.0）：全院進度落後紅黃燈、逾期鎖定清單、
 * 解鎖待辦（核准／駁回）。
 */
import { useMemo, useState } from "react";
import { doc, serverTimestamp, updateDoc } from "../../lib/db";
import { getFirebaseDb } from "../../lib/firebase";
import { SectionTitle } from "../../components/ui";
import { lagLights, taskProgressLabel } from "../../lib/dashboardStats";
import {
  DEFAULT_DASHBOARD_SECTIONS,
  type DashboardSections,
} from "../../lib/dashboardSections";
import { displayUnitCode, staffLabel } from "../../lib/mask";
import { useStaffNameMap } from "../../lib/useStaffNames";
import { todayStr } from "../../lib/scheduling";
import type { DashboardData } from "./useDashboardData";

export function OfficerTab({
  data,
  staffId,
  onAction,
  sections = DEFAULT_DASHBOARD_SECTIONS,
}: {
  data: DashboardData;
  staffId: string;
  onAction: (message: string) => void;
  /** v1.28 階段 2：顯示設定旗標（預設落後燈號／鎖定清單／解鎖審核全留） */
  sections?: DashboardSections;
}) {
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;
  const [busyId, setBusyId] = useState("");
  /** v1.50.0：審查員顯示職編/遮罩姓名（users 走共用快取） */
  const staffNames = useStaffNameMap();

  const lags = useMemo(
    () =>
      lagLights(
        data.tasks.filter((t) => t.year === curYear && t.month === curMonth),
        todayStr(),
      ),
    [data, curYear, curMonth],
  );

  const locked = useMemo(
    () => data.tasks.filter((t) => t.status === "locked"),
    [data],
  );

  async function handleUnlock(id: string, taskId: string, approve: boolean) {
    setBusyId(id);
    try {
      const db = getFirebaseDb();
      await updateDoc(doc(db, "unlockRequests", id), {
        status: approve ? "approved" : "rejected",
        handledBy: staffId,
        handledAt: serverTimestamp(),
      });
      if (approve) {
        await updateDoc(doc(db, "reviewTasks", taskId), {
          status: "pending",
        });
      }
      onAction(approve ? "已核准解鎖，任務回到待完成" : "已駁回解鎖申請");
      data.reload();
    } catch {
      onAction("處理失敗，請稍後再試");
    } finally {
      setBusyId("");
    }
  }

  return (
    <>
      {sections.lagLights && (
        <section className="panel">
          <SectionTitle
            title="全院進度落後預警"
            note="截止日 5 天內：完成度＜50% 紅燈、＜80% 黃燈"
          />
        {data.loading ? (
          <p className="settings-note">讀取中…</p>
        ) : lags.length === 0 ? (
          <p className="settings-note">目前無即將到期的落後任務。</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th></th>
                  <th>指標名稱</th>
                  <th>審查單位</th>
                  <th>審查員</th>
                  <th>完成/應審件數</th>
                  <th>截止日期</th>
                </tr>
              </thead>
              <tbody>
                {lags.map(({ task: t, pct, level }) => (
                  <tr key={t.id}>
                    <td>
                      <span
                        className={`status-pill${level === "red" ? " danger" : " warning"}`}
                      >
                        {level === "red" ? "紅" : "黃"}・
                        {Math.round(pct * 100)}%
                      </span>
                    </td>
                    <td>
                      {data.indicatorMap.get(t.indicatorId) ?? t.indicatorId}
                    </td>
                    <td>{displayUnitCode(t.unitId)}</td>
                    <td>{staffLabel(t.reviewerId, staffNames.get(t.reviewerId) ?? "")}</td>
                    <td>{taskProgressLabel(t)}</td>
                    <td>{t.deadline}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </section>
      )}

      {sections.overdueLocked && (
        <section className="panel">
          <SectionTitle
            title="逾期鎖定清單"
            note={`共 ${locked.length} 筆`}
          />
        {locked.length === 0 ? (
          <p className="settings-note">目前無鎖定任務。</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>年月</th>
                  <th>指標名稱</th>
                  <th>審查單位</th>
                  <th>完成/應審件數</th>
                  <th>截止日期</th>
                </tr>
              </thead>
              <tbody>
                {locked.map((t) => (
                  <tr key={t.id}>
                    <td>
                      {t.year}/{String(t.month).padStart(2, "0")}
                    </td>
                    <td>
                      {data.indicatorMap.get(t.indicatorId) ?? t.indicatorId}
                    </td>
                    <td>{displayUnitCode(t.unitId)}</td>
                    {/* v1.28 階段 2：補紀錄超過上限者進度未知，顯示「—」而非錯誤的 0 */}
                    <td>
                      {taskProgressLabel(t)}
                    </td>
                    <td>{t.deadline}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </section>
      )}

      {sections.unlockReview && (
        <section className="panel">
          <SectionTitle
            title="解鎖待辦"
            note={`共 ${data.unlockPending.length} 筆待審核`}
          />
        {data.unlockPending.length === 0 ? (
          <p className="settings-note">目前無待審核的解鎖申請。</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>年月</th>
                  <th>指標名稱</th>
                  <th>審查單位</th>
                  <th>申請人</th>
                  <th>原因</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.unlockPending.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.year}/{String(u.month).padStart(2, "0")}
                    </td>
                    <td>
                      {data.indicatorMap.get(u.indicatorId) ?? u.indicatorId}
                    </td>
                    <td>{displayUnitCode(u.unitId)}</td>
                    <td>
                      {staffLabel(u.requestedBy, u.requestedByName ?? "")}
                    </td>
                    <td style={{ maxWidth: 240 }}>{u.reason}</td>
                    <td>
                      <button
                        className="text-button"
                        disabled={busyId === u.id}
                        onClick={() => void handleUnlock(u.id, u.taskId, true)}
                      >
                        核准
                      </button>{" "}
                      <button
                        className="text-button"
                        disabled={busyId === u.id}
                        onClick={() => void handleUnlock(u.id, u.taskId, false)}
                      >
                        駁回
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </section>
      )}
    </>
  );
}
