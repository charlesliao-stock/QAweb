import { loadRefCollection } from "../lib/refLoad";
import { toErrorMessage } from "../lib/errors";
import { commitAndVerify } from "../lib/confirmedCommit";
import {
  createEditRequest,
  findArchiveIdsForRecord,
  hasPendingEditRequest,
} from "../lib/editRequests";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { ArrowLeft, Camera, Check, ChevronLeft, ChevronRight, ListChecks, Pencil, ScanLine } from "lucide-react";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getDocsFromServer,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "../lib/db";
import { EmptyState, SectionTitle } from "../components/ui";
import { getFirebaseDb } from "../lib/firebase";
import { useAuth } from "../lib/auth";
import { isReviewerAccessActive } from "../lib/reviewerValidity";
import { staffLabel } from "../lib/mask";
import {
  indicatorCodeOf,
  normalizeQuestions,
  optionLabelsOf,
  type AuditQuestion,
} from "../lib/indicators";
import { ReviewQuestionList } from "./ReviewQuestionList";
const BarcodeScannerDialog = lazy(() =>
  import("./BarcodeScannerDialog").then((module) => ({
    default: module.BarcodeScannerDialog,
  })),
);
import {
  computeOptionSetScore,
  type ReviewAnswer,
} from "../lib/reviewRecords";
import {
  intervalsOverlap,
  intervalMonthKeys,
  isTaskComplete,
  nextAvailableQuotaSlot,
  nextCaseSeq,
  progressLabel,
  requiredCases,
  reviewCaseDocId,
  reviewIntervalIdentity,
  reviewUniqueDocId,
} from "../lib/reviewProgress";
import {
  periodicQuotaSlotDocId,
  todayStr,
  type ReviewTask,
} from "../lib/scheduling";

/**
 * 進入審查表單的方式（v1.11.0）：
 * - task：審查表單（逐件送出）；editRecordId 指定時為編輯既有單件
 * - records：查詢＝列出該單位該指標的逐件審查結果，每筆可編輯
 */
export type ExecuteTarget =
  | { mode: "task"; taskId: string; editRecordId?: string; editDraftId?: string }
  | { mode: "records"; taskId: string };

interface TaskFull extends ReviewTask {
  id: string;
}

interface AuditMonthOption {
  value: string;
  label: string;
  active: boolean;
}

/** 該 task 的單件審查紀錄 */
interface CaseRecordRow {
  id: string;
  caseSeq: number | null;
  year: number;
  month: number;
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
  quotaGroupId?: string;
  quotaCaseNo?: number;
  version?: number;
  submittedAt: unknown;
  submittedBy: string;
}

interface PeriodicQuotaState {
  count: number;
  draftCount: number;
  occupiedSlots: number[];
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

function ymLabel(year: number, month: number): string {
  return `${year} 年 ${month} 月`;
}

function auditMonthValue(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
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

function isSharedPeriodicQuotaTask(
  task: ReviewTask | null | undefined,
): task is ReviewTask & {
  quotaVersion: 1;
  quotaGroupId: string;
  quotaCategory: "year" | "academic";
  quotaIntervalStartYear: number;
  quotaIntervalStartMonth: number;
  quotaIntervalEndYear: number;
  quotaIntervalEndMonth: number;
} {
  return (
    task?.quotaVersion === 1 &&
    Boolean(task.quotaGroupId) &&
    (task.quotaCategory === "year" || task.quotaCategory === "academic") &&
    typeof task.quotaIntervalStartYear === "number" &&
    typeof task.quotaIntervalStartMonth === "number" &&
    typeof task.quotaIntervalEndYear === "number" &&
    typeof task.quotaIntervalEndMonth === "number"
  );
}

function taskFromDoc(id: string, data: Record<string, unknown>): TaskFull {
  const cc = data.caseCount;
  const st = String(data.status ?? "pending");
  const quotaCategory =
    data.quotaCategory === "year" || data.quotaCategory === "academic"
      ? data.quotaCategory
      : undefined;
  return {
    id,
    indicatorId: String(data.indicatorId ?? ""),
    year: Number(data.year ?? 0),
    month: Number(data.month ?? 0),
    unitId: String(data.unitId ?? ""),
    reviewerId: String(data.reviewerId ?? ""),
    caseCount:
      typeof cc === "number" && Number.isInteger(cc) && cc >= 1 ? cc : null,
    quotaVersion: data.quotaVersion === 1 ? 1 : undefined,
    quotaGroupId:
      typeof data.quotaGroupId === "string" ? data.quotaGroupId : undefined,
    quotaCategory,
    quotaIntervalStartYear:
      typeof data.quotaIntervalStartYear === "number"
        ? data.quotaIntervalStartYear
        : undefined,
    quotaIntervalStartMonth:
      typeof data.quotaIntervalStartMonth === "number"
        ? data.quotaIntervalStartMonth
        : undefined,
    quotaIntervalEndYear:
      typeof data.quotaIntervalEndYear === "number"
        ? data.quotaIntervalEndYear
        : undefined,
    quotaIntervalEndMonth:
      typeof data.quotaIntervalEndMonth === "number"
        ? data.quotaIntervalEndMonth
        : undefined,
    indicatorVersionAtSchedule:
      typeof data.indicatorVersionAtSchedule === "string"
        ? data.indicatorVersionAtSchedule
        : undefined,
    thresholdAtSchedule:
      typeof data.thresholdAtSchedule === "number"
        ? data.thresholdAtSchedule
        : undefined,
    thresholdRuleAtSchedule: data.thresholdRuleAtSchedule === ">=" ? ">=" : undefined,
    scheduleStartYear:
      typeof data.scheduleStartYear === "number" ? data.scheduleStartYear : undefined,
    scheduleStartMonth:
      typeof data.scheduleStartMonth === "number" ? data.scheduleStartMonth : undefined,
    scheduleEndYear:
      typeof data.scheduleEndYear === "number" ? data.scheduleEndYear : undefined,
    scheduleEndMonth:
      typeof data.scheduleEndMonth === "number" ? data.scheduleEndMonth : undefined,
    scheduleCategory:
      data.scheduleCategory === "year" || data.scheduleCategory === "academic" || data.scheduleCategory === "temp"
        ? data.scheduleCategory
        : undefined,
    schedulePeriod:
      typeof data.schedulePeriod === "string" ? data.schedulePeriod : undefined,
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
  const reviewerExpired = !!user?.reviewerAccessExpiresAt &&
    !isReviewerAccessActive(user.reviewerAccessExpiresAt) &&
    !(user.roles ?? []).includes("系統管理員");

  const [loading, setLoading] = useState(true);
  const [indicatorName, setIndicatorName] = useState("");
  /** 該指標是否開啟題目分組顯示（v1.22：關閉時不顯示分組名） */
  const [showQuestionGroups, setShowQuestionGroups] = useState(false);
  const [requireBedNo, setRequireBedNo] = useState(false);
  /** 需要受審人員資料（v1.17）：false 時隱藏「職編」欄位；缺值視為 true（相容舊資料） */
  const [requireReviewee, setRequireReviewee] = useState(true);
  const [questions, setQuestions] = useState<AuditQuestion[]>([]);
  const [activeQuestionId, setActiveQuestionId] = useState("");
  const [reviewMobileStep, setReviewMobileStep] = useState<"basic" | "questions">("basic");
  const [mobileReviewLayout, setMobileReviewLayout] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 1100px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1100px)");
    const syncLayout = () => setMobileReviewLayout(query.matches);
    syncLayout();
    query.addEventListener("change", syncLayout);
    return () => query.removeEventListener("change", syncLayout);
  }, []);
  const [auditMonth, setAuditMonth] = useState("");
  const [auditMonthOptions, setAuditMonthOptions] = useState<AuditMonthOption[]>([]);
  const [auditMonthError, setAuditMonthError] = useState("");
  const [assignedScheduleTasks, setAssignedScheduleTasks] = useState<TaskFull[]>([]);
  const [switchingSchedule, setSwitchingSchedule] = useState(false);
  const [auditItems, setAuditItems] = useState<string[]>([]);
  const [selectedAuditItem, setSelectedAuditItem] = useState("");
  const [task, setTask] = useState<TaskFull | null>(null);
  const [records, setRecords] = useState<CaseRecordRow[]>([]);
  const [drafts, setDrafts] = useState<CaseRecordRow[]>([]);
  const [quotaDoneCount, setQuotaDoneCount] = useState(0);
  const [quotaDraftCount, setQuotaDraftCount] = useState(0);
  const [loadError, setLoadError] = useState("");

  /** 逐件表單欄位（v1.11.0） */
  const [reviewDate, setReviewDate] = useState(todayStr());
  const [reviewerEmpNo, setReviewerEmpNo] = useState("");
  const [reviewerName, setReviewerName] = useState("");
  const [reviewerQuery, setReviewerQuery] = useState("");
  const [showSugg, setShowSugg] = useState(false);
  const [usersList, setUsersList] = useState<PersonOption[]>([]);

  /** 受審人員（v1.15.0：必填，同單位在職人員搜尋；v1.51.0：不限單位任務改全院搜尋） */
  const [personEmpNo, setPersonEmpNo] = useState("");
  const [personName, setPersonName] = useState("");
  const [personQuery, setPersonQuery] = useState("");
  const [showPersonSugg, setShowPersonSugg] = useState(false);
  const [personBarcodeOpen, setPersonBarcodeOpen] = useState(false);
  /** 受審人員重複警示（v1.47.0：選取時即時查該區間已有紀錄，僅警告） */
  const [personDupWarn, setPersonDupWarn] = useState<string | null>(null);
  const personDupSeq = useRef(0);
  /** 病人床號（v1.15.0：指標 requireBedNo 時必填） */
  const [bedNo, setBedNo] = useState("");
  /** questionId → 備註（v1.15.0：選填） */
  const [notes, setNotes] = useState<Record<string, string>>({});
  /** questionId → 既有紀錄照片 URL；本次新拍照片不會寫入審查結果 */
  const [photoUrlsByQuestion, setPhotoUrlsByQuestion] = useState<Record<string, string[]>>({});
  /** questionId → 本次畫面內拍照次數（不保存、不上傳） */
  const [photoCaptureCounts, setPhotoCaptureCounts] = useState<Record<string, number>>({});
  const photoInputRef = useRef<HTMLInputElement>(null);
  const photoQuestionIdRef = useRef("");
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
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  /** 解鎖申請（v1.15.0） */
  const [unlockRows, setUnlockRows] = useState<UnlockRow[]>([]);
  const [unlockReason, setUnlockReason] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  const sharedQuotaTask = isSharedPeriodicQuotaTask(task);
  const doneCount = sharedQuotaTask ? quotaDoneCount : records.length;
  const draftCount = sharedQuotaTask ? quotaDraftCount : drafts.length;
  const usedCount = doneCount + draftCount;
  const editingRecord = editingId !== null || editingDraftId !== null;
  const reviewFormActive = !loading && !loadError && !!task && !allDone &&
    !(target.mode === "records" && !editingRecord) &&
    !(isTaskComplete(usedCount, task.caseCount) && !editingRecord) &&
    !(task.status === "locked" && !editingRecord);
  useEffect(() => {
    if (!reviewFormActive) return;
    const root = document.documentElement;
    const previous = root.getAttribute("data-review-form-active");
    root.setAttribute("data-review-form-active", "true");
    return () => {
      if (previous == null) root.removeAttribute("data-review-form-active");
      else root.setAttribute("data-review-form-active", previous);
    };
  }, [reviewFormActive]);
  const liveScore = useMemo(() => {
    const selections = questions.flatMap((question) => {
      const selectedIndex = answers[question.id];
      if (selectedIndex == null) return [];
      const label = optionLabelsOf(question.optionSet)[selectedIndex];
      if (!label) return [];
      return [{ score: label === "是" ? 1 : 0, excluded: label === "不適用" }];
    });
    return {
      ...computeOptionSetScore(selections),
      answeredCount: selections.length,
    };
  }, [questions, answers]);
  const currentQuestionId = questions.some((question) => question.id === activeQuestionId)
    ? activeQuestionId
    : questions[0]?.id ?? "";
  const activeQuestionIndex = questions.findIndex((question) => question.id === currentQuestionId);
  const answeredCount = liveScore.answeredCount;
  const attachedPhotoCounts = useMemo(
    () => Object.fromEntries(questions.map((question) => [
      question.id,
      (photoUrlsByQuestion[question.id]?.length ?? 0) + (photoCaptureCounts[question.id] ?? 0),
    ])),
    [questions, photoUrlsByQuestion, photoCaptureCounts],
  );

  async function assertUniqueReviewee(
    empNo: string,
    except: { recordId?: string; draftId?: string } = {},
  ) {
    if (!task || !empNo.trim()) return;
    const db = getFirebaseDb();
    const intervalId = reviewIntervalIdentity(task);
    // 只查「同指標＋同受審人員」：兩個等號條件由 Firestore 合併單欄位索引，免複合索引；
    // 下方比對本來就要求職編相同，結果與全指標讀回再過濾完全一致，但讀取量不再隨指標紀錄總數成長。
    const reviewee = empNo.trim();
    const [recordSnap, draftSnap] = await Promise.all([
      getDocs(query(collection(db, "reviewRecords"), where("indicatorId", "==", task.indicatorId), where("reviewedPersonEmpNo", "==", reviewee))),
      getDocs(query(collection(db, "reviewDrafts"), where("indicatorId", "==", task.indicatorId), where("reviewedPersonEmpNo", "==", reviewee))),
    ]);
    // v1.47.0：區間比對改為「紀錄月份落在任務區間內」（月份重疊），而非
    // 區間身分字串相等——匯入紀錄無區間快照欄位，舊寫法讓季／半年／年
    // 任務的匯入紀錄永遠對不上。
    const intervalInputOf = (data: Record<string, unknown>) => ({
      year: Number(data.year ?? 0),
      month: Number(data.month ?? 0),
      scheduleStartYear: typeof data.scheduleStartYear === "number" ? data.scheduleStartYear : undefined,
      scheduleStartMonth: typeof data.scheduleStartMonth === "number" ? data.scheduleStartMonth : undefined,
      scheduleEndYear: typeof data.scheduleEndYear === "number" ? data.scheduleEndYear : undefined,
      scheduleEndMonth: typeof data.scheduleEndMonth === "number" ? data.scheduleEndMonth : undefined,
    });
    for (const record of recordSnap.docs) {
      if (record.id === except.recordId) continue;
      const data = record.data() as Record<string, unknown>;
      if (String(data.reviewedPersonEmpNo ?? "") === empNo.trim() && intervalsOverlap(task, intervalInputOf(data)))
        throw new Error("此受審人員在同一指標、同一審查區間已有正式紀錄，不可重複審查");
    }
    for (const draft of draftSnap.docs) {
      if (draft.id === except.draftId) continue;
      const data = draft.data() as Record<string, unknown>;
      if (String(data.reviewedPersonEmpNo ?? "") === empNo.trim() && intervalsOverlap(task, intervalInputOf(data)))
        throw new Error("此受審人員在同一指標、同一審查區間已有暫存紀錄；請先開啟該暫存後提交或刪除");
    }
    const uniqueKey = reviewUniqueDocId(task.indicatorId, intervalId, empNo);
    const lockSnap = await getDoc(doc(db, "reviewReservations", uniqueKey));
    if (lockSnap.exists()) {
      const data = lockSnap.data() as Record<string, unknown>;
      const targetId = String(data.targetId ?? "");
      if (targetId !== except.recordId && targetId !== except.draftId)
        throw new Error("此受審人員的唯一名額已被其他審查紀錄或暫存占用");
    }
  }

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
          year: Number(data.year ?? 0),
          month: Number(data.month ?? 0),
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
          quotaGroupId:
            typeof data.quotaGroupId === "string" ? data.quotaGroupId : undefined,
          quotaCaseNo:
            typeof data.quotaCaseNo === "number" ? data.quotaCaseNo : undefined,
          version: typeof data.version === "number" ? data.version : undefined,
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

  const loadDraftRecords = useCallback(
    async (taskId: string): Promise<CaseRecordRow[]> => {
      const db = getFirebaseDb();
      const snapshot = await getDocs(
        query(collection(db, "reviewDrafts"), where("taskId", "==", taskId)),
      );
      return snapshot.docs.map((draft) => {
        const data = draft.data() as Record<string, unknown>;
        return {
          id: draft.id,
          caseSeq: typeof data.caseSeq === "number" ? data.caseSeq : null,
          year: Number(data.year ?? 0),
          month: Number(data.month ?? 0),
          reviewDate: typeof data.reviewDate === "string" ? data.reviewDate : "",
          reviewerEmpNo: typeof data.reviewerEmpNo === "string" ? data.reviewerEmpNo : "",
          reviewerName: typeof data.reviewerName === "string" ? data.reviewerName : "",
          reviewedPersonEmpNo: typeof data.reviewedPersonEmpNo === "string" ? data.reviewedPersonEmpNo : "",
          reviewedPersonName: typeof data.reviewedPersonName === "string" ? data.reviewedPersonName : "",
          bedNo: typeof data.bedNo === "string" ? data.bedNo : "",
          auditItem: typeof data.auditItem === "string" ? data.auditItem : "",
          answers: Array.isArray(data.answers) ? data.answers as ReviewAnswer[] : [],
          totalScore: Number(data.totalScore ?? 0),
          maxScore: Number(data.maxScore ?? 0),
          rate: typeof data.rate === "number" ? data.rate : null,
          quotaGroupId: typeof data.quotaGroupId === "string" ? data.quotaGroupId : undefined,
          quotaCaseNo: typeof data.quotaCaseNo === "number" ? data.quotaCaseNo : undefined,
          version: typeof data.version === "number" ? data.version : undefined,
          submittedAt: data.updatedAt,
          submittedBy: typeof data.createdBy === "string" ? data.createdBy : "",
        };
      }).sort((a, b) => (a.caseSeq ?? 0) - (b.caseSeq ?? 0));
    },
    [],
  );

  const loadPeriodicQuotaCount = useCallback(
    async (quotaTask: TaskFull): Promise<PeriodicQuotaState> => {
      if (!isSharedPeriodicQuotaTask(quotaTask))
        return { count: 0, draftCount: 0, occupiedSlots: [] };
      const startYear = quotaTask.quotaIntervalStartYear!;
      const startMonth = quotaTask.quotaIntervalStartMonth!;
      const endYear = quotaTask.quotaIntervalEndYear!;
      const endMonth = quotaTask.quotaIntervalEndMonth!;
      const monthKeys = new Set<string>();
      let cursor = startYear * 12 + startMonth - 1;
      const end = endYear * 12 + endMonth - 1;
      while (cursor <= end) {
        const year = Math.floor(cursor / 12);
        const month = (cursor % 12) + 1;
        monthKeys.add(`${year}-${month}`);
        cursor += 1;
      }
      const years = [...new Set([...monthKeys].map((key) => Number(key.split("-")[0])))];
      const db = getFirebaseDb();
      const snapshots = await Promise.all(
        years.map((year) =>
          getDocsFromServer(
            query(
              collection(db, "reviewRecords"),
              where("indicatorId", "==", quotaTask.indicatorId),
              where("year", "==", year),
            ),
          ),
        ),
      );
      const draftSnapshots = await Promise.all(
        years.map((year) =>
          getDocsFromServer(
            query(
              collection(db, "reviewDrafts"),
              where("indicatorId", "==", quotaTask.indicatorId),
              where("year", "==", year),
            ),
          ),
        ),
      );
      let count = 0;
      let draftCount = 0;
      const occupiedSlots = new Set<number>();
      // v1.51.0：不限單位任務（unitId ""）不按單位過濾——匯入紀錄帶真實單位，
      // 仍應計入 NA 配額（與進度一致）；正式紀錄以 quotaGroupId 歸屬。
      const skipUnitFilter = quotaTask.unitId === "";
      snapshots.forEach((snapshot) => {
        snapshot.docs.forEach((record) => {
          const data = record.data() as Record<string, unknown>;
          if (!skipUnitFilter && String(data.unitId ?? "") !== quotaTask.unitId) return;
          const month = Number(data.month ?? 0);
          const key = `${Number(data.year ?? 0)}-${month}`;
          if (!monthKeys.has(key)) return;
          const groupId =
            typeof data.quotaGroupId === "string" ? data.quotaGroupId : "";
          const source = typeof data.source === "string" ? data.source : "";
          // 僅計入同一週期 quota group 的任務結果與 taskless 匯入結果；temp/舊版 task 不混入。
          if (groupId === quotaTask.quotaGroupId || (!groupId && source === "import")) {
            count += 1;
            if (
              groupId === quotaTask.quotaGroupId &&
              typeof data.quotaCaseNo === "number" &&
              Number.isInteger(data.quotaCaseNo) &&
              data.quotaCaseNo > 0
            ) {
              occupiedSlots.add(data.quotaCaseNo);
            }
          }
        });
      });
      draftSnapshots.forEach((snapshot) => {
        snapshot.docs.forEach((draft) => {
          const data = draft.data() as Record<string, unknown>;
          if (
            (!skipUnitFilter &&
              String(data.unitId ?? "") !== quotaTask.unitId) ||
            String(data.quotaGroupId ?? "") !== quotaTask.quotaGroupId
          ) return;
          const month = Number(data.month ?? 0);
          const key = `${Number(data.year ?? 0)}-${month}`;
          if (!monthKeys.has(key)) return;
          draftCount += 1;
          const slot = data.quotaCaseNo;
          if (typeof slot === "number" && Number.isInteger(slot) && slot > 0)
            occupiedSlots.add(slot);
        });
      });
      return { count, draftCount, occupiedSlots: [...occupiedSlots] };
    },
    [],
  );

  const syncPeriodicQuotaTaskStatus = useCallback(
    async (quotaTask: TaskFull, complete: boolean) => {
      if (!isSharedPeriodicQuotaTask(quotaTask)) return;
      const db = getFirebaseDb();
      const snapshot = await getDocsFromServer(
        query(
          collection(db, "reviewTasks"),
          where("quotaGroupId", "==", quotaTask.quotaGroupId),
        ),
      );
      const updates: { ref: (typeof snapshot.docs)[number]["ref"]; data: Record<string, unknown> }[] = [];
      snapshot.docs.forEach((taskDoc) => {
        const status = String(taskDoc.data().status ?? "pending");
        if (complete && status !== "done") {
          updates.push({
            ref: taskDoc.ref,
            data: { status: "done", completedAt: serverTimestamp() },
          });
        } else if (!complete && status === "done") {
          updates.push({
            ref: taskDoc.ref,
            data: { status: "pending", completedAt: null },
          });
        }
      });
      for (let index = 0; index < updates.length; index += 400) {
        const batch = writeBatch(db);
        updates.slice(index, index + 400).forEach(({ ref, data }) =>
          batch.update(ref, data),
        );
        await batch.commit();
      }
    },
    [],
  );

  /* ---------- 單件答案預填（編輯用；v1.17 起題目為選項集，舊作答快照相容對應） ---------- */
  function prefillRecord(rec: CaseRecordRow, qs: AuditQuestion[]) {
    const next: Record<string, number> = {};
    const nextNotes: Record<string, string> = {};
    const nextCommonErrors: Record<string, string[]> = {};
    const nextPhotoUrls: Record<string, string[]> = {};
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
      if (Array.isArray(a.photoUrls) && a.photoUrls.length > 0)
        nextPhotoUrls[a.questionId] = a.photoUrls.filter((url): url is string => typeof url === "string");
    });
    setAnswers(next);
    setActiveQuestionId(qs.find((question) => next[question.id] == null)?.id ?? qs[0]?.id ?? "");
    setNotes(nextNotes);
    setCommonErrorAnswers(nextCommonErrors);
    setPhotoUrlsByQuestion(nextPhotoUrls);
    setPhotoCaptureCounts({});
    setSelectedAuditItem(rec.auditItem ?? "");
    const recordMonth = auditMonthValue(rec.year, rec.month);
    if (rec.year > 0 && rec.month >= 1 && rec.month <= 12) {
      setAuditMonth(recordMonth);
      setAuditMonthOptions((previous) => previous.some((option) => option.value === recordMonth)
        ? previous
        : [...previous, { value: recordMonth, label: `${ymLabel(rec.year, rec.month)}（原紀錄月份）`, active: false }]);
    }
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
          const psnap = await loadRefCollection("users");
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

        // 只列出目前登入審查員被指派、且屬於相同指標與排程區間的單位任務。
        try {
          if (staffId) {
            const assignedSnap = await getDocs(query(
              collection(db, "reviewTasks"),
              where("reviewerId", "==", staffId),
            ));
            const assigned = assignedSnap.docs
              .map((d) => taskFromDoc(d.id, d.data() as Record<string, unknown>))
              .filter((candidate) => {
                if (candidate.id !== t.id && candidate.status !== "pending") return false;
                if (candidate.indicatorId !== t.indicatorId) return false;
                const sameWindow = reviewIntervalIdentity(candidate) === reviewIntervalIdentity(t);
                if (!sameWindow) return false;
                if (t.scheduleCategory || candidate.scheduleCategory) {
                  return t.scheduleCategory === candidate.scheduleCategory &&
                    (t.schedulePeriod ?? "") === (candidate.schedulePeriod ?? "");
                }
                return true;
              });
            if (!assigned.some((candidate) => candidate.id === t.id)) assigned.unshift(t);
            if (!cancelled) setAssignedScheduleTasks(assigned);
          } else if (!cancelled) {
            setAssignedScheduleTasks([t]);
          }
        } catch {
          if (!cancelled) setAssignedScheduleTasks([t]);
        }

        // 稽核月份限同一排程區間，並排除已封存月份；之後送出前仍會再次檢查。
        try {
          const rangeMonths = [...intervalMonthKeys(t)].map((key) => {
            const [year, month] = key.split("-").map(Number);
            return { year, month, value: auditMonthValue(year, month) };
          }).filter((item) => item.year > 0 && item.month >= 1 && item.month <= 12)
            .sort((a, b) => a.year * 12 + a.month - (b.year * 12 + b.month));
          const archiveSnap = await getDocs(query(
            collection(db, "reviewArchives"),
            where("indicatorId", "==", t.indicatorId),
          ));
          const archivedMonths = new Set<string>();
          archiveSnap.docs.forEach((archive) => {
            const data = archive.data() as Record<string, unknown>;
            const start = data.start as { year?: unknown; month?: unknown } | undefined;
            const end = data.end as { year?: unknown; month?: unknown } | undefined;
            if (!start || !end || !Number.isSafeInteger(start.year) || !Number.isSafeInteger(start.month) ||
                !Number.isSafeInteger(end.year) || !Number.isSafeInteger(end.month) ||
                (start.month as number) < 1 || (start.month as number) > 12 ||
                (end.month as number) < 1 || (end.month as number) > 12) return;
            const firstIndex = (start.year as number) * 12 + (start.month as number) - 1;
            const endIndex = (end.year as number) * 12 + (end.month as number) - 1;
            if (endIndex < firstIndex) return;
            for (const item of rangeMonths) {
              const monthIndex = item.year * 12 + item.month - 1;
              if (monthIndex >= firstIndex && monthIndex <= endIndex) archivedMonths.add(item.value);
            }
          });
          const openMonths: AuditMonthOption[] = rangeMonths
            .filter((item) => !archivedMonths.has(item.value))
            .map((item) => ({ value: item.value, label: ymLabel(item.year, item.month), active: true }));
          if (!cancelled) {
            setAuditMonthOptions(openMonths);
            setAuditMonthError("");
            const scheduledMonth = auditMonthValue(t.year, t.month);
            setAuditMonth(openMonths.some((item) => item.value === scheduledMonth)
              ? scheduledMonth
              : openMonths[0]?.value ?? "");
            if (openMonths.length === 0) setAuditMonthError("此排程區間的月份均已封存，無可新增稽核月份。");
          }
        } catch {
          if (!cancelled) {
            setAuditMonthOptions([]);
            setAuditMonth("");
            setAuditMonthError("無法確認稽核月份是否已封存，請稍後重新載入。");
          }
        }
        // 逐件紀錄
        const recs = await loadCaseRecords(t.id);
        if (cancelled) return;
        setRecords(recs);
        const draftRows = await loadDraftRecords(t.id);
        if (cancelled) return;
        setDrafts(draftRows);
        const quotaState = isSharedPeriodicQuotaTask(t)
          ? await loadPeriodicQuotaCount(t)
          : { count: recs.length, draftCount: draftRows.length, occupiedSlots: [] };
        if (cancelled) return;
        setQuotaDoneCount(quotaState.count);
        setQuotaDraftCount(quotaState.draftCount);
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
        const editDraftId =
          target.mode === "task" ? (target.editDraftId ?? null) : null;
        if (editId && !cancelled) {
          const rec = recs.find((r) => r.id === editId);
          if (rec) {
            prefillRecord(rec, nq.questions);
            setEditingId(editId);
          }
        }
        if (editDraftId && !cancelled) {
          const draft = draftRows.find((r) => r.id === editDraftId);
          if (draft) {
            prefillRecord(draft, nq.questions);
            setEditingDraftId(editDraftId);
          }
        }
        const quotaComplete = isTaskComplete(quotaState.count, t.caseCount);
        if (isSharedPeriodicQuotaTask(t)) {
          try {
            await syncPeriodicQuotaTaskStatus(t, quotaComplete);
          } catch {
            // 狀態同步失敗不阻擋表單；件數仍由最新結果查詢判定。
          }
        }
        if (!cancelled) setAllDone(quotaComplete);
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

  function openQuestionCamera(questionId: string) {
    photoQuestionIdRef.current = questionId;
    photoInputRef.current?.click();
  }

  function handleCameraSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = event.currentTarget.files;
    const questionId = photoQuestionIdRef.current;
    if (files?.length && questionId) {
      setPhotoCaptureCounts((previous) => ({
        ...previous,
        [questionId]: (previous[questionId] ?? 0) + files.length,
      }));
      onAction("已拍照；目前只在本次表單顯示標記，照片不會保存至審查結果。");
    }
    event.currentTarget.value = "";
  }

  async function handleScheduleUnitChange(taskId: string) {
    if (!task || taskId === task.id || switchingSchedule) return;
    const nextTask = assignedScheduleTasks.find((candidate) => candidate.id === taskId);
    if (!nextTask) return;
    setSwitchingSchedule(true);
    try {
      const [nextRecords, nextDrafts] = await Promise.all([
        loadCaseRecords(nextTask.id),
        loadDraftRecords(nextTask.id),
      ]);
      const nextQuota = isSharedPeriodicQuotaTask(nextTask)
        ? await loadPeriodicQuotaCount(nextTask)
        : { count: nextRecords.length, draftCount: nextDrafts.length, occupiedSlots: [] as number[] };
      setTask(nextTask);
      setRecords(nextRecords);
      setDrafts(nextDrafts);
      setQuotaDoneCount(nextQuota.count);
      setQuotaDraftCount(nextQuota.draftCount);
      setAllDone(isTaskComplete(nextQuota.count, nextTask.caseCount));
      setEditingId(null);
      setEditingDraftId(null);
      setAnswers({});
      setNotes({});
      setCommonErrorAnswers({});
      setPhotoUrlsByQuestion({});
      setPhotoCaptureCounts({});
      setPersonEmpNo("");
      setPersonName("");
      setPersonQuery("");
      setPersonDupWarn(null);
      personDupSeq.current += 1;
      setBedNo("");
      setSelectedAuditItem("");
      setReviewDate(todayStr());
      setActiveQuestionId(questions[0]?.id ?? "");
      setReviewMobileStep("basic");
      onAction(`已切換至排程單位 ${nextTask.unitId || "NA（不限單位）"}，請重新確認基本資料。`);
    } catch (error) {
      onAction(`切換排程單位失敗：${toErrorMessage(error)}`);
    } finally {
      setSwitchingSchedule(false);
    }
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

  /* ---------- 受審人員搜尋（可跨單位；單位不同時提醒但不阻擋） ---------- */
  const personSugg = useMemo(() => {
    const q = personQuery.trim();
    if (q === "") return [];
    return usersList
      .filter((u) => u.staffId.includes(q) || u.name.includes(q))
      .sort((a, b) => {
        const sa = a.status === "在職" ? 0 : 1;
        const sb = b.status === "在職" ? 0 : 1;
        return sa - sb || a.staffId.localeCompare(b.staffId);
      })
      .slice(0, 8);
  }, [personQuery, usersList]);

  const selectedPersonOption = usersList.find((person) => person.staffId === personEmpNo);
  const personUnitMismatch = Boolean(
    task?.unitId && selectedPersonOption?.unitCode && selectedPersonOption.unitCode !== task.unitId,
  );

  function selectPerson(u: PersonOption) {
    setPersonEmpNo(u.staffId);
    setPersonName(u.name);
    setPersonQuery("");
    setShowPersonSugg(false);
    void checkPersonDuplicate(u.staffId);
    if (task?.unitId && u.unitCode && u.unitCode !== task.unitId) {
      onAction(`提醒：受審人員編制單位為 ${u.unitCode}，與排程單位 ${task.unitId} 不同；仍可繼續審查。`);
    }
  }

  function handlePersonBarcode(value: string) {
    const scannedId = value.trim();
    setPersonBarcodeOpen(false);
    if (!scannedId) return;

    const normalizedId = scannedId.toLocaleLowerCase();
    const exactMatch = usersList.find(
      (user) => user.staffId.trim().toLocaleLowerCase() === normalizedId,
    );
    if (exactMatch) {
      selectPerson(exactMatch);
      return;
    }

    setPersonQuery(scannedId);
    setShowPersonSugg(true);
    onAction(`已讀取職編 ${scannedId}，請確認搜尋結果並選取受審人員。`);
  }

  /**
   * 選取受審人員時即時警示（v1.47.0）：查該指標該區間是否已有該人紀錄
   * （含匯入紀錄 source="import"，以月份落在區間內比對）；只警告、提前
   * 告知，送出時 assertUniqueReviewee 仍擋下。正在編輯的紀錄本身除外。
   */
  async function checkPersonDuplicate(empNo: string) {
    const seq = ++personDupSeq.current;
    if (!task || !empNo.trim()) {
      setPersonDupWarn(null);
      return;
    }
    try {
      const db = getFirebaseDb();
      // 讀量優化：只查「該指標＋該受審人員」的紀錄（原本整個指標全讀，每選一人讀一次）
      const snap = await getDocs(
        query(
          collection(db, "reviewRecords"),
          where("indicatorId", "==", task.indicatorId),
          where("reviewedPersonEmpNo", "==", empNo.trim()),
        ),
      );
      const taskKeys = intervalMonthKeys(task);
      let hasImport = false;
      let hasFormal = false;
      for (const d of snap.docs) {
        if (d.id === editingId) continue;
        const data = d.data() as Record<string, unknown>;
        if (String(data.reviewedPersonEmpNo ?? "") !== empNo.trim()) continue;
        const keys = intervalMonthKeys({
          year: Number(data.year ?? 0),
          month: Number(data.month ?? 0),
          scheduleStartYear:
            typeof data.scheduleStartYear === "number"
              ? data.scheduleStartYear
              : undefined,
          scheduleStartMonth:
            typeof data.scheduleStartMonth === "number"
              ? data.scheduleStartMonth
              : undefined,
          scheduleEndYear:
            typeof data.scheduleEndYear === "number"
              ? data.scheduleEndYear
              : undefined,
          scheduleEndMonth:
            typeof data.scheduleEndMonth === "number"
              ? data.scheduleEndMonth
              : undefined,
        });
        let overlap = false;
        for (const key of keys) {
          if (taskKeys.has(key)) {
            overlap = true;
            break;
          }
        }
        if (!overlap) continue;
        if (String(data.source ?? "") === "import") hasImport = true;
        else hasFormal = true;
      }
      if (seq !== personDupSeq.current) return;
      if (hasImport && hasFormal)
        setPersonDupWarn(
          "提醒：此受審人員在本審查區間已有正式審查紀錄及匯入紀錄，同一區間同一指標一人只審一次，送出時將無法重複審查。",
        );
      else if (hasImport)
        setPersonDupWarn(
          "提醒：此受審人員在本審查區間已有匯入紀錄，同一區間同一指標一人只審一次，送出時將無法重複審查。",
        );
      else if (hasFormal)
        setPersonDupWarn(
          "提醒：此受審人員在本審查區間已有正式審查紀錄，同一區間同一指標一人只審一次，送出時將無法重複審查。",
        );
      else setPersonDupWarn(null);
    } catch {
      if (seq === personDupSeq.current) setPersonDupWarn(null);
    }
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
  async function handleSaveDraft() {
    if (!task) return;
    const selectedMonth = auditMonthOptions.find((option) => option.value === auditMonth && option.active);
    if (!selectedMonth) {
      setReviewMobileStep("basic");
      onAction(auditMonthError || "請選擇尚未封存的稽核月份");
      return;
    }
    const [auditYear, auditMonthNumber] = auditMonth.split("-").map(Number);
    setSubmitting(true);
    try {
      const db = getFirebaseDb();
      const currentDraft = editingDraftId
        ? drafts.find((draft) => draft.id === editingDraftId)
        : undefined;
      const answerList: ReviewAnswer[] = questions.flatMap((q) => {
        const index = answers[q.id];
        if (index == null) return [];
        const label = optionLabelsOf(q.optionSet)[index];
        if (!label) return [];
        const note = (notes[q.id] ?? "").trim();
        return [{
          questionId: q.id,
          itemText: q.itemText,
          optionLabel: label,
          score: label === "是" ? 1 : 0,
          excluded: label === "不適用",
          ...((commonErrorAnswers[q.id] ?? []).length ? { commonErrors: commonErrorAnswers[q.id] } : {}),
          ...(note ? { note } : {}),
          ...(photoUrlsByQuestion[q.id]?.length ? { photoUrls: photoUrlsByQuestion[q.id] } : {}),
        }];
      });
      const score = computeOptionSetScore(answerList.map((a) => ({ score: a.score, excluded: !!a.excluded })));
      const personId = personEmpNo.trim();
      const intervalId = reviewIntervalIdentity(task);
      const uniqueKey = personId ? reviewUniqueDocId(task.indicatorId, intervalId, personId) : "";
      if (personId) await assertUniqueReviewee(personId, { draftId: currentDraft?.id });

      const quotaState = sharedQuotaTask
        ? await loadPeriodicQuotaCount(task)
        : { count: records.length, draftCount: drafts.length, occupiedSlots: [] as number[] };
      if (!currentDraft && quotaState.count + quotaState.draftCount >= requiredCases(task.caseCount))
        throw new Error(`本審查區間已有 ${quotaState.draftCount} 筆暫存未送出且名額已滿；請先送出或刪除暫存`);
      const quotaCaseNo = currentDraft?.quotaCaseNo ?? (sharedQuotaTask
        ? nextAvailableQuotaSlot(quotaState.occupiedSlots, requiredCases(task.caseCount))
        : undefined);
      if (sharedQuotaTask && quotaCaseNo == null)
        throw new Error("本審查區間名額已滿，請先送出或刪除暫存");
      const caseSeq = currentDraft?.caseSeq ?? nextCaseSeq(records.length + drafts.length);
      const draftRef = currentDraft
        ? doc(db, "reviewDrafts", currentDraft.id)
        : doc(collection(db, "reviewDrafts"));
      const oldDraftSnap = currentDraft ? await getDoc(draftRef) : null;
      const oldDraftData = oldDraftSnap?.exists()
        ? oldDraftSnap.data() as Record<string, unknown>
        : {};
      const oldUniqueKey = typeof oldDraftData.uniqueKey === "string" ? oldDraftData.uniqueKey : "";
      const payload: Record<string, unknown> = {
        taskId: task.id,
        indicatorId: task.indicatorId,
        unitId: task.unitId,
        reviewerId: task.reviewerId,
        year: auditYear,
        month: auditMonthNumber,
        ...(task.indicatorVersionAtSchedule ? { indicatorVersionAtSchedule: task.indicatorVersionAtSchedule } : {}),
        ...(typeof task.thresholdAtSchedule === "number" ? { thresholdAtSchedule: task.thresholdAtSchedule } : {}),
        thresholdRuleAtSchedule: task.thresholdRuleAtSchedule ?? ">=",
        scheduleStartYear: task.scheduleStartYear ?? task.year,
        scheduleStartMonth: task.scheduleStartMonth ?? task.month,
        scheduleEndYear: task.scheduleEndYear ?? task.year,
        scheduleEndMonth: task.scheduleEndMonth ?? task.month,
        caseSeq,
        reviewDate,
        reviewerEmpNo: reviewerEmpNo.trim(),
        reviewerName: reviewerName.trim(),
        reviewedPersonEmpNo: personId,
        reviewedPersonName: personName.trim(),
        bedNo: bedNo.trim(),
        auditItem: selectedAuditItem,
        answers: answerList,
        totalScore: score.totalScore,
        maxScore: score.maxScore,
        rate: score.rate,
        status: "draft",
        createdBy: typeof oldDraftData.createdBy === "string" ? oldDraftData.createdBy : staffId,
        createdAt: oldDraftData.createdAt ?? serverTimestamp(),
        updatedBy: staffId,
        updatedAt: serverTimestamp(),
        ...(uniqueKey ? { uniqueKey } : { uniqueKey: "" }),
        ...(sharedQuotaTask ? {
          quotaGroupId: task.quotaGroupId,
          quotaCaseNo,
          quotaSlotDocId: periodicQuotaSlotDocId(task.quotaGroupId, quotaCaseNo!),
        } : {}),
      };
      const batch = writeBatch(db);
      if (oldUniqueKey && oldUniqueKey !== uniqueKey)
        batch.delete(doc(db, "reviewReservations", oldUniqueKey));
      if (uniqueKey) {
        const reservationRef = doc(db, "reviewReservations", uniqueKey);
        const reservationSnap = await getDoc(reservationRef);
        if (!reservationSnap.exists()) {
          batch.set(reservationRef, {
            uniqueKey,
            ownerId: staffId,
            targetCollection: "reviewDrafts",
            targetId: draftRef.id,
            taskId: task.id,
            indicatorId: task.indicatorId,
            intervalId,
            personEmpNo: personId,
            status: "draft",
            createdAt: serverTimestamp(),
          });
        } else {
          const existing = reservationSnap.data() as Record<string, unknown>;
          if (String(existing.targetId ?? "") !== draftRef.id)
            throw new Error("此受審人員的唯一名額已被其他審查紀錄或暫存占用");
        }
      }
      batch.set(draftRef, payload, { merge: true });
      await batch.commit();
      const nextDrafts = await loadDraftRecords(task.id);
      setDrafts(nextDrafts);
      if (sharedQuotaTask) {
        const updatedQuota = await loadPeriodicQuotaCount(task);
        setQuotaDoneCount(updatedQuota.count);
        setQuotaDraftCount(updatedQuota.draftCount);
      }
      setEditingDraftId(null);
      setAnswers({});
      setNotes({});
      setCommonErrorAnswers({});
      setPhotoUrlsByQuestion({});
      setPhotoCaptureCounts({});
      setActiveQuestionId(questions[0]?.id ?? "");
      setPersonEmpNo("");
      setPersonName("");
      setBedNo("");
      onAction(`審查內容已暫存，尚未列入正式紀錄或分析${Object.values(photoCaptureCounts).some((count) => count > 0) ? "；本次拍照未保存" : ""}`);
    } catch (error) {
      onAction(`暫存失敗：${toErrorMessage(error)}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteDraft(draft: CaseRecordRow) {
    if (!task) return;
    if (!window.confirm(`確定刪除第 ${draft.caseSeq ?? "—"} 件暫存？此操作無法復原。`)) return;
    try {
      const db = getFirebaseDb();
      const batch = writeBatch(db);
      const draftRef = doc(db, "reviewDrafts", draft.id);
      const snap = await getDoc(draftRef);
      const data = snap.exists() ? snap.data() as Record<string, unknown> : {};
      const uniqueKey = typeof data.uniqueKey === "string" ? data.uniqueKey : "";
      if (uniqueKey) {
        const lockRef = doc(db, "reviewReservations", uniqueKey);
        const lockSnap = await getDoc(lockRef);
        if (lockSnap.exists() && String(lockSnap.data().targetId ?? "") === draft.id)
          batch.delete(lockRef);
      }
      batch.delete(draftRef);
      await batch.commit();
      setDrafts(await loadDraftRecords(task.id));
      if (editingDraftId === draft.id) setEditingDraftId(null);
      if (sharedQuotaTask) {
        const updatedQuota = await loadPeriodicQuotaCount(task);
        setQuotaDoneCount(updatedQuota.count);
        setQuotaDraftCount(updatedQuota.draftCount);
      }
      onAction("暫存已刪除");
    } catch (error) {
      onAction(`刪除暫存失敗：${toErrorMessage(error)}`);
    }
  }

  async function handleSubmit() {
    if (!task) return;
    if (task.status === "locked") {
      onAction("任務已鎖定，請先申請解鎖");
      return;
    }
    const firstMissing = questions.find((q) => answers[q.id] == null);
    if (firstMissing) {
      onAction(`第 ${questions.indexOf(firstMissing) + 1} 題尚未作答`);
      setReviewMobileStep("questions");
      setActiveQuestionId(firstMissing.id);
      window.setTimeout(() => document.getElementById(`req-q-${firstMissing.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
      return;
    }
    if (!reviewerEmpNo.trim()) {
      setReviewMobileStep("basic");
      onAction("請填寫審查人員職編");
      return;
    }
    if (requireReviewee && !personEmpNo.trim()) {
      setReviewMobileStep("basic");
      onAction("請選擇受審人員");
      return;
    }
    if (requireBedNo && !bedNo.trim()) {
      setReviewMobileStep("basic");
      onAction("請填寫病人床號");
      return;
    }
    if (auditItems.length > 0 && !selectedAuditItem) {
      setReviewMobileStep("basic");
      onAction("請選擇審核項目");
      return;
    }
    const activeAuditMonth = auditMonthOptions.some((option) => option.value === auditMonth && option.active);
    if (!activeAuditMonth && !editingId) {
      setReviewMobileStep("basic");
      onAction(auditMonthError || "請選擇尚未封存的稽核月份");
      return;
    }
    const [auditYear, auditMonthNumber] = auditMonth.split("-").map(Number);
    if (!auditYear || auditMonthNumber < 1 || auditMonthNumber > 12) {
      setReviewMobileStep("basic");
      onAction("請選擇有效的稽核月份");
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
          ...(photoUrlsByQuestion[q.id]?.length ? { photoUrls: photoUrlsByQuestion[q.id] } : {}),
        };
      });
      const { totalScore, maxScore, rate } = computeOptionSetScore(
        answerList.map((a) => ({ score: a.score, excluded: !!a.excluded })),
      );
      const editId =
        target.mode === "task" ? (target.editRecordId ?? editingId) : editingId;
      if (!editId) {
        const archiveIds = await findArchiveIdsForRecord(db, task.indicatorId, auditYear, auditMonthNumber);
        if (archiveIds.length > 0) {
          setAuditMonthOptions((previous) => previous.filter((option) => option.value !== auditMonth));
          setAuditMonth("");
          setAuditMonthError("所選月份已封存，請改選尚未封存的稽核月份。");
          setReviewMobileStep("basic");
          throw new Error("所選稽核月份已封存，請返回基本資料改選月份。");
        }
      }
      if (editId) {
        // 單件更新：不增加件數
        const recordRef = doc(db, "reviewRecords", editId);
        const previousSnap = await getDoc(recordRef);
        if (!previousSnap.exists()) throw new Error("找不到要修改的審查紀錄");
        const previous = previousSnap.data() as Record<string, unknown>;
        const intervalId = reviewIntervalIdentity(task);
        const personId = personEmpNo.trim();
        const uniqueKey = personId ? reviewUniqueDocId(task.indicatorId, intervalId, personId) : "";
        if (personId) await assertUniqueReviewee(personId, { recordId: editId });
        const nextValues: Record<string, unknown> = {
          answers: answerList,
          totalScore,
          maxScore,
          rate,
          reviewDate,
          reviewerEmpNo: reviewerEmpNo.trim(),
          reviewerName: reviewerName.trim(),
          reviewedPersonEmpNo: personId,
          reviewedPersonName: personName.trim(),
          uniqueKey,
          bedNo: bedNo.trim(),
          auditItem: selectedAuditItem,
          ...(task.indicatorVersionAtSchedule
            ? { indicatorVersionAtSchedule: task.indicatorVersionAtSchedule }
            : {}),
          ...(typeof task.thresholdAtSchedule === "number"
            ? { thresholdAtSchedule: task.thresholdAtSchedule }
            : {}),
          ...(typeof task.scheduleStartYear === "number"
            ? { scheduleStartYear: task.scheduleStartYear }
            : {}),
          ...(typeof task.scheduleStartMonth === "number"
            ? { scheduleStartMonth: task.scheduleStartMonth }
            : {}),
          ...(typeof task.scheduleEndYear === "number"
            ? { scheduleEndYear: task.scheduleEndYear }
            : {}),
          ...(typeof task.scheduleEndMonth === "number"
            ? { scheduleEndMonth: task.scheduleEndMonth }
            : {}),
        };
        const changes: Record<string, { before: unknown; after: unknown }> = {};
        for (const [key, after] of Object.entries(nextValues)) {
          const before = previous[key] ?? (key === "answers" ? [] : "");
          if (JSON.stringify(before) !== JSON.stringify(after)) {
            changes[key] = { before, after };
          }
        }
        // v1.64.1：區間已封存摘要 → 修改不直接寫入，改送審核（核准才生效並重新封存）
        if (Object.keys(changes).length > 0) {
          const archiveIds = await findArchiveIdsForRecord(
            db,
            task.indicatorId,
            Number(previous.year ?? task.year),
            Number(previous.month ?? task.month),
          );
          if (archiveIds.length > 0) {
            if (await hasPendingEditRequest(db, editId))
              throw new Error("此紀錄已有待審核的修改申請，請等待核准或駁回後再修改");
            const reason = (
              window.prompt(
                "此區間的摘要已封存。修改需送召集人／執行幹事／系統管理員審核，核准後才會生效。\n請填寫修改原因：",
              ) ?? ""
            ).trim();
            if (!reason) {
              onAction("已取消：未填寫修改原因，修改未送出");
              return;
            }
            let groupId = "";
            try {
              const indSnap = await getDoc(doc(db, "indicators", task.indicatorId));
              const g = indSnap.exists() ? (indSnap.data() as Record<string, unknown>).groupId : "";
              groupId = typeof g === "string" ? g : "";
            } catch {
              /* 查不到群組就留空：管理員仍可審核 */
            }
            await createEditRequest(db, {
              recordId: editId,
              taskId: task.id,
              indicatorId: task.indicatorId,
              groupId,
              unitId: task.unitId,
              year: Number(previous.year ?? task.year),
              month: Number(previous.month ?? task.month),
              archiveIds,
              reason,
              requestedBy: staffId,
              requestedByName: user?.name ?? staffId,
              changes,
              nextValues,
              baseVersion: typeof previous.version === "number" ? previous.version : null,
              oldUniqueKey: typeof previous.uniqueKey === "string" ? previous.uniqueKey : "",
              newUniqueKey: uniqueKey,
              intervalId,
              personEmpNo: personId,
            });
            onAction(`此區間已封存：修改已送出審核，核准後才會生效${Object.values(photoCaptureCounts).some((count) => count > 0) ? "；本次拍照未保存" : ""}`);
            if (target.mode === "records") {
              setEditingId(null);
            } else {
              onBack();
            }
            return;
          }
        }
        const editedAt = new Date().toISOString();
        const editHistory = Array.isArray(previous.editHistory)
          ? [...previous.editHistory]
          : [];
        if (Object.keys(changes).length > 0) {
          editHistory.push({
            actorId: staffId,
            actorName: user?.name ?? staffId,
            editedAt,
            changes,
          });
        }
        const updatePayload = {
          ...nextValues,
          ...(typeof previous.quotaGroupId === "string"
            ? { version: Number(previous.version ?? 1) + 1 }
            : {}),
          ...(Object.keys(changes).length > 0
            ? {
                editHistory,
                lastModifiedAt: serverTimestamp(),
                lastModifiedBy: staffId,
                lastModifiedByName: user?.name ?? staffId,
              }
            : {}),
        };
        const batch = writeBatch(db);
        const oldUniqueKey = typeof previous.uniqueKey === "string" ? previous.uniqueKey : "";
        if (oldUniqueKey && oldUniqueKey !== uniqueKey)
          batch.delete(doc(db, "reviewReservations", oldUniqueKey));
        if (uniqueKey) {
          const reservationRef = doc(db, "reviewReservations", uniqueKey);
          const reservationSnap = await getDoc(reservationRef);
          if (!reservationSnap.exists()) {
            batch.set(reservationRef, {
              uniqueKey,
              ownerId: staffId,
              targetCollection: "reviewRecords",
              targetId: editId,
              taskId: task.id,
              indicatorId: task.indicatorId,
              intervalId,
              personEmpNo: personId,
              status: "submitted",
              createdAt: serverTimestamp(),
            });
          } else {
            const existing = reservationSnap.data() as Record<string, unknown>;
            if (String(existing.targetId ?? "") !== editId)
              throw new Error("此受審人員的唯一名額已被其他審查紀錄或暫存占用");
          }
        }
        batch.update(recordRef, updatePayload);
        if (Object.keys(changes).length > 0) {
          batch.set(doc(collection(db, "auditLogs")), {
            actor: staffId,
            actorName: user?.name ?? staffId,
            action: "修改正式審查結果",
            targetType: "reviewRecord",
            targetId: editId,
            detail: `指標「${task.indicatorId}」／單位「${task.unitId}」；異動欄位：${Object.keys(changes).join("、")}`,
            before: Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value.before])),
            after: Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value.after])),
            createdAt: serverTimestamp(),
          });
        }
        await batch.commit();
        const recs = await loadCaseRecords(task.id);
        setRecords(recs);
        if (sharedQuotaTask) {
          try {
            const quotaState = await loadPeriodicQuotaCount(task);
            setQuotaDoneCount(quotaState.count);
          } catch {
            // 更新成功後仍回到查詢列表；下次載入會重新取得區間件數。
          }
        }
        onAction(`已更新審查結果${rate != null ? `，正確率 ${rate}%` : ""}${Object.values(photoCaptureCounts).some((count) => count > 0) ? "；本次拍照未保存至審查結果" : ""}`);
        if (target.mode === "records") {
          setEditingId(null); // 回到查詢列表
        } else {
          onBack();
        }
      } else {
        // 正式提交：新建紀錄或把暫存轉為正式紀錄
        const editingDraft = editingDraftId
          ? drafts.find((draft) => draft.id === editingDraftId)
          : undefined;
        const intervalId = reviewIntervalIdentity(task);
        const personId = personEmpNo.trim();
        const uniqueKey = personId
          ? reviewUniqueDocId(task.indicatorId, intervalId, personId)
          : "";
        if (personId)
          await assertUniqueReviewee(personId, { draftId: editingDraft?.id });
        const quotaState = sharedQuotaTask
          ? await loadPeriodicQuotaCount(task)
          : { count: records.length, draftCount: drafts.length, occupiedSlots: [] };
        const beforeCount = quotaState.count;
        if (sharedQuotaTask) {
          setQuotaDoneCount(beforeCount);
          setQuotaDraftCount(quotaState.draftCount);
        }
        const usedBefore = beforeCount + quotaState.draftCount;
        if (!editingDraft && isTaskComplete(usedBefore, task.caseCount)) {
          setAllDone(true);
          throw new Error(`本審查區間已達 ${requiredCases(task.caseCount)} 件；其中 ${quotaState.draftCount} 筆暫存未送出，請先送出或刪除暫存`);
        }
        const quotaSlot = editingDraft?.quotaCaseNo ?? (sharedQuotaTask
          ? nextAvailableQuotaSlot(
              quotaState.occupiedSlots,
              requiredCases(task.caseCount),
            )
          : null);
        if (sharedQuotaTask && quotaSlot == null) {
          throw new Error("本審查區間名額已被其他審查員使用，請重新讀取進度後再試");
        }
        const seq = editingDraft?.caseSeq ?? nextCaseSeq(records.length + drafts.length);
        const taskId = task.id;
        const quotaSlotId =
          sharedQuotaTask && quotaSlot != null
            ? periodicQuotaSlotDocId(task.quotaGroupId, quotaSlot)
            : "";
        const recordId = sharedQuotaTask
          ? quotaSlotId
          : reviewCaseDocId(taskId, seq);
        const recordRef = doc(db, "reviewRecords", recordId);
        const recordData: Record<string, unknown> = {
          taskId,
          indicatorId: task.indicatorId,
          unitId: task.unitId,
          reviewerId: task.reviewerId,
          year: auditYear,
          month: auditMonthNumber,
          ...(task.indicatorVersionAtSchedule
            ? { indicatorVersionAtSchedule: task.indicatorVersionAtSchedule }
            : {}),
          ...(typeof task.thresholdAtSchedule === "number"
            ? { thresholdAtSchedule: task.thresholdAtSchedule }
            : {}),
          thresholdRuleAtSchedule: task.thresholdRuleAtSchedule ?? ">=",
          scheduleStartYear: task.scheduleStartYear ?? task.year,
          scheduleStartMonth: task.scheduleStartMonth ?? task.month,
          scheduleEndYear: task.scheduleEndYear ?? task.year,
          scheduleEndMonth: task.scheduleEndMonth ?? task.month,
          caseSeq: seq,
          reviewDate,
          reviewerEmpNo: reviewerEmpNo.trim(),
          reviewerName: reviewerName.trim(),
          reviewedPersonEmpNo: personId,
          reviewedPersonName: personName.trim(),
          uniqueKey,
          bedNo: bedNo.trim(),
          auditItem: selectedAuditItem,
          answers: answerList,
          totalScore,
          maxScore,
          rate,
          submittedAt: serverTimestamp(),
          submittedBy: staffId,
          ...(sharedQuotaTask
            ? {
                quotaGroupId: task.quotaGroupId,
                quotaCaseNo: quotaSlot,
                quotaSlotDocId: quotaSlotId,
                version: 1,
              }
            : {}),
        };
        const batch = writeBatch(db);
        if (editingDraft) {
          batch.delete(doc(db, "reviewDrafts", editingDraft.id));
          const draftSnap = await getDoc(doc(db, "reviewDrafts", editingDraft.id));
          const draftData = draftSnap.exists() ? draftSnap.data() as Record<string, unknown> : {};
          const oldUniqueKey = typeof draftData.uniqueKey === "string" ? draftData.uniqueKey : "";
          if (oldUniqueKey && oldUniqueKey !== uniqueKey)
            batch.delete(doc(db, "reviewReservations", oldUniqueKey));
        }
        if (uniqueKey) {
          const reservationRef = doc(db, "reviewReservations", uniqueKey);
          const reservationSnap = await getDoc(reservationRef);
          if (reservationSnap.exists()) {
            const existing = reservationSnap.data() as Record<string, unknown>;
            if (String(existing.targetId ?? "") !== editingDraft?.id && String(existing.targetId ?? "") !== recordId)
              throw new Error("此受審人員的唯一名額已被其他審查紀錄或暫存占用");
            batch.set(reservationRef, {
              ...existing,
              uniqueKey,
              targetCollection: "reviewRecords",
              targetId: recordId,
              taskId,
              indicatorId: task.indicatorId,
              intervalId,
              personEmpNo: personId,
              status: "submitted",
            });
          } else {
            batch.set(reservationRef, {
              uniqueKey,
              ownerId: staffId,
              targetCollection: "reviewRecords",
              targetId: recordId,
              taskId,
              indicatorId: task.indicatorId,
              intervalId,
              personEmpNo: personId,
              status: "submitted",
              createdAt: serverTimestamp(),
            });
          }
        }
        batch.set(recordRef, recordData);
        // v1.73.0：逾時提示＋送出後向伺服器讀回確認（見 lib/confirmedCommit）
        const commitResult = await commitAndVerify(batch, recordRef, {
          onSlow: () =>
            onAction("尚未收到伺服器確認儲存（可能網路不穩或系統用量額度已滿），請勿關閉或重新整理此頁面，稍候會自動重試。"),
        });
        const req = requiredCases(task.caseCount);
        const completedCount = beforeCount + 1;
        if (sharedQuotaTask) {
          setQuotaDoneCount(completedCount);
        }
        const completed = isTaskComplete(completedCount, task.caseCount);
        // 紀錄已儲存；以下為任務狀態同步與畫面重讀，失敗不得回報成「送出失敗」，
        // 任務狀態會在下次載入時自動校正。
        let postSyncFailed = false;
        try {
          if (sharedQuotaTask) {
            try {
              await syncPeriodicQuotaTaskStatus(task, completed);
            } catch {
              // 審查紀錄已成功儲存，task 狀態會在下次載入時重新同步。
            }
          } else if (completed) {
            await updateDoc(doc(db, "reviewTasks", taskId), {
              status: "done",
              completedAt: serverTimestamp(),
            });
          }
          setAllDone(completed);
          setRecords(await loadCaseRecords(taskId));
          const freshDrafts = await loadDraftRecords(taskId);
          setDrafts(freshDrafts);
          setEditingDraftId(null);
          if (sharedQuotaTask) {
            const updatedQuota = await loadPeriodicQuotaCount(task);
            setQuotaDoneCount(updatedQuota.count);
            setQuotaDraftCount(updatedQuota.draftCount);
          }
        } catch {
          postSyncFailed = true;
          setAllDone(completed);
          setEditingDraftId(null);
        }
        setAnswers({}); // 清空答案，保留日期／審查人員，繼續下一件
        setCommonErrorAnswers({});
        setNotes({});
        setPhotoUrlsByQuestion({});
        setPhotoCaptureCounts({});
        setActiveQuestionId(questions[0]?.id ?? "");
        setPersonEmpNo("");
        setPersonName("");
        setPersonQuery("");
        setBedNo("");
        onAction(
          `${commitResult === "confirmed" ? "已確認儲存，" : "已送出（伺服器已接受，但讀回確認暫時失敗），"}${postSyncFailed ? "進度畫面暫時無法更新，稍後重新整理；" : ""}已送出第 ${sharedQuotaTask ? completedCount : seq} 件（${sharedQuotaTask ? "本區間合計" : "共需"} ${sharedQuotaTask ? `${completedCount}/` : ""}${req} 件）${rate != null ? `，正確率 ${rate}%` : ""}${Object.values(photoCaptureCounts).some((count) => count > 0) ? "；本次拍照僅作畫面標記，未保存至結果" : ""}`,
        );
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      if (sharedQuotaTask && code === "permission-denied") {
        onAction("本區間名額剛被其他審查員使用，請重新讀取進度後再送出");
      } else {
        onAction(`送出失敗：${toErrorMessage(error)}`);
      }
    } finally {
      setSubmitting(false);
    }
  }

  /* ---------- 畫面 ---------- */
  if (reviewerExpired) {
    return (
      <EmptyState
        title="審查員授權已到期"
        description="目前帳號的審查員效期已結束，無法繼續填寫審查表；請聯絡系統管理員或所屬群組管理者。"
      />
    );
  }

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

  const isRecordsView = target.mode === "records" && !editingId && !editingDraftId;
  const quotaFull = isTaskComplete(usedCount, task.caseCount);
  const selectedAuditMonthLabel = (() => {
    const [year, month] = auditMonth.split("-").map(Number);
    return year && month ? ymLabel(year, month) : "未選稽核月份";
  })();

  return (
    <div className="review-execute-page">
      <div style={{ marginBottom: 12 }}>
        <button className="button button-outline" onClick={onBack}>
          <ArrowLeft size={15} /> 返回儀表板
        </button>
      </div>
      <SectionTitle
        title={`${isRecordsView ? "審查結果查詢" : "審查表單"}：${indicatorName}`}
        note={`排程 ${ymLabel(task.year, task.month)}・稽核 ${selectedAuditMonthLabel}・${task.unitId || "NA（不限單位）"}・${sharedQuotaTask ? "正式紀錄／本區間" : "正式紀錄"} ${progressLabel(doneCount, task.caseCount)} 件${draftCount > 0 ? `・暫存未送出 ${draftCount} 件` : ""}`}
      />

      {!editingDraftId && drafts.length > 0 && (
        <section className="panel">
          <SectionTitle title={`暫存紀錄（${drafts.length}）`} note="暫存不列入正式結果與分析；可繼續編輯、送出或刪除。" />
          <div className="table-scroll"><table className="data-table"><thead><tr><th>件次</th><th>審查日期</th><th>受審人員</th><th>已作答</th><th>狀態</th><th>操作</th></tr></thead><tbody>{drafts.map((draft) => <tr key={draft.id}><td>第 {draft.caseSeq ?? "—"} 件</td><td>{draft.reviewDate || "—"}</td><td>{draft.reviewedPersonEmpNo ? staffLabel(draft.reviewedPersonEmpNo, draft.reviewedPersonName) : "尚未選人"}</td><td>{draft.answers.length}/{questions.length}</td><td><span className="status-pill warning">暫存未送出</span></td><td><button type="button" className="text-button" onClick={() => { prefillRecord(draft, questions); setEditingId(null); setEditingDraftId(draft.id); }}>繼續編輯</button>{" "}<button type="button" className="text-button" onClick={() => void handleDeleteDraft(draft)}>刪除</button></td></tr>)}</tbody></table></div>
        </section>
      )}

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
                          ? staffLabel(r.reviewerEmpNo, r.reviewerName)
                          : "—"}
                      </td>
                      <td>
                        {r.reviewedPersonEmpNo
                          ? staffLabel(r.reviewedPersonEmpNo, r.reviewedPersonName)
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
      ) : quotaFull && !editingId && !editingDraftId ? (
        <section className="panel" style={{ borderColor: "#e0a3a3" }}>
          <p style={{ marginTop: 0 }}><b>本審查區間件數已達設定上限，不能新增審查。</b></p>
          {draftCount > 0 ? <p className="settings-note">目前有 {draftCount} 筆暫存尚未送出，暫存會占用件數但不列正式紀錄；請先送出或刪除暫存。若清單中看不到，可回到該暫存所屬任務處理。</p> : <p className="settings-note">如需修正已送出的結果，請在查詢頁選擇該筆紀錄編輯。</p>}
        </section>
      ) : task.status === "locked" && !editingId && !editingDraftId ? (
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
          {!allDone && (
            <nav className="review-mobile-steps" aria-label="審查流程步驟">
              <button
                type="button"
                className={`review-mobile-step${reviewMobileStep === "basic" ? " active" : " complete"}`}
                aria-current={reviewMobileStep === "basic" ? "step" : undefined}
                onClick={() => setReviewMobileStep("basic")}
              >
                <span className="review-mobile-step-number">1</span>
                <span className="review-mobile-step-copy"><b>基本資料</b><small>受審資料與排程</small></span>
              </button>
              <span className="review-mobile-step-connector" aria-hidden="true" />
              <button
                type="button"
                className={`review-mobile-step${reviewMobileStep === "questions" ? " active" : ""}`}
                aria-current={reviewMobileStep === "questions" ? "step" : undefined}
                onClick={() => setReviewMobileStep("questions")}
              >
                <span className="review-mobile-step-number">2</span>
                <span className="review-mobile-step-copy"><b>逐題審查</b><small>已答 {answeredCount}/{questions.length} 題</small></span>
              </button>
              <span className="review-mobile-step-current" aria-live="polite">
                {reviewMobileStep === "basic" ? "基本資料" : `第 ${Math.max(activeQuestionIndex + 1, 1)} 題`}
              </span>
            </nav>
          )}
          <input
            ref={photoInputRef}
            className="review-camera-input"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleCameraSelection}
            tabIndex={-1}
            aria-hidden="true"
          />
          {editingDraftId && (
            <p className="dup-note">正在編輯暫存紀錄；按「提交審查結果」後才會列為正式紀錄。</p>
          )}
          {editingId && (
            <p className="dup-note">
              正在編輯單件審查結果，送出後僅更新該筆，不增加件數。
            </p>
          )}
          {allDone && !editingId && (
            <section className="panel" style={{ borderColor: "#9fd4c8" }}>
              <p style={{ margin: 0 }}>
                <b>✅ {sharedQuotaTask ? "本區間審查已完成" : "本單位審查已完成"}</b>
                <span className="muted-text">
                  （{sharedQuotaTask ? "本區間合計 " : ""}{progressLabel(doneCount, task.caseCount)} 件）
                </span>
              </p>
              <div className="form-actions" style={{ marginTop: 12 }}>
                <button className="button button-primary" onClick={onBack}>
                  返回儀表板
                </button>
              </div>
            </section>
          )}

          <section className={`panel review-mobile-page review-mobile-basic${reviewMobileStep === "questions" ? " is-inactive" : ""}`}>
            <div className="review-mobile-card-heading">
              <div><ListChecks size={18} /><b>審查基本資料</b></div>
              <small>確認排程與受審資料後開始逐題審查</small>
            </div>
            <div className="form-grid">
              <div className="form-field">
                <label className="field-label">指標名稱</label>
                <p>
                  <b>{indicatorName}</b>
                </p>
              </div>
              <div className="form-field">
                <label className="field-label">排程單位</label>
                {assignedScheduleTasks.length > 1 && !editingId && !editingDraftId ? (
                  <select
                    className="text-input"
                    value={task.id}
                    disabled={switchingSchedule}
                    onChange={(event) => void handleScheduleUnitChange(event.target.value)}
                    aria-label="選擇排程單位"
                  >
                    {assignedScheduleTasks.map((scheduledTask) => (
                      <option key={scheduledTask.id} value={scheduledTask.id}>
                        {scheduledTask.unitId || "NA（不限單位）"}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p>
                    <b>{task.unitId === "" ? "NA（不限單位）" : task.unitId}</b>
                    {(editingId || editingDraftId) && <span className="muted-text">（編輯中固定）</span>}
                  </p>
                )}
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
              <div className="form-field">
                <label className="field-label" htmlFor="review-audit-month">稽核月份 <span style={{ color: "#b3372f" }}>*</span></label>
                <select
                  id="review-audit-month"
                  className="text-input"
                  value={auditMonth}
                  disabled={Boolean(editingId)}
                  onChange={(event) => setAuditMonth(event.target.value)}
                  aria-label="選擇尚未封存的稽核月份"
                >
                  <option value="">請選擇尚未封存的月份</option>
                  {auditMonthOptions.map((option) => (
                    <option key={option.value} value={option.value} disabled={!option.active && !editingId}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {editingId && auditMonthOptions.some((option) => option.value === auditMonth && !option.active) && (
                  <small className="review-field-warning" role="status">原紀錄月份已封存，修改會沿用既有封存後送審流程。</small>
                )}
                {editingDraftId && auditMonthOptions.some((option) => option.value === auditMonth && !option.active) && (
                  <small className="review-field-warning" role="status">此暫存月份已封存；提交前請改選尚未封存月份。</small>
                )}
                {auditMonthError && !editingId && <small className="review-field-warning" role="status">{auditMonthError}</small>}
              </div>
              <div className="form-field" style={{ position: "relative" }}>
                <label className="field-label">審查人員（職編）</label>
                {reviewerEmpNo ? (
                  <p style={{ margin: "12px 0" }}>
                    <b>
                      {staffLabel(reviewerEmpNo, reviewerName)}
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
                              {staffLabel(u.staffId, u.name)}
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
                    受審人員（職編） <span style={{ color: "#b3372f" }}>*</span>
                  </label>
                  {personEmpNo ? (
                    <p style={{ margin: "12px 0" }}>
                      <b>
                        {staffLabel(personEmpNo, personName)}
                      </b>{" "}
                      <button
                        className="text-button"
                        onClick={() => {
                          setPersonEmpNo("");
                          setPersonName("");
                          setPersonQuery("");
                          setShowPersonSugg(true);
                          setPersonDupWarn(null);
                          personDupSeq.current += 1;
                        }}
                      >
                        更換
                      </button>
                    </p>
                  ) : (
                    <>
                      <div className="employee-id-input-row">
                        <input
                          type="text"
                          className="text-input"
                          placeholder="輸入職編或姓名搜尋（全院）"
                          value={personQuery}
                          onChange={(e) => {
                            setPersonQuery(e.target.value);
                            setShowPersonSugg(true);
                          }}
                          onFocus={() => setShowPersonSugg(true)}
                          aria-label="受審人員職編或姓名"
                        />
                        <button
                          type="button"
                          className="button button-outline employee-barcode-trigger"
                          onClick={() => setPersonBarcodeOpen(true)}
                          aria-label="掃描受審人員職編條碼或 QR Code"
                        >
                          <ScanLine size={17} />
                          <span>掃描職編</span>
                        </button>
                      </div>
                      {showPersonSugg && personSugg.length > 0 && (
                        <ul className="sugg-list">
                          {personSugg.map((u) => (
                            <li key={u.staffId}>
                              <button
                                type="button"
                                className="text-button"
                                onClick={() => selectPerson(u)}
                              >
                                {staffLabel(u.staffId, u.name)}
                                {u.unitCode && <span className="muted-text">（{u.unitCode}）</span>}
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
                  {personUnitMismatch && selectedPersonOption && (
                    <div className="review-unit-warning" role="status">
                      提醒：系統編制單位「{selectedPersonOption.unitCode}」與排程單位「{task.unitId}」不同；仍可繼續審查。
                    </div>
                  )}
                  {personDupWarn && (
                    <div
                      className="dup-note"
                      role="alert"
                      style={{ marginTop: 8 }}
                    >
                      {personDupWarn}
                    </div>
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
            <section className={`panel audit-item-selection review-mobile-page review-mobile-basic${reviewMobileStep === "questions" ? " is-inactive" : ""}`}>
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

          <div className={`review-mobile-page review-mobile-questions${reviewMobileStep === "basic" ? " is-inactive" : ""}`}>
          {questions.length === 0 ? (
            <EmptyState
              title="該指標尚未建立審查題目"
              description="請先至「指標管理」→ 該指標 →「審核表」頁籤建立題目後再回來填寫。"
            />
          ) : (
            <>
              <div className="review-workspace-layout">
                <QuestionNavigator
                  questions={questions}
                  answers={answers}
                  photoCounts={attachedPhotoCounts}
                  activeQuestionId={currentQuestionId}
                  answeredCount={answeredCount}
                  onSelect={(questionId) => {
                    setActiveQuestionId(questionId);
                    if (window.innerWidth > 1100) {
                      window.setTimeout(
                        () => document.getElementById(`req-q-${questionId}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
                        0,
                      );
                    }
                  }}
                />
                <div className="review-workspace-main">
                  <p className="settings-note review-photo-notice">
                    相機會開啟裝置拍照／照片選取器；目前照片只作本次畫面標記，不會保存至審查結果。
                  </p>
                  <ReviewQuestionList
                    mode="edit"
                    questions={questions}
                    showGroups={showQuestionGroups}
                    answers={answers}
                    commonErrorAnswers={commonErrorAnswers}
                    notes={notes}
                    activeQuestionId={currentQuestionId}
                    photoCounts={attachedPhotoCounts}
                    photoUrlsByQuestion={photoUrlsByQuestion}
                    photoCaptureCounts={photoCaptureCounts}
                    guidanceInline={mobileReviewLayout}
                    mobileLayout={mobileReviewLayout}
                    onTakePhoto={openQuestionCamera}
                    onAnswer={chooseAnswer}
                    onCommonErrors={(qid, values) =>
                      setCommonErrorAnswers((prev) => ({ ...prev, [qid]: values }))
                    }
                    onNote={(qid, text) =>
                      setNotes((prev) => ({ ...prev, [qid]: text }))
                    }
                  />
                  <div className="review-question-stepper" aria-label="題目導覽">
                    <button
                      type="button"
                      className="button button-outline"
                      disabled={activeQuestionIndex <= 0}
                      onClick={() =>
                        setActiveQuestionId(
                          questions[activeQuestionIndex - 1]?.id ?? "",
                        )
                      }
                    >
                      <ChevronLeft size={17} />上一題
                    </button>
                    <span>第 {Math.max(activeQuestionIndex + 1, 1)} / {questions.length} 題</span>
                    <button
                      type="button"
                      className="button button-primary"
                      disabled={
                        activeQuestionIndex < 0 ||
                        activeQuestionIndex >= questions.length - 1
                      }
                      onClick={() =>
                        setActiveQuestionId(
                          questions[activeQuestionIndex + 1]?.id ?? "",
                        )
                      }
                    >
                      下一題<ChevronRight size={17} />
                    </button>
                  </div>
                  <p className="settings-note review-live-score" aria-live="polite">
                    {editingId ? "修改後即時正確率" : "目前已答題正確率"}：
                    {liveScore.rate == null ? "—" : `${liveScore.rate}%`}
                    {`（已答 ${liveScore.answeredCount}/${questions.length} 題；不適用不計入分母）`}
                  </p>
                  <div
                    className="form-actions review-submit-actions"
                    style={{ marginBottom: 24 }}
                  >
                    {!editingId && (
                      <button
                        className="button button-outline"
                        disabled={submitting}
                        onClick={() => void handleSaveDraft()}
                      >
                        {submitting
                          ? "暫存中…"
                          : editingDraftId
                            ? "更新暫存"
                            : "暫存不送出"}
                      </button>
                    )}
                    <button
                      className="button button-primary review-submit-primary"
                      disabled={submitting}
                      onClick={handleSubmit}
                    >
                      <Check size={15} />{" "}
                      {submitting
                        ? "送出中…"
                        : editingId
                          ? "更新審查結果"
                          : editingDraftId
                            ? "提交審查結果"
                            : `送出第 ${nextCaseSeq(records.length + drafts.length)} 件`}
                    </button>
                    <button className="button button-ghost" onClick={onBack}>
                      取消返回
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
          </div>
          {!allDone && questions.length > 0 && (
            <div className="review-mobile-footer" role="group" aria-label="審查操作">
              <button
                type="button"
                className="button button-outline review-mobile-footer-back"
                aria-label={reviewMobileStep === "basic" ? "返回儀表板" : activeQuestionIndex <= 0 ? "返回基本資料" : "上一題"}
                onClick={() => {
                  if (reviewMobileStep === "basic") onBack();
                  else if (activeQuestionIndex <= 0) setReviewMobileStep("basic");
                  else setActiveQuestionId(questions[activeQuestionIndex - 1]?.id ?? "");
                }}
              >
                <ChevronLeft size={17} />
                {reviewMobileStep === "basic" ? "返回" : activeQuestionIndex <= 0 ? "基本資料" : "上一題"}
              </button>
              <span className="review-mobile-footer-note" aria-live="polite">
                {reviewMobileStep === "basic" ? "確認資料後開始逐題審查" : `已回答 ${answeredCount}/${questions.length} 題`}
              </span>
              <button
                type="button"
                className="button button-primary review-mobile-footer-next"
                disabled={submitting || (reviewMobileStep === "questions" && activeQuestionIndex < 0)}
                aria-label={reviewMobileStep === "basic" ? "開始逐題審查" : activeQuestionIndex >= questions.length - 1 ? "送出審查結果" : "前往下一題"}
                onClick={() => {
                  if (reviewMobileStep === "basic") setReviewMobileStep("questions");
                  else if (activeQuestionIndex >= questions.length - 1) void handleSubmit();
                  else setActiveQuestionId(questions[activeQuestionIndex + 1]?.id ?? "");
                }}
              >
                {reviewMobileStep === "basic" ? "開始審查" : activeQuestionIndex >= questions.length - 1 ? (editingId ? "更新結果" : "完成審查") : "下一題"}
                {reviewMobileStep === "questions" && activeQuestionIndex >= questions.length - 1 ? <Check size={17} /> : <ChevronRight size={17} />}
              </button>
            </div>
          )}
        </>
      )}
      {personBarcodeOpen && (
        <Suspense
          fallback={
            <div className="reviewer-modal-backdrop employee-barcode-backdrop" role="status">
              <div className="employee-barcode-loading">載入條碼掃描器…</div>
            </div>
          }
        >
          <BarcodeScannerDialog
            onDetected={handlePersonBarcode}
            onClose={() => setPersonBarcodeOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}


function QuestionNavigator({
  questions,
  answers,
  photoCounts,
  activeQuestionId,
  answeredCount,
  onSelect,
}: {
  questions: AuditQuestion[];
  answers: Record<string, number>;
  photoCounts: Record<string, number>;
  activeQuestionId: string;
  answeredCount: number;
  onSelect: (questionId: string) => void;
}) {
  const mobileNavRef = useRef<HTMLDivElement | null>(null);
  const items = questions.map((question, index) => ({
    question,
    index,
    answered: answers[question.id] != null,
    photoCount: photoCounts[question.id] ?? 0,
  }));
  const activeIndex = items.findIndex(({ question }) => question.id === activeQuestionId);
  useEffect(() => {
    const scrollActiveIntoView = () => {
      if (window.innerWidth > 1100) return;
      const nav = mobileNavRef.current;
      const active = nav?.querySelector<HTMLElement>(".review-question-nav-item.active");
      if (!nav || !active) return;
      const navRect = nav.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
      if (activeRect.left < navRect.left) {
        nav.scrollTo({ left: nav.scrollLeft - (navRect.left - activeRect.left), behavior });
      } else if (activeRect.right > navRect.right) {
        nav.scrollTo({ left: nav.scrollLeft + (activeRect.right - navRect.right), behavior });
      }
    };
    scrollActiveIntoView();
    window.addEventListener("resize", scrollActiveIntoView, { passive: true });
    return () => window.removeEventListener("resize", scrollActiveIntoView);
  }, [activeQuestionId]);
  const list = (compact: boolean) => (
    <div
      ref={compact ? mobileNavRef : undefined}
      className={
        compact ? "review-question-nav-grid" : "review-question-nav-list"
      }
    >
      {items.map(({ question, index, answered, photoCount }) => (
        <button
          key={question.id}
          type="button"
          className={`review-question-nav-item${
            question.id === activeQuestionId ? " active" : ""
          }${answered ? " answered" : " unanswered"}`}
          aria-label={`第 ${index + 1} 題，${answered ? "已作答" : "尚未作答"}${photoCount > 0 ? "，有拍照" : ""}`}
          aria-current={question.id === activeQuestionId ? "step" : undefined}
          onClick={() => onSelect(question.id)}
        >
          <span className="review-nav-number">
            {index + 1}
            {photoCount > 0 && (
              <Camera size={13} aria-label={`第 ${index + 1} 題已有照片`} />
            )}
          </span>
          <span className="review-nav-label">
            {question.itemText || `第 ${index + 1} 題`}
          </span>
          <span
            className="review-nav-state"
            aria-label={answered ? "已作答" : "尚未作答"}
          >
            {answered ? (
              <Check size={14} />
            ) : (
              <span className="review-nav-empty-dot" />
            )}
          </span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="review-question-navigator">
      <section className="review-question-mobile-nav" aria-label="題號導覽">
        <div className="review-question-mobile-nav-head">
          <ListChecks size={17} />
          <b>題號導覽</b>
          <span>第 {Math.max(activeIndex + 1, 1)}/{questions.length} 題・已答 {answeredCount} 題</span>
        </div>
        {list(true)}
      </section>
      <aside className="review-question-sidebar" aria-label="固定題號導覽">
        {list(false)}
      </aside>
    </div>
  );
}
