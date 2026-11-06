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
import { getCachedRefCollection } from "../lib/refCache";
import { getDocsCacheFirst } from "../lib/cacheFirst";
import { useAuth } from "../lib/auth";
import { maskName } from "../lib/mask";
import {
  indicatorCodeOf,
  normalizeQuestions,
  optionLabelsOf,
  type AuditQuestion,
} from "../lib/indicators";
import { ReviewQuestionList } from "./ReviewQuestionList";
import { computeOptionSetScore, type ReviewAnswer } from "../lib/reviewRecords";
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
  reviewedPersonEmpNo: string;
  reviewedPersonName: string;
  bedNo: string;
  auditItem?: string;
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
  unitCode: string;
}

/** 解鎖申請列 */
interface UnlockRow {
  id: string;
  status: string;
  reason: string;
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
  const st = String(data.status ?? "pending");
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
    status: st === "done" ? "done" : st === "locked" ? "locked" : "pending",
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
  /** 該指標是否開啟題目分組顯示（v1.22：關閉時不顯示分組名） */
  const [showQuestionGroups, setShowQuestionGroups] = useState(false);
  const [requireBedNo, setRequireBedNo] = useState(false);
  /** 需要受審人員資料（v1.17）：false 時隱藏「職編」欄位；缺值視為 true（相容舊資料） */
  const [requireReviewee, setRequireReviewee] = useState(true);
  const [questions, setQuestions] = useState<AuditQuestion[]>([]);
  const [auditItems, setAuditItems] = useState<string[]>([]);
  const [selectedAuditItem, setSelectedAuditItem] = useState("");
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

  /** 受審人員（v1.15.0：必填，同單位在職人員搜尋） */
  const [personEmpNo, setPersonEmpNo] = useState("");
  const [personName, setPersonName] = useState("");
  const [personQuery, setPersonQuery] = useState("");
  const [showPersonSugg, setShowPersonSugg] = useState(false);
  /** 病人床號（v1.15.0：指標 requireBedNo 時必填） */
  const [bedNo, setBedNo] = useState("");
  /** questionId → 備註（v1.15.0：選填） */
  const [notes, setNotes] = useState<Record<string, string>>({});
  /** questionId → 已勾選常見錯誤（不影響評分） */
  const [commonErrorAnswers, setCommonErrorAnswers] = useState<
    Record<string, string[]>
  >({});

  /** questionId → 選中的選項 index */
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  /** 達應審件數後的完成狀態（留在表單顯示，可回儀表板） */
  const [allDone, setAllDone] = useState(false);
  /** records 模式下正在編輯的單件（null＝列表） */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 解鎖申請（v1.15.0） */
  const [unlockRows, setUnlockRows] = useState<UnlockRow[]>([]);
  const [unlockReason, setUnlockReason] = useState("");
  const [unlocking, setUnlocking] = useState(false);

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
          reviewDate:
            typeof data.reviewDate === "string" ? data.reviewDate : "",
          reviewerEmpNo:
            typeof data.reviewerEmpNo === "string" ? data.reviewerEmpNo : "",
          reviewerName:
            typeof data.reviewerName === "string" ? data.reviewerName : "",
          reviewedPersonEmpNo:
            typeof data.reviewedPersonEmpNo === "string"
              ? data.reviewedPersonEmpNo
              : "",
          reviewedPersonName:
            typeof data.reviewedPersonName === "string"
              ? data.reviewedPersonName
              : "",
          bedNo: typeof data.bedNo === "string" ? data.bedNo : "",
          auditItem: typeof data.auditItem === "string" ? data.auditItem : "",
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

  /* ---------- 單件答案預填（編輯用；v1.17 起題目為選項集，舊作答快照相容對應） ---------- */
  function prefillRecord(rec: CaseRecordRow, qs: AuditQuestion[]) {
    const next: Record<string, number> = {};
    const nextNotes: Record<string, string> = {};
    const nextCommonErrors: Record<string, string[]> = {};
    rec.answers.forEach((a) => {
      const q = qs.find((x) => x.id === a.questionId);
      if (!q) return;
      const labels = optionLabelsOf(q.optionSet);
      let idx = labels.findIndex((l) => l === a.optionLabel);
      if (idx < 0 && a.excluded && labels.includes("不適用"))
        idx = labels.indexOf("不適用");
      if (idx < 0) {
        // 舊格式快照（選項文字＋分數）：用分數推斷（是＝1、否＝0）
        if (a.score === 1) idx = labels.indexOf("是");
        else if (a.score === 0) idx = labels.indexOf("否");
      }
      if (idx >= 0) next[q.id] = idx;
      if (a.note) nextNotes[a.questionId] = a.note;
      if (Array.isArray(a.commonErrors) && a.commonErrors.length > 0)
        nextCommonErrors[a.questionId] = a.commonErrors;
    });
    setAnswers(next);
    setNotes(nextNotes);
    setCommonErrorAnswers(nextCommonErrors);
    setSelectedAuditItem(rec.auditItem ?? "");
    setReviewDate(rec.reviewDate || todayStr());
    setReviewerEmpNo(rec.reviewerEmpNo);
    setReviewerName(rec.reviewerName);
    setReviewerQuery("");
    setPersonEmpNo(rec.reviewedPersonEmpNo);
    setPersonName(rec.reviewedPersonName);
    setPersonQuery("");
    setBedNo(rec.bedNo);
  }

  /* ---------- 初始載入 ---------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError("");
      try {
        const db = getFirebaseDb();
        // 人員清單（審查人員／受審人員搜尋用）
        try {
          const psnap = await getCachedRefCollection("users", () =>
            getDocsCacheFirst(collection(db, "users")),
          );
          const list: PersonOption[] = [];
          psnap.docs.forEach((d) => {
            const data = d.data() as Record<string, unknown>;
            list.push({
              staffId: d.id,
              name: typeof data.name === "string" ? data.name : d.id,
              status: typeof data.status === "string" ? data.status : "",
              unitCode: typeof data.unitCode === "string" ? data.unitCode : "",
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
        const t = taskFromDoc(
          tsnap.id,
          tsnap.data() as Record<string, unknown>,
        );
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
            typeof idata.name === "string"
              ? idata.name
              : indicatorCodeOf(t.indicatorId),
          );
          setRequireBedNo(idata.requireBedNo === true);
          // v1.17：缺值視為 true（舊資料維持顯示職編欄）
          setRequireReviewee(idata.requireReviewee !== false);
          setAuditItems(
            Array.isArray(idata.auditItems)
              ? idata.auditItems.map(String).filter(Boolean)
              : [],
          );
          // v1.22：分組名只在該指標開啟題目分組時顯示
          setShowQuestionGroups(idata.useQuestionGroups === true);
        }
        const nq = normalizeQuestions(idata.questions);
        if (cancelled) return;
        setQuestions(nq.questions);
        setTask(t);
        // 逐件紀錄
        const recs = await loadCaseRecords(t.id);
        if (cancelled) return;
        setRecords(recs);
        // 解鎖申請（v1.15.0）
        try {
          const usnap = await getDocs(
            query(
              collection(db, "unlockRequests"),
              where("taskId", "==", t.id),
            ),
          );
          if (!cancelled) {
            const urows: UnlockRow[] = [];
            usnap.docs.forEach((d) => {
              const ud = d.data() as Record<string, unknown>;
              urows.push({
                id: d.id,
                status: typeof ud.status === "string" ? ud.status : "pending",
                reason: typeof ud.reason === "string" ? ud.reason : "",
              });
            });
            setUnlockRows(urows);
          }
        } catch {
          /* 讀不到不阻擋 */
        }
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

  /* ---------- 受審人員搜尋（v1.15.0：同單位在職人員，必填） ---------- */
  const personSugg = useMemo(() => {
    const q = personQuery.trim();
    if (q === "") return [];
    const unitId = task?.unitId ?? "";
    return usersList
      .filter(
        (u) =>
          (unitId === "" || u.unitCode === unitId) &&
          (u.staffId.includes(q) || u.name.includes(q)),
      )
      .sort((a, b) => {
        const sa = a.status === "在職" ? 0 : 1;
        const sb = b.status === "在職" ? 0 : 1;
        return sa - sb || a.staffId.localeCompare(b.staffId);
      })
      .slice(0, 8);
  }, [personQuery, usersList, task?.unitId]);

  function selectPerson(u: PersonOption) {
    setPersonEmpNo(u.staffId);
    setPersonName(u.name);
    setPersonQuery("");
    setShowPersonSugg(false);
  }

  /* ---------- 申請解鎖（v1.15.0） ---------- */
  const hasPendingUnlock = unlockRows.some((r) => r.status === "pending");
  async function handleUnlockRequest() {
    if (!task || !unlockReason.trim()) {
      onAction("請填寫申請原因");
      return;
    }
    setUnlocking(true);
    try {
      const db = getFirebaseDb();
      const ref = doc(
        db,
        "unlockRequests",
        `${task.id}__unlock_${Date.now().toString(36)}`,
      );
      await setDoc(ref, {
        taskId: task.id,
        indicatorId: task.indicatorId,
        unitId: task.unitId,
        year: task.year,
        month: task.month,
        requestedBy: staffId,
        requestedByName: user?.name ?? staffId,
        reason: unlockReason.trim(),
        status: "pending",
        createdAt: serverTimestamp(),
      });
      setUnlockRows((prev) => [
        ...prev,
        { id: ref.id, status: "pending", reason: unlockReason.trim() },
      ]);
      setUnlockReason("");
      onAction("已送出解鎖申請，待執行幹事審核");
    } catch (error) {
      onAction(`申請失敗：${toErrorMessage(error)}`);
    } finally {
      setUnlocking(false);
    }
  }

  /* ---------- 送出（逐件新增 or 單件更新） ---------- */
  async function handleSubmit() {
    if (!task) return;
    if (task.status === "locked") {
      onAction("任務已鎖定，請先申請解鎖");
      return;
    }
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
    if (requireReviewee && !personEmpNo.trim()) {
      onAction("請選擇受審人員");
      return;
    }
    if (requireBedNo && !bedNo.trim()) {
      onAction("請填寫病人床號");
      return;
    }
    if (auditItems.length > 0 && !selectedAuditItem) {
      onAction("請選擇審核項目");
      return;
    }
    setSubmitting(true);
    try {
      const db = getFirebaseDb();
      // v1.17：是＝1（計入分子分母）、否＝0（計入分母）、不適用＝不計入
      const answerList: ReviewAnswer[] = questions.map((q) => {
        const labels = optionLabelsOf(q.optionSet);
        const label = labels[answers[q.id]] ?? "否";
        const note = (notes[q.id] ?? "").trim();
        return {
          questionId: q.id,
          itemText: q.itemText,
          optionLabel: label,
          score: label === "是" ? 1 : 0,
          excluded: label === "不適用",
          ...((commonErrorAnswers[q.id] ?? []).length > 0
            ? { commonErrors: commonErrorAnswers[q.id] }
            : {}),
          ...(note ? { note } : {}),
        };
      });
      const { totalScore, maxScore, rate } = computeOptionSetScore(
        answerList.map((a) => ({ score: a.score, excluded: !!a.excluded })),
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
          reviewedPersonEmpNo: personEmpNo.trim(),
          reviewedPersonName: personName.trim(),
          bedNo: bedNo.trim(),
          auditItem: selectedAuditItem,
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
          reviewedPersonEmpNo: personEmpNo.trim(),
          reviewedPersonName: personName.trim(),
          bedNo: bedNo.trim(),
          auditItem: selectedAuditItem,
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
        setAnswers({}); // 清空答案，保留日期／審查人員，繼續下一件
        setCommonErrorAnswers({});
        setNotes({});
        setPersonEmpNo("");
        setPersonName("");
        setPersonQuery("");
        setBedNo("");
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
        <EmptyState
          title="無法開啟審查表"
          description={loadError || "任務資料異常。"}
        />
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
                    <th>受審人員</th>
                    <th>床號</th>
                    <th>審核項目</th>
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
                        {r.reviewedPersonEmpNo
                          ? `${r.reviewedPersonEmpNo}／${maskName(r.reviewedPersonName || r.reviewedPersonEmpNo)}`
                          : "—"}
                      </td>
                      <td>{r.bedNo || "—"}</td>
                      <td>{r.auditItem || "—"}</td>
                      <td>
                        {r.totalScore}/{r.maxScore}
                        {r.rate != null ? `（${r.rate}%）` : ""}
                      </td>
                      <td>{fmtTs(r.submittedAt) || "—"}</td>
                      <td>
                        {task.status === "locked" ? (
                          <span className="muted-text">已鎖定</span>
                        ) : (
                          <button
                            className="text-button"
                            onClick={() => {
                              prefillRecord(r, questions);
                              setEditingId(r.id);
                            }}
                          >
                            <Pencil
                              size={13}
                              style={{ verticalAlign: "-2px" }}
                            />{" "}
                            編輯
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : task.status === "locked" && !editingId ? (
        /* ============ 逾期鎖定：不可填寫，可申請解鎖 ============ */
        <section className="panel" style={{ borderColor: "#e0a3a3" }}>
          <p style={{ marginTop: 0 }}>
            <b>🔒 此任務已逾期鎖定</b>
            <span className="muted-text">（截止日期 {task.deadline}）</span>
          </p>
          <p className="settings-note">
            鎖定後不可再送出審查結果。如需補登，請填寫原因申請解鎖，待執行幹事審核。
          </p>
          {hasPendingUnlock ? (
            <p>
              <span className="status-pill warning">已送出申請，待審核</span>
            </p>
          ) : (
            <div className="form-field" style={{ maxWidth: 480 }}>
              <label className="field-label">申請原因</label>
              <textarea
                className="text-input"
                rows={3}
                placeholder="請說明需要解鎖補登的原因"
                value={unlockReason}
                onChange={(e) => setUnlockReason(e.target.value)}
              />
              <div className="form-actions" style={{ marginTop: 12 }}>
                <button
                  className="button button-primary"
                  disabled={unlocking}
                  onClick={handleUnlockRequest}
                >
                  {unlocking ? "送出中…" : "申請解鎖"}
                </button>
              </div>
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
                                <span className="muted-text">
                                  （{u.status}）
                                </span>
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
              {requireReviewee && (
                <div className="form-field" style={{ position: "relative" }}>
                  <label className="field-label">
                    職編 <span style={{ color: "#b3372f" }}>*</span>
                  </label>
                  {personEmpNo ? (
                    <p style={{ margin: "12px 0" }}>
                      <b>
                        {personEmpNo}／{maskName(personName || personEmpNo)}
                      </b>{" "}
                      <button
                        className="text-button"
                        onClick={() => {
                          setPersonEmpNo("");
                          setPersonName("");
                          setPersonQuery("");
                          setShowPersonSugg(true);
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
                        placeholder={`輸入職編或姓名搜尋（${task.unitId}同單位）`}
                        value={personQuery}
                        onChange={(e) => {
                          setPersonQuery(e.target.value);
                          setShowPersonSugg(true);
                        }}
                        onFocus={() => setShowPersonSugg(true)}
                        aria-label="受審人員搜尋"
                      />
                      {showPersonSugg && personSugg.length > 0 && (
                        <ul className="sugg-list">
                          {personSugg.map((u) => (
                            <li key={u.staffId}>
                              <button
                                type="button"
                                className="text-button"
                                onClick={() => selectPerson(u)}
                              >
                                {u.staffId}／{maskName(u.name)}
                                {u.status && u.status !== "在職" && (
                                  <span className="muted-text">
                                    （{u.status}）
                                  </span>
                                )}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              )}
              {requireBedNo && (
                <div className="form-field">
                  <label className="field-label">
                    病人床號 <span style={{ color: "#b3372f" }}>*</span>
                  </label>
                  <input
                    type="text"
                    className="text-input"
                    placeholder="請輸入病人床號"
                    value={bedNo}
                    onChange={(e) => setBedNo(e.target.value)}
                    aria-label="病人床號"
                  />
                </div>
              )}
            </div>
          </section>

          {auditItems.length > 0 && (
            <section className="panel audit-item-selection">
              <label className="field-label" htmlFor="review-audit-item">
                審核項目 <span style={{ color: "#b3372f" }}>*</span>
              </label>
              <select
                id="review-audit-item"
                className="text-input"
                value={selectedAuditItem}
                onChange={(event) => setSelectedAuditItem(event.target.value)}
                aria-label="選擇審核項目"
              >
                <option value="">請選擇一項</option>
                {auditItems.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </section>
          )}

          {questions.length === 0 ? (
            <EmptyState
              title="該指標尚未建立審查題目"
              description="請先至「指標管理」→ 該指標 →「審核表」頁籤建立題目後再回來填寫。"
            />
          ) : (
            <>
              {/* 題目：一個組別一個方框；題目左、選項中、備註右；指引可收合（v1.24） */}
              <ReviewQuestionList
                mode="edit"
                questions={questions}
                showGroups={showQuestionGroups}
                answers={answers}
                commonErrorAnswers={commonErrorAnswers}
                notes={notes}
                onAnswer={chooseAnswer}
                onCommonErrors={(qid, values) =>
                  setCommonErrorAnswers((prev) => ({ ...prev, [qid]: values }))
                }
                onNote={(qid, text) =>
                  setNotes((prev) => ({ ...prev, [qid]: text }))
                }
              />

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
