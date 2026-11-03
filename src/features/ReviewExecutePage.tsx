import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Pencil } from "lucide-react";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "../lib/db";
import { EmptyState, SectionTitle } from "../components/ui";
import { getFirebaseDb } from "../lib/firebase";
import { useAuth } from "../lib/auth";
import { maskName } from "../lib/mask";
import {
  normalizeQuestions,
  type AuditQuestion,
} from "../lib/indicators";
import {
  computeReviewScore,
  type ReviewAnswer,
} from "../lib/reviewRecords";
import {
  isTaskComplete,
  nextCaseSeq,
  progressLabel,
  requiredCases,
  reviewCaseDocId,
} from "../lib/reviewProgress";
import { todayStr, type ReviewTask } from "../lib/scheduling";

/**
 * 進入審查表單的方式（v1.11.0）：
 * - task：審查表單（逐件送出）；editRecordId 指定時為編輯既有單件
 * - records：查詢＝列出該單位該指標的逐件審查結果，每筆可編輯
 */
export type ExecuteTarget =
  | { mode: "task"; taskId: string; editRecordId?: string }
  | { mode: "records"; taskId: string };

interface TaskFull extends ReviewTask {
  id: string;
}

/** 該 task 的單件審查紀錄 */
interface CaseRecordRow {
  id: string;
  caseSeq: number | null;
  reviewDate: string;
  reviewerEmpNo: string;
  reviewerName: string;
  answers: ReviewAnswer[];
  totalScore: number;
  maxScore: number;
  rate: number | null;
  submittedAt: unknown;
  submittedBy: string;
}

interface PersonOption {
  staffId: string;
  name: string;
  status: string;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "讀寫失敗，請檢查網路連線後再試";
}

function ymLabel(year: number, month: number): string {
  return `${year} 年 ${month} 月`;
}

function fmtTs(ts: unknown): string {
  if (ts && typeof (ts as { toDate?: unknown }).toDate === "function") {
    try {
      return (ts as { toDate: () => Date })
        .toDate()
        .toLocaleString("zh-TW", { hour12: false });
    } catch {
      return "";
    }
  }
  return "";
}

function taskFromDoc(id: string, data: Record<string, unknown>): TaskFull {
  const cc = data.caseCount;
  return {
    id,
    indicatorId: String(data.indicatorId ?? ""),
    year: Number(data.year ?? 0),
    month: Number(data.month ?? 0),
    unitId: String(data.unitId ?? ""),
    reviewerId: String(data.reviewerId ?? ""),
    caseCount:
      typeof cc === "number" && Number.isInteger(cc) && cc >= 1 ? cc : null,
    deadline: String(data.deadline ?? ""),
    status: data.status === "done" ? "done" : "pending",
    completedAt: data.completedAt,
    createdAt: data.createdAt,
  };
}

export function ReviewExecutePage({
  target,
  onBack,
  onAction,
}: {
  target: ExecuteTarget;
  onBack: () => void;
  onAction: (message: string) => void;
}) {
  const { user } = useAuth();
  const staffId = user?.staffId ?? "";

  const [loading, setLoading] = useState(true);
  const [indicatorName, setIndicatorName] = useState("");
  const [questions, setQuestions] = useState<AuditQuestion[]>([]);
  const [task, setTask] = useState<TaskFull | null>(null);
  const [records, setRecords] = useState<CaseRecordRow[]>([]);
  const [loadError, setLoadError] = useState("");

  /** 逐件表單欄位（v1.11.0） */
  const [reviewDate, setReviewDate] = useState(todayStr());
  const [reviewerEmpNo, setReviewerEmpNo] = useState("");
  const [reviewerName, setReviewerName] = useState("");
  const [reviewerQuery, setReviewerQuery] = useState("");
  const [showSugg, setShowSugg] = useState(false);
  const [usersList, setUsersList] = useState<PersonOption[]>([]);

  /** questionId → 選中的選項 index */
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  /** 達應審件數後的完成狀態（留在表單顯示，可回儀表板） */
  const [allDone, setAllDone] = useState(false);
  /** records 模式下正在編輯的單件（null＝列表） */
  const [editingId, setEditingId] = useState<string | null>(null);

  const doneCount = records.length;

  /* ---------- 載入：該 task 的逐件紀錄 ---------- */
  const loadCaseRecords = useCallback(
    async (taskId: string): Promise<CaseRecordRow[]> => {
      const db = getFirebaseDb();
      const qsnap = await getDocs(
        query(collection(db, "reviewRecords"), where("taskId", "==", taskId)),
      );
      const rows: CaseRecordRow[] = [];
      qsnap.docs.forEach((d) => {
        const data = d.data() as Record<string, unknown>;
        const cs = data.caseSeq;
        rows.push({
          id: d.id,
          caseSeq: typeof cs === "number" ? cs : null,
          reviewDate: typeof data.reviewDate === "string" ? data.reviewDate : "",
          reviewerEmpNo:
            typeof data.reviewerEmpNo === "string" ? data.reviewerEmpNo : "",
          reviewerName:
            typeof data.reviewerName === "string" ? data.reviewerName : "",
          answers: Array.isArray(data.answers)
            ? (data.answers as ReviewAnswer[])
            : [],
          totalScore: Number(data.totalScore ?? 0),
          maxScore: Number(data.maxScore ?? 0),
          rate: typeof data.rate === "number" ? data.rate : null,
          submittedAt: data.submittedAt,
          submittedBy:
            typeof data.submittedBy === "string" ? data.submittedBy : "",
        });
      });
      // 舊格式單筆（caseSeq null）排最前，其餘按件次
      rows.sort((a, b) => (a.caseSeq ?? 0) - (b.caseSeq ?? 0));
      return rows;
    },
    [],
  );

  /* ---------- 單件答案預填（編輯用） ---------- */
  function prefillRecord(rec: CaseRecordRow, qs: AuditQuestion[]) {
    const next: Record<string, number> = {};
    rec.answers.forEach((a) => {
      const q = qs.find((x) => x.id === a.questionId);
      if (!q) return;
      let idx = q.options.findIndex((o) => o.label === a.optionLabel);
      if (idx < 0) idx = q.options.findIndex((o) => o.score === a.score);
      if (idx >= 0) next[q.id] = idx;
    });
    setAnswers(next);
    setReviewDate(rec.reviewDate || todayStr());
    setReviewerEmpNo(rec.reviewerEmpNo);
    setReviewerName(rec.reviewerName);
    setReviewerQuery("");
  }

  /* ---------- 初始載入 ---------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError("");
      try {
        const db = getFirebaseDb();
        // 人員清單（審查人員搜尋用）
        try {
          const psnap = await getDocs(collection(db, "users"));
          const list: PersonOption[] = [];
          psnap.docs.forEach((d) => {
            const data = d.data() as Record<string, unknown>;
            list.push({
              staffId: d.id,
              name: typeof data.name === "string" ? data.name : d.id,
              status: typeof data.status === "string" ? data.status : "",
            });
          });
          list.sort((a, b) => {
            const sa = a.status === "在職" ? 0 : 1;
            const sb = b.status === "在職" ? 0 : 1;
            return sa - sb || a.staffId.localeCompare(b.staffId);
          });
          if (!cancelled) setUsersList(list);
        } catch {
          /* 人員讀不到就只允許手填職編 */
        }
        // 任務
        const tsnap = await getDoc(doc(db, "reviewTasks", target.taskId));
        if (!tsnap.exists()) {
          if (!cancelled) setLoadError("找不到該審查任務。");
          return;
        }
        const t = taskFromDoc(tsnap.id, tsnap.data() as Record<string, unknown>);
        if (cancelled) return;
        // 指標＋題目
        const isnap = await getDoc(doc(db, "indicators", t.indicatorId));
        if (!isnap.exists()) {
          if (!cancelled) setLoadError("找不到該指標，可能已被刪除。");
          return;
        }
        const idata = isnap.data() as Record<string, unknown>;
        if (!cancelled) {
          setIndicatorName(
            typeof idata.name === "string" ? idata.name : t.indicatorId,
          );
        }
        const nq = normalizeQuestions(idata.questions);
        if (cancelled) return;
        setQuestions(nq.questions);
        setTask(t);
        // 逐件紀錄
        const recs = await loadCaseRecords(t.id);
        if (cancelled) return;
        setRecords(recs);
        // 預設審查人員＝登入者本人
        if (!cancelled && !reviewerEmpNo) {
          setReviewerEmpNo(staffId);
          setReviewerName(user?.name ?? "");
        }
        // 編輯指定單件 → 預填
        const editId =
          target.mode === "task" ? (target.editRecordId ?? null) : null;
        if (editId && !cancelled) {
          const rec = recs.find((r) => r.id === editId);
          if (rec) {
            prefillRecord(rec, nq.questions);
            setEditingId(editId);
          }
        }
        if (!cancelled) setAllDone(isTaskComplete(recs.length, t.caseCount));
      } catch (error) {
        if (!cancelled) setLoadError(`載入失敗：${toErrorMessage(error)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function chooseAnswer(qid: string, idx: number) {
    setAnswers((prev) => ({ ...prev, [qid]: idx }));
  }

  /* ---------- 審查人員搜尋 ---------- */
  const reviewerSugg = useMemo(() => {
    const q = reviewerQuery.trim();
    if (q === "") return [];
    return usersList
      .filter((u) => u.staffId.includes(q) || u.name.includes(q))
      .slice(0, 8);
  }, [reviewerQuery, usersList]);

  function selectReviewer(u: PersonOption) {
    setReviewerEmpNo(u.staffId);
    setReviewerName(u.name);
    setReviewerQuery("");
    setShowSugg(false);
  }

  /* ---------- 送出（逐件新增 or 單件更新） ---------- */
  async function handleSubmit() {
    if (!task) return;
    const firstMissing = questions.find((q) => answers[q.id] == null);
    if (firstMissing) {
      onAction(`第 ${questions.indexOf(firstMissing) + 1} 題尚未作答`);
      document
        .getElementById(`req-q-${firstMissing.id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (!reviewerEmpNo.trim()) {
      onAction("請填寫審查人員職編");
      return;
    }
    setSubmitting(true);
    try {
      const db = getFirebaseDb();
      const answerList: ReviewAnswer[] = questions.map((q) => {
        const opt = q.options[answers[q.id]];
        return {
          questionId: q.id,
          itemText: q.itemText,
          optionLabel: opt.label,
          score: opt.score,
        };
      });
      const { totalScore, maxScore, rate } = computeReviewScore(
        questions.map((q) => {
          const opt = q.options[answers[q.id]];
          return {
            score: opt.score,
            maxOptionScore: Math.max(...q.options.map((o) => o.score)),
          };
        }),
      );
      const editId =
        target.mode === "task" ? (target.editRecordId ?? editingId) : editingId;
      if (editId) {
        // 單件更新：不增加件數
        await updateDoc(doc(db, "reviewRecords", editId), {
          answers: answerList,
          totalScore,
          maxScore,
          rate,
          reviewDate,
          reviewerEmpNo: reviewerEmpNo.trim(),
          reviewerName: reviewerName.trim(),
        });
        const recs = await loadCaseRecords(task.id);
        setRecords(recs);
        onAction(`已更新審查結果${rate != null ? `，正確率 ${rate}%` : ""}`);
        if (target.mode === "records") {
          setEditingId(null); // 回到查詢列表
        } else {
          onBack();
        }
      } else {
        // 逐件新增
        const seq = nextCaseSeq(records.length);
        const taskId = task.id;
        await setDoc(doc(db, "reviewRecords", reviewCaseDocId(taskId, seq)), {
          taskId,
          indicatorId: task.indicatorId,
          unitId: task.unitId,
          reviewerId: task.reviewerId,
          year: task.year,
          month: task.month,
          caseSeq: seq,
          reviewDate,
          reviewerEmpNo: reviewerEmpNo.trim(),
          reviewerName: reviewerName.trim(),
          answers: answerList,
          totalScore,
          maxScore,
          rate,
          submittedAt: serverTimestamp(),
          submittedBy: staffId,
        });
        const req = requiredCases(task.caseCount);
        if (isTaskComplete(seq, task.caseCount)) {
          await updateDoc(doc(db, "reviewTasks", taskId), {
            status: "done",
            completedAt: serverTimestamp(),
          });
          setAllDone(true);
        }
        setRecords(await loadCaseRecords(taskId));
        setAnswers({}); // 清空答案，保留日期／人員，繼續下一件
        onAction(
          `已送出第 ${seq} 件（共需 ${req} 件）${rate != null ? `，正確率 ${rate}%` : ""}`,
        );
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } catch (error) {
      onAction(`送出失敗：${toErrorMessage(error)}`);
    } finally {
      setSubmitting(false);
    }
  }

  /* ---------- 畫面 ---------- */
  if (loading) {
    return (
      <section className="panel">
        <p className="settings-note">讀取審查表單中…</p>
      </section>
    );
  }
  if (loadError || !task) {
    return (
      <>
        <div style={{ marginBottom: 12 }}>
          <button className="button button-outline" onClick={onBack}>
            <ArrowLeft size={15} /> 返回儀表板
          </button>
        </div>
        <EmptyState title="無法開啟審查表" description={loadError || "任務資料異常。"} />
      </>
    );
  }

  const isRecordsView = target.mode === "records" && !editingId;

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <button className="button button-outline" onClick={onBack}>
          <ArrowLeft size={15} /> 返回儀表板
        </button>
      </div>
      <SectionTitle
        title={`${isRecordsView ? "審查結果查詢" : "審查表單"}：${indicatorName}`}
        note={`${ymLabel(task.year, task.month)}・${task.unitId}・已完成 ${progressLabel(doneCount, task.caseCount)} 件`}
      />

      {isRecordsView ? (
        /* ============ 查詢：逐件審查結果列表 ============ */
        <section className="panel">
          {records.length === 0 ? (
            <p className="settings-note">尚無審查紀錄。</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>件次</th>
                    <th>審查日期</th>
                    <th>審查人員</th>
                    <th>得分／正確率</th>
                    <th>送出時間</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {r.caseSeq != null ? `第 ${r.caseSeq} 件` : "既有紀錄"}
                      </td>
                      <td>{r.reviewDate || "—"}</td>
                      <td>
                        {r.reviewerEmpNo
                          ? `${r.reviewerEmpNo}／${maskName(r.reviewerName || r.reviewerEmpNo)}`
                          : "—"}
                      </td>
                      <td>
                        {r.totalScore}/{r.maxScore}
                        {r.rate != null ? `（${r.rate}%）` : ""}
                      </td>
                      <td>{fmtTs(r.submittedAt) || "—"}</td>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => {
                            prefillRecord(r, questions);
                            setEditingId(r.id);
                          }}
                        >
                          <Pencil size={13} style={{ verticalAlign: "-2px" }} />{" "}
                          編輯
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : (
        /* ============ 審查表單（逐件） ============ */
        <>
          {editingId && (
            <p className="dup-note">
              正在編輯單件審查結果，送出後僅更新該筆，不增加件數。
            </p>
          )}
          {allDone && !editingId && (
            <section className="panel" style={{ borderColor: "#9fd4c8" }}>
              <p style={{ margin: 0 }}>
                <b>✅ 本單位審查已完成</b>
                <span className="muted-text">
                  （{progressLabel(doneCount, task.caseCount)} 件）
                </span>
              </p>
              <div className="form-actions" style={{ marginTop: 12 }}>
                <button className="button button-primary" onClick={onBack}>
                  返回儀表板
                </button>
              </div>
            </section>
          )}

          <section className="panel">
            <div className="form-grid">
              <div className="form-field">
                <label className="field-label">指標名稱</label>
                <p>
                  <b>{indicatorName}</b>
                </p>
              </div>
              <div className="form-field">
                <label className="field-label">受審單位</label>
                <p>
                  <b>{task.unitId}</b>
                  <span className="muted-text">（已鎖定）</span>
                </p>
              </div>
              <div className="form-field">
                <label className="field-label">審查日期</label>
                <input
                  type="date"
                  className="text-input"
                  value={reviewDate}
                  onChange={(e) => setReviewDate(e.target.value)}
                  aria-label="審查日期"
                />
              </div>
              <div className="form-field" style={{ position: "relative" }}>
                <label className="field-label">審查人員（職編）</label>
                {reviewerEmpNo ? (
                  <p style={{ margin: "12px 0" }}>
                    <b>
                      {reviewerEmpNo}／{maskName(reviewerName || reviewerEmpNo)}
                    </b>{" "}
                    <button
                      className="text-button"
                      onClick={() => {
                        setReviewerEmpNo("");
                        setReviewerName("");
                        setReviewerQuery("");
                        setShowSugg(true);
                      }}
                    >
                      更換
                    </button>
                  </p>
                ) : (
                  <>
                    <input
                      type="text"
                      className="text-input"
                      placeholder="輸入職編或姓名搜尋"
                      value={reviewerQuery}
                      onChange={(e) => {
                        setReviewerQuery(e.target.value);
                        setShowSugg(true);
                      }}
                      onFocus={() => setShowSugg(true)}
                      aria-label="審查人員搜尋"
                    />
                    {showSugg && reviewerSugg.length > 0 && (
                      <ul className="sugg-list">
                        {reviewerSugg.map((u) => (
                          <li key={u.staffId}>
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => selectReviewer(u)}
                            >
                              {u.staffId}／{maskName(u.name)}
                              {u.status && u.status !== "在職" && (
                                <span className="muted-text">（{u.status}）</span>
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            </div>
          </section>

          {questions.length === 0 ? (
            <EmptyState
              title="該指標尚未建立審查題目"
              description="請先至「指標管理」→ 該指標 →「審核表」頁籤建立題目後再回來填寫。"
            />
          ) : (
            <>
              {/* 題目：桌機/平板一題一行；手機堆疊（v1.11.0） */}
              <section className="panel">
                {questions.map((q, qi) => {
                  const sel = answers[q.id];
                  const missing = sel == null;
                  return (
                    <div
                      key={q.id}
                      id={`req-q-${q.id}`}
                      className="review-qrow"
                    >
                      <div className="q-group">{q.groupName || ""}</div>
                      <div className="q-text">
                        <b>
                          {qi + 1}. {q.itemText || `（第 ${qi + 1} 題）`}
                        </b>
                        {missing && (
                          <span
                            className="status-pill warning"
                            style={{ marginLeft: 8 }}
                          >
                            尚未作答
                          </span>
                        )}
                      </div>
                      <div
                        className="radio-group"
                        role="radiogroup"
                        aria-label={q.itemText}
                      >
                        {q.options.map((o, oi) => (
                          <label
                            key={oi}
                            className={`check-row${sel === oi ? " checked" : ""}`}
                          >
                            <input
                              type="radio"
                              name={`q-${q.id}`}
                              checked={sel === oi}
                              onChange={() => chooseAnswer(q.id, oi)}
                            />
                            <span>
                              {o.label}
                              {!o.label.includes(String(o.score)) && (
                                <span className="muted-text">
                                  {" "}
                                  （{o.score} 分）
                                </span>
                              )}
                            </span>
                          </label>
                        ))}
                      </div>
                      <div className="q-guidance">
                        {q.guidance.trim() !== "" && (
                          <details className="guidance-details">
                            <summary>指引</summary>
                            <p style={{ whiteSpace: "pre-wrap" }}>
                              {q.guidance}
                            </p>
                          </details>
                        )}
                      </div>
                    </div>
                  );
                })}
              </section>

              <div className="form-actions" style={{ marginBottom: 24 }}>
                <button
                  className="button button-primary"
                  disabled={submitting}
                  onClick={handleSubmit}
                >
                  <Check size={15} />{" "}
                  {submitting
                    ? "送出中…"
                    : editingId
                      ? "更新審查結果"
                      : `送出第 ${nextCaseSeq(doneCount)} 件`}
                </button>
                <button className="button button-ghost" onClick={onBack}>
                  取消返回
                </button>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
