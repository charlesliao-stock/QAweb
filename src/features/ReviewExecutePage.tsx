import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, ChevronDown } from "lucide-react";
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
  mergeQuestionGroups,
  normalizeQuestions,
  type AuditQuestion,
  type QuestionGroup,
} from "../lib/indicators";
import {
  computeReviewScore,
  reviewRecordDocId,
  type ReviewAnswer,
} from "../lib/reviewRecords";
import type { ReviewTask } from "../lib/scheduling";

/** 進入審查表單的兩種方式 */
export type ExecuteTarget =
  | { mode: "task"; taskId: string }
  | { mode: "indicator"; indicatorId: string; year: number; month: number };

interface TaskFull extends ReviewTask {
  id: string;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "讀寫失敗，請檢查網路連線後再試";
}

function ymLabel(year: number, month: number): string {
  return `${year} 年 ${month} 月`;
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
  const [groups, setGroups] = useState<QuestionGroup[]>([]);
  const [useGroups, setUseGroups] = useState(false);

  const [task, setTask] = useState<TaskFull | null>(null);
  const [myTasks, setMyTasks] = useState<TaskFull[]>([]);
  const [unitNames, setUnitNames] = useState<Map<string, string>>(new Map());
  const [existingRate, setExistingRate] = useState<number | null>(null);
  const [existingAt, setExistingAt] = useState<string>("");

  /** questionId → 選中的選項 index */
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState("");

  const unitName = (code: string) => unitNames.get(code) ?? code;

  /* ---------- 載入指標＋題目 ---------- */
  const loadIndicator = useCallback(
    async (id: string) => {
      const db = getFirebaseDb();
      const snap = await getDoc(doc(db, "indicators", id));
      if (!snap.exists()) {
        setLoadError("找不到該指標，可能已被刪除。");
        return false;
      }
      const data = snap.data();
      setIndicatorName(typeof data.name === "string" ? data.name : id);
      const nq = normalizeQuestions(data.questions);
      setQuestions(nq.questions);
      setGroups(mergeQuestionGroups(data.questionGroups, nq.groups));
      setUseGroups(
        typeof data.useQuestionGroups === "boolean"
          ? data.useQuestionGroups
          : nq.useGroups,
      );
      return true;
    },
    [],
  );

  const loadUnits = useCallback(async () => {
    try {
      const db = getFirebaseDb();
      const usnap = await getDocs(collection(db, "units"));
      const m = new Map<string, string>();
      usnap.docs.forEach((d) => {
        const n = d.data().name;
        m.set(d.id, typeof n === "string" ? n : d.id);
      });
      setUnitNames(m);
    } catch {
      /* 單位名稱讀不到就顯示代碼 */
    }
  }, []);

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

  /* ---------- 載入既有審查紀錄（預帶答案） ---------- */
  const loadRecord = useCallback(
    async (taskId: string, qs: AuditQuestion[]) => {
      setExistingRate(null);
      setExistingAt("");
      setAnswers({});
      try {
        const db = getFirebaseDb();
        const snap = await getDoc(
          doc(db, "reviewRecords", reviewRecordDocId(taskId)),
        );
        if (!snap.exists()) return;
        const data = snap.data();
        const saved: unknown = data.answers;
        if (!Array.isArray(saved)) return;
        const next: Record<string, number> = {};
        saved.forEach((a) => {
          const r = (a ?? {}) as Record<string, unknown>;
          const qid = typeof r.questionId === "string" ? r.questionId : "";
          const q = qs.find((x) => x.id === qid);
          if (!q) return;
          const label = typeof r.optionLabel === "string" ? r.optionLabel : "";
          let idx = q.options.findIndex((o) => o.label === label);
          if (idx < 0) {
            const sc = Number(r.score);
            idx = q.options.findIndex((o) => o.score === sc);
          }
          if (idx >= 0) next[qid] = idx;
        });
        setAnswers(next);
        const rt = data.rate;
        setExistingRate(typeof rt === "number" ? rt : null);
        const at = data.submittedAt;
        setExistingAt(
          at && typeof at.toDate === "function"
            ? (at.toDate() as Date).toLocaleString("zh-TW", {
                hour12: false,
              })
            : "",
        );
      } catch {
        /* 讀不到舊紀錄就當作新填 */
      }
    },
    [],
  );

  /* ---------- 初始載入 ---------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError("");
      try {
        await loadUnits();
        const db = getFirebaseDb();
        if (target.mode === "task") {
          const tsnap = await getDoc(doc(db, "reviewTasks", target.taskId));
          if (!tsnap.exists()) {
            if (!cancelled) setLoadError("找不到該審查任務。");
            return;
          }
          const t = taskFromDoc(
            tsnap.id,
            tsnap.data() as Record<string, unknown>,
          );
          if (cancelled) return;
          const ok = await loadIndicator(t.indicatorId);
          if (!ok || cancelled) return;
          setTask(t);
          setMyTasks([t]);
          // 題目載入後再讀舊紀錄（需 questions 做選項對應）
          const isnap = await getDoc(doc(db, "indicators", t.indicatorId));
          const nq = normalizeQuestions(
            (isnap.data() as Record<string, unknown> | undefined)?.questions,
          );
          if (!cancelled) await loadRecord(t.id, nq.questions);
        } else {
          const ok = await loadIndicator(target.indicatorId);
          if (!ok || cancelled) return;
          // 該審查員本月該指標的任務 → 單位選單
          const tsnap = await getDocs(
            query(
              collection(db, "reviewTasks"),
              where("reviewerId", "==", staffId),
            ),
          );
          const list: TaskFull[] = [];
          tsnap.docs.forEach((d) => {
            const data = d.data() as Record<string, unknown>;
            if (
              data.indicatorId === target.indicatorId &&
              Number(data.year) === target.year &&
              Number(data.month) === target.month
            ) {
              list.push(taskFromDoc(d.id, data));
            }
          });
          if (cancelled) return;
          if (list.length === 0) {
            setLoadError("本月您在此指標下沒有審查任務。");
            return;
          }
          // 預設：第一個待完成單位，否則第一個
          list.sort((a, b) => a.unitId.localeCompare(b.unitId, "zh-Hant"));
          const first =
            list.find((t) => t.status !== "done") ?? list[0];
          setMyTasks(list);
          setTask(first);
          const isnap = await getDoc(
            doc(db, "indicators", target.indicatorId),
          );
          const nq = normalizeQuestions(
            (isnap.data() as Record<string, unknown> | undefined)?.questions,
          );
          if (!cancelled) await loadRecord(first.id, nq.questions);
        }
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

  /* ---------- 指標模式：切換單位 ---------- */
  async function switchUnit(unitId: string) {
    const t = myTasks.find((x) => x.unitId === unitId);
    if (!t) return;
    setTask(t);
    await loadRecord(t.id, questions);
  }

  /* ---------- 分組顯示 ---------- */
  const grouped = useMemo(() => {
    if (!useGroups || groups.length === 0)
      return [{ groupId: null as string | null, groupName: "", list: questions }];
    const ordered = [...groups].sort((a, b) => a.order - b.order);
    const result: { groupId: string | null; groupName: string; list: AuditQuestion[] }[] = [];
    const ungrouped = questions.filter((q) => q.groupId == null);
    if (ungrouped.length > 0)
      result.push({ groupId: null, groupName: "", list: ungrouped });
    ordered.forEach((g) => {
      const list = questions.filter((q) => q.groupId === g.id);
      if (list.length > 0)
        result.push({ groupId: g.id, groupName: g.name, list });
    });
    // 分組表沒有但題目有引用的（容錯）
    const known = new Set(result.flatMap((r) => r.list.map((q) => q.id)));
    const rest = questions.filter((q) => !known.has(q.id));
    if (rest.length > 0)
      result.push({ groupId: "__other", groupName: "其他", list: rest });
    return result;
  }, [questions, groups, useGroups]);

  function chooseAnswer(qid: string, idx: number) {
    setAnswers((prev) => ({ ...prev, [qid]: idx }));
  }

  /* ---------- 送出 ---------- */
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
      const taskId = task.id;
      await setDoc(doc(db, "reviewRecords", reviewRecordDocId(taskId)), {
        taskId,
        indicatorId: task.indicatorId,
        unitId: task.unitId,
        reviewerId: task.reviewerId,
        year: task.year,
        month: task.month,
        answers: answerList,
        totalScore,
        maxScore,
        rate,
        submittedAt: serverTimestamp(),
        submittedBy: staffId,
      });
      await updateDoc(doc(db, "reviewTasks", taskId), {
        status: "done",
        completedAt: serverTimestamp(),
      });
      onAction(
        `審查表已送出（${unitName(task.unitId)}）${rate != null ? `，正確率 ${rate}%` : ""}`,
      );
      onBack();
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

  const unitOptions = [...new Map(myTasks.map((t) => [t.unitId, t])).values()];

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <button className="button button-outline" onClick={onBack}>
          <ArrowLeft size={15} /> 返回儀表板
        </button>
      </div>
      <SectionTitle
        title={`審查表單：${indicatorName}`}
        note={`${ymLabel(task.year, task.month)}・審查員 ${maskName(user?.name ?? staffId)}${existingRate != null ? `・上次正確率 ${existingRate}%` : ""}`}
      />

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
            {target.mode === "task" ? (
              <p>
                <b>{unitName(task.unitId)}</b>
                <span className="muted-text">（已鎖定）</span>
              </p>
            ) : (
              <div className="select-wrap" style={{ maxWidth: 280 }}>
                <select
                  value={task.unitId}
                  onChange={(e) => void switchUnit(e.target.value)}
                  aria-label="選擇受審單位"
                >
                  {unitOptions.map((t) => (
                    <option key={t.unitId} value={t.unitId}>
                      {unitName(t.unitId)}
                      {t.status === "done" ? "（已完成）" : ""}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
            )}
          </div>
          <div className="form-field">
            <label className="field-label">審查年月</label>
            <p>
              <b>{ymLabel(task.year, task.month)}</b>
            </p>
          </div>
          <div className="form-field">
            <label className="field-label">審查員</label>
            <p>
              <b>{maskName(user?.name ?? staffId)}</b>
              <span className="muted-text">（{staffId}）</span>
            </p>
          </div>
        </div>
        {existingRate != null && (
          <p className="dup-note">
            此單位已有審查紀錄{existingAt ? `（${existingAt}）` : ""}，重新送出將更新紀錄。
          </p>
        )}
      </section>

      {questions.length === 0 ? (
        <EmptyState
          title="該指標尚未建立審查題目"
          description="請先至「指標管理」→ 該指標 →「審核表」頁籤建立題目後再回來填寫。"
        />
      ) : (
        <>
          {grouped.map((g, gi) => (
            <section className="panel" key={g.groupId ?? `g${gi}`}>
              {g.groupName && (
                <SectionTitle title={g.groupName} note={`${g.list.length} 題`} />
              )}
              {g.list.map((q, qi) => {
                const sel = answers[q.id];
                const missing = sel == null;
                return (
                  <div
                    key={q.id}
                    id={`req-q-${q.id}`}
                    className="question-card"
                    style={{ marginBottom: 14 }}
                  >
                    <div className="question-head">
                      <b>{q.itemText || `（第 ${qi + 1} 題）`}</b>
                      {missing && (
                        <span className="status-pill warning">尚未作答</span>
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
                    {q.guidance.trim() !== "" && (
                      <details className="guidance-details">
                        <summary>審核指引</summary>
                        <p style={{ whiteSpace: "pre-wrap" }}>{q.guidance}</p>
                      </details>
                    )}
                  </div>
                );
              })}
            </section>
          ))}

          <div className="form-actions" style={{ marginBottom: 24 }}>
            <button
              className="button button-primary"
              disabled={submitting}
              onClick={handleSubmit}
            >
              <Check size={15} />{" "}
              {submitting ? "送出中…" : existingRate != null ? "更新審查結果" : "送出審查結果"}
            </button>
            <button className="button button-ghost" onClick={onBack}>
              取消返回
            </button>
          </div>
        </>
      )}
    </>
  );
}
