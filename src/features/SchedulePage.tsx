import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Plus, Trash2, X } from "lucide-react";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "../lib/db";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { getFirebaseDb } from "../lib/firebase";
import { useAuth } from "../lib/auth";
import { maskName } from "../lib/mask";

type ScheduleStatus = "排程中" | "進行中" | "已完成";

const STATUSES: ScheduleStatus[] = ["排程中", "進行中", "已完成"];

interface ScheduleRow {
  id: string;
  indicatorId: string;
  indicatorName: string;
  yearMonth: string;
  assigneeStaffId: string;
  assigneeName: string;
  dueDate: string;
  status: ScheduleStatus;
  note: string;
}

interface IndicatorOption {
  id: string;
  name: string;
}

interface StaffOption {
  staffId: string;
  name: string;
}

function todayStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function isOverdue(row: ScheduleRow): boolean {
  return row.status !== "已完成" && row.dueDate < todayStr();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "讀寫失敗，請檢查網路連線後再試";
}

export function SchedulePage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  const { user } = useAuth();
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [indicators, setIndicators] = useState<IndicatorOption[]>([]);
  const [staffList, setStaffList] = useState<StaffOption[]>([]);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const [indicatorId, setIndicatorId] = useState("");
  const [yearMonth, setYearMonth] = useState("");
  const [assigneeStaffId, setAssigneeStaffId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [status, setStatus] = useState<ScheduleStatus>("排程中");
  const [note, setNote] = useState("");

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const db = getFirebaseDb();
      const [ssnap, isnap, usnap] = await Promise.all([
        getDocs(
          query(collection(db, "schedules"), orderBy("dueDate", "asc"), limit(200)),
        ),
        getDocs(collection(db, "indicators")),
        getDocs(collection(db, "users")).catch(() => null),
      ]);
      setRows(
        ssnap.docs.map((d) => {
          const data = d.data();
          const st =
            typeof data.status === "string" &&
            (STATUSES as string[]).includes(data.status)
              ? (data.status as ScheduleStatus)
              : "排程中";
          return {
            id: d.id,
            indicatorId: typeof data.indicatorId === "string" ? data.indicatorId : "",
            indicatorName:
              typeof data.indicatorName === "string" ? data.indicatorName : "",
            yearMonth: typeof data.yearMonth === "string" ? data.yearMonth : "",
            assigneeStaffId:
              typeof data.assigneeStaffId === "string" ? data.assigneeStaffId : "",
            assigneeName:
              typeof data.assigneeName === "string" ? data.assigneeName : "",
            dueDate: typeof data.dueDate === "string" ? data.dueDate : "",
            status: st,
            note: typeof data.note === "string" ? data.note : "",
          };
        }),
      );
      setIndicators(
        isnap.docs
          .map((d) => {
            const data = d.data();
            return {
              id: d.id,
              name: typeof data.name === "string" ? data.name : d.id,
            };
          })
          .sort((a, b) => a.id.localeCompare(b.id, "zh-Hant")),
      );
      if (usnap) {
        setStaffList(
          usnap.docs
            .map((d) => {
              const data = d.data();
              return {
                staffId: d.id,
                name: typeof data.name === "string" ? data.name : d.id,
              };
            })
            .sort((a, b) => a.staffId.localeCompare(b.staffId)),
        );
      }
    } catch (error) {
      onAction(`讀取排程失敗：${toErrorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, [onAction]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  function resetForm() {
    setIndicatorId("");
    setYearMonth("");
    setAssigneeStaffId("");
    setDueDate("");
    setStatus("排程中");
    setNote("");
    setFormError("");
  }

  async function handleCreate() {
    if (!indicatorId) {
      setFormError("請選擇審查指標");
      return;
    }
    if (!yearMonth) {
      setFormError("請選擇審查月份");
      return;
    }
    if (!assigneeStaffId) {
      setFormError("請選擇負責人");
      return;
    }
    if (!dueDate) {
      setFormError("請選擇截止日期");
      return;
    }
    if (!user) {
      setFormError("請先登入");
      return;
    }
    setFormError("");
    setSaving(true);
    try {
      const db = getFirebaseDb();
      const ind = indicators.find((i) => i.id === indicatorId);
      const staff = staffList.find((s) => s.staffId === assigneeStaffId);
      await setDoc(doc(collection(db, "schedules")), {
        indicatorId,
        indicatorName: ind?.name ?? indicatorId,
        yearMonth,
        assigneeStaffId,
        assigneeName: staff?.name ?? "",
        dueDate,
        status,
        note: note.trim(),
        createdAt: serverTimestamp(),
        createdBy: user.staffId,
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      });
      onAction("已建立審查排程");
      resetForm();
      setShowForm(false);
      await loadAll();
    } catch (error) {
      setFormError(`建立失敗：${toErrorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleComplete(id: string) {
    if (!user) return;
    try {
      await updateDoc(doc(getFirebaseDb(), "schedules", id), {
        status: "已完成",
        updatedAt: serverTimestamp(),
        updatedBy: user.staffId,
      });
      onAction("排程已標記完成");
      await loadAll();
    } catch (error) {
      onAction(`更新失敗：${toErrorMessage(error)}`);
    }
  }

  async function handleDelete(id: string) {
    const ok = window.confirm("確定刪除這筆排程？（不會刪除指標本身）");
    if (!ok) return;
    try {
      await deleteDoc(doc(getFirebaseDb(), "schedules", id));
      onAction("已刪除排程");
      await loadAll();
    } catch (error) {
      onAction(`刪除失敗：${toErrorMessage(error)}`);
    }
  }

  const overdue = rows.filter(isOverdue);

  return (
    <>
      <PageHeading
        page="schedule"
        action={
          <button
            className="button button-primary"
            onClick={() => {
              resetForm();
              setShowForm((v) => !v);
            }}
          >
            {showForm ? <X size={15} /> : <Plus size={16} />}
            {showForm ? "取消" : "建立排程"}
          </button>
        }
      />

      {overdue.length > 0 && (
        <section className="panel data-panel">
          <SectionTitle
            title="逾期項目"
            note={`${overdue.length} 筆已超過截止日期且未完成`}
          />
          <div className="table-scroll">
            <table className="permission-table">
              <thead>
                <tr>
                  <th>指標</th>
                  <th>審查月份</th>
                  <th>負責人</th>
                  <th>截止日期</th>
                  <th>狀態</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {overdue.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <b>{r.indicatorName}</b>
                    </td>
                    <td>{r.yearMonth}</td>
                    <td>
                      {r.assigneeName
                        ? `${maskName(r.assigneeName)}（${r.assigneeStaffId}）`
                        : r.assigneeStaffId}
                    </td>
                    <td>
                      <span className="status-pill danger">{r.dueDate}</span>
                    </td>
                    <td>{r.status}</td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => handleComplete(r.id)}
                      >
                        <Check size={13} /> 標記完成
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {showForm && (
        <section className="panel data-panel">
          <SectionTitle title="建立審查排程" note="任務指派：指定指標、月份與負責人" />
          {formError && <div className="login-error">{formError}</div>}
          <div className="form-grid">
            <div className="form-field">
              <label className="field-label">審查指標 *</label>
              <div className="select-wrap">
                <select
                  value={indicatorId}
                  onChange={(e) => setIndicatorId(e.target.value)}
                >
                  <option value="">請選擇指標</option>
                  {indicators.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.id} {i.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
            <div className="form-field">
              <label className="field-label">審查月份 *</label>
              <input
                className="text-input"
                type="month"
                value={yearMonth}
                onChange={(e) => setYearMonth(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label className="field-label">負責人 *</label>
              <div className="select-wrap">
                <select
                  value={assigneeStaffId}
                  onChange={(e) => setAssigneeStaffId(e.target.value)}
                >
                  <option value="">請選擇人員</option>
                  {staffList.map((s) => (
                    <option key={s.staffId} value={s.staffId}>
                      {maskName(s.name)}（{s.staffId}）
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
              {staffList.length === 0 && (
                <p className="settings-note">
                  人員清單載入失敗（可能無查詢權限），請確認帳號角色後重試。
                </p>
              )}
            </div>
            <div className="form-field">
              <label className="field-label">截止日期 *</label>
              <input
                className="text-input"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label className="field-label">狀態</label>
              <div className="select-wrap">
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as ScheduleStatus)}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
            <div className="form-field" style={{ gridColumn: "1 / -1" }}>
              <label className="field-label">備註</label>
              <input
                className="text-input"
                value={note}
                placeholder="例如：本月重點查核急診給藥流程"
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </div>
          <div className="form-actions">
            <button
              className="button button-primary"
              disabled={saving}
              onClick={handleCreate}
            >
              {saving ? "建立中…" : "建立排程"}
            </button>
            <button
              className="button button-outline"
              onClick={() => {
                resetForm();
                setShowForm(false);
              }}
            >
              取消
            </button>
          </div>
        </section>
      )}

      <section className="panel data-panel">
        <SectionTitle title="排程清單" note="依截止日期排序" />
        {loading ? (
          <p className="settings-note">讀取中…</p>
        ) : rows.length === 0 ? (
          <EmptyState
            title="尚無排程"
            description="使用右上角「建立排程」指派第一筆審查任務。"
          />
        ) : (
          <div className="table-scroll">
            <table className="permission-table">
              <thead>
                <tr>
                  <th>指標</th>
                  <th>審查月份</th>
                  <th>負責人</th>
                  <th>截止日期</th>
                  <th>狀態</th>
                  <th>備註</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <b>{r.indicatorName}</b>
                    </td>
                    <td>{r.yearMonth}</td>
                    <td>
                      {r.assigneeName
                        ? `${maskName(r.assigneeName)}（${r.assigneeStaffId}）`
                        : r.assigneeStaffId}
                    </td>
                    <td>
                      {isOverdue(r) ? (
                        <span className="status-pill danger">{r.dueDate}</span>
                      ) : (
                        r.dueDate
                      )}
                    </td>
                    <td>
                      <span
                        className={`status-pill ${
                          r.status === "已完成"
                            ? "success"
                            : r.status === "進行中"
                              ? "info"
                              : "muted"
                        }`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td>{r.note || "—"}</td>
                    <td>
                      {r.status !== "已完成" && (
                        <button
                          className="text-button"
                          onClick={() => handleComplete(r.id)}
                        >
                          <Check size={13} /> 完成
                        </button>
                      )}{" "}
                      <button
                        className="text-button"
                        onClick={() => handleDelete(r.id)}
                      >
                        <Trash2 size={13} /> 刪除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
