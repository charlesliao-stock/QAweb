/**
 * 品管審查（v1.19.0 改寫）：依權限列出「有排程且尚未結束」的指標排程。
 * 取代舊的指標審查總覽入口（選指標→各單位各輪次）。
 *
 * 角色範圍（多重身分取聯集；v1.21 新舊並認）：
 * - 審查員（舊／品管組／單位）：分工表中被指派的項目
 * - 單位護理長／單位執行幹事：自審排程（selfReview）且受審單位含本人單位
 * - 召集人／執行幹事（舊／品管組／單位）：擔任該角色的群組
 *   （memberships 為主，舊 groupIds fallback；單位級以其單位所屬群組計）
 * - 督導／副主任／主任、系統管理員：全部
 * 尚未結束＝今天≤最後區間結束月（含當月）且進度未達 100%
 * （進度改以審查紀錄計算，不依賴任務表）。
 * v1.20：只顯示包含本月區間的指標（今天不在任何區間內就不列）；
 * 表頭篩選列移除，改為清單上方篩選區（組別／指標／關鍵字）。
 * v1.46.0：清單上方篩選區改為組別／指標／進度／關鍵字；進度篩選器
 * （進行中／已結束／待完成，預設進行中）以今天精確到日判斷：
 * 進行中＝今天在區間內，或區間已結束、未過補資料日（空窗期）；
 * 已結束＝今天已過最後區間的補資料日（區間結束月下個月第
 * supplementDeadlineDay 日）；待完成＝今天在第一區間開始之前。
 * 一列一排程，顯示現階段區間；進行中 100% 的列顯示、但不給審查按鈕；
 * 已結束保留檢視（含檢視彈窗內的修改）；待完成無任何操作按鈕。
 * v1.59.1：審查員可見範圍改為聯集（分工表指派＋reviewTasks 任務指派，
 * 含無分工表的臨時加審／自審）；檢視彈窗按身分限縮單位摘要／明細
 * （審查員＝被指派單位、護理長＝自審本人單位、召集人／執行幹事＝所屬群組
 * 整列、管理員／高階主管＝全部）。執行頁 assignedUnitIds 限縮不動。
 */
import { loadRefCollection } from "../lib/refLoad";
import { toErrorMessage } from "../lib/errors";
import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ClipboardCheck,
  Eye,
  Pencil,
  X,
} from "lucide-react";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  where,
} from "../lib/db";
import { getFirebaseDb } from "../lib/firebase";
import { getCachedRef, SYSTEM_CONFIG_KEY } from "../lib/refCache";
import { getDocCacheFirst } from "../lib/cacheFirst";
import { fetchAllPaged } from "../lib/pagedQuery";
import { dbIndexedQueryApi, fetchIndicatorMonths } from "../lib/indexedRecords";
import {
  EmptyState,
  FilterPanel,
  FilterSearchField,
  ListPanel,
  PageHeading,
  SectionTitle,
  SortableTh,
  FormSelect,
  useSortState,
  useCompactLayout,
} from "../components/ui";
import { useAuth } from "../lib/auth";
import {
  archiveInterval,
  loadAllSummaries,
  type ArchiveTarget,
  type StoredSummary,
} from "../lib/summaryStore";
import { endedIntervalsOf } from "../lib/archiveReminder";
import { SUMMARY_SCHEMA_VERSION, isSummaryStale, summaryDocId } from "../lib/reviewSummary";
import {
  approveEditRequest,
  loadPendingEditRequests,
  rejectEditRequest,
  type EditRequest,
} from "../lib/editRequests";
import { usePermissions } from "../lib/usePermissions";
import { maskName, staffLabel } from "../lib/mask";
import { fmtIsoDateTime, fmtYmd } from "../lib/ym";
import {
  normalizeAssignmentItem,
  parseIndicatorSchedule,
  periodicQuotaGroupId,
  scheduleDocId,
  scheduleSetupComplete,
  type IndicatorSchedule,
} from "../lib/scheduling";
import {
  modalUnitScope,
  taskUnitsBySchedule,
  unionUnits,
  unitVisibleInModal,
  type AuditScheduleLike,
  type AuditTaskLike,
  type ModalUnitScope,
} from "../lib/auditVisibility";
import {
  groupsForRoles,
  isConvenerRole,
  isOfficerRole,
  isReviewerRole,
  parseMemberships,
} from "../lib/roleIdentity";
import { useOrgMeta } from "../lib/useOrgMeta";
import {
  convenerRoleNames,
  hasRoleCategory,
  hasRoleCategoryWithScope,
  officerRoleNames,
  titleFlagsOf,
} from "../lib/orgMeta";
import { deriveRoleCategory } from "../lib/roleDerivation";
import {
  auditRowMatches,
  classifyScheduleProgress,
  computeIntervalProgress,
  intervalDisplay,
  isProgressComplete,
  recordYearMonth,
  ymKey,
  type AuditProgressState,
  type IntervalProgress,
  type ReviewInterval,
} from "../lib/reviewActive";
import { isTaskComplete } from "../lib/reviewProgress";
import {
  effectiveThreshold,
  indicatorCodeOf,
  stripInternalIdPrefix,
  normalizeQuestions,
  type AuditQuestion,
} from "../lib/indicators";
import type { ReviewAnswer } from "../lib/reviewRecords";
import { ReviewExecutePage, type ExecuteTarget } from "./ReviewExecutePage";
import { ReviewQuestionList } from "./ReviewQuestionList";

interface IndicatorLite {
  id: string;
  code: string;
  name: string;
  groupId: string;
  /** v1.63.2：指標狀態（只列啟用指標的排程） */
  status: string;
  /** 目前生效閾值（判斷封存摘要是否過期） */
  threshold: number;
}

interface RecordRow {
  id: string;
  taskId: string;
  indicatorId: string;
  unitId: string;
  year: number;
  month: number;
  reviewDate: string;
  reviewerEmpNo: string;
  reviewerName: string;
  /** 受審人員職編（v1.50.0：檢視彈窗顯示職編/遮罩姓名） */
  reviewedPersonEmpNo: string;
  reviewedPersonName: string;
  /** 審核項目（v1.48.0）：無值為 ""，顯示為「—」 */
  auditItem: string;
  rate: number | null;
  quotaGroupId: string;
  source: string;
}

interface MonthOption {
  month: number;
  year: number;
  label: string;
}

interface ActiveRow {
  sched: IndicatorSchedule;
  indicatorId: string;
  indicatorCode: string;
  indicatorName: string;
  /** 指標目前生效閾值 */
  indicatorThreshold: number;
  groupId: string;
  groupName: string;
  /** v1.46.0：進度三態（進行中／已結束／待完成） */
  state: AuditProgressState;
  /** 進度是否已達 100%（進行中 100% 的列顯示、但不給審查按鈕） */
  complete: boolean;
  interval: ReviewInterval;
  intervalLabel: string;
  progress: IntervalProgress;
  reviewMonthCount: number;
  /** 本人被指派的單位（分工表）；空＝未被指派 */
  assignedUnitIds: string[];
  /** v1.88.19：本人被指派的審查月份（分工表 reviewMonths，"yyyy/mm"；空＝全部月份） */
  assignedReviewMonths: string[];
  /** v1.59.1：檢視彈窗可見單位（null＝該列全部可見；否則只列這些單位） */
  modalUnitIds: ModalUnitScope;
  monthOptions: MonthOption[];
  /** 該指標本區間的審查紀錄（檢視用） */
  records: RecordRow[];
  unitNameOf: (code: string) => string;
  /** v1.64.0：可封存摘要（系統管理員，或所屬群組的召集人／執行幹事） */
  canArchive: boolean;
  /** v1.65.2：進度取自封存摘要（records 為空，按「檢視」時才讀原始紀錄） */
  summarized: boolean;
  /** v1.65.1：該排程「已結束」的每個區間（可封存；overdue＝結束滿一個月仍未封存要提醒） */
  endedTargets: { id: string; label: string; overdue: boolean; target: ArchiveTarget }[];
}

type SortKey = "group" | "code" | "name" | "interval" | "person" | "unit";

function fmtPct(p: number | null): string {
  return p == null ? "—" : `${p}%`;
}

/** reviewRecords 文件 → 清單用紀錄列（無指標或年月不明回 null） */
function toRecordRow(id: string, v: Record<string, unknown>): RecordRow | null {
  const iid = typeof v.indicatorId === "string" ? v.indicatorId : "";
  if (!iid) return null;
  const ym = recordYearMonth(v);
  if (!ym) return null;
  const rate =
    typeof v.rate === "number" && Number.isFinite(v.rate) ? v.rate : null;
  return {
    id,
    taskId: typeof v.taskId === "string" ? v.taskId : id,
    indicatorId: iid,
    unitId: typeof v.unitId === "string" ? v.unitId : "",
    year: ym.year,
    month: ym.month,
    reviewDate: typeof v.reviewDate === "string" ? v.reviewDate : "",
    reviewerEmpNo: typeof v.reviewerEmpNo === "string" ? v.reviewerEmpNo : "",
    reviewerName: typeof v.reviewerName === "string" ? v.reviewerName : "",
    reviewedPersonEmpNo:
      typeof v.reviewedPersonEmpNo === "string" ? v.reviewedPersonEmpNo : "",
    reviewedPersonName:
      typeof v.reviewedPersonName === "string" ? v.reviewedPersonName : "",
    auditItem: typeof v.auditItem === "string" ? v.auditItem : "",
    rate,
    quotaGroupId: typeof v.quotaGroupId === "string" ? v.quotaGroupId : "",
    source: typeof v.source === "string" ? v.source : "",
  };
}

/** v1.65.2：本次啟動（頁面載入）已比對過有效排程變動的使用者，每位只比對一次 */
const scheduleChangeChecked = new Set<string>();

function schedLike(s: IndicatorSchedule) {
  return {
    category: s.category,
    period: s.period,
    months: s.months,
    frequency: s.frequency,
    intervalMonths: s.intervalMonths,
    refYear: s.refYear,
    // v1.88.19：臨時排程明確曆年月（區間推導以此為準）
    calendarMonths: s.calendarMonths,
  };
}

function ProgressCell({
  done,
  total,
  pct,
}: {
  done: number;
  total: number | null;
  pct: number | null;
}) {
  if (total == null) return <span className="muted-text">—</span>;
  const w = Math.min(100, Math.max(0, pct ?? 0));
  return (
    <div>
      <div>
        {done}／{total}（{fmtPct(pct)}）
      </div>
      {total > done && (
        <div className="muted-text" style={{ fontSize: "0.85em" }}>
          尚未完成 {total - done}
        </div>
      )}
      <div className="progress-track" aria-hidden="true">
        <div className="progress-fill" style={{ width: `${w}%` }} />
      </div>
    </div>
  );
}

/** 手機／平板的進度：單行「人次 n／m（x%）」，無進度條 */
function CompactProgress({
  label,
  done,
  total,
  pct,
}: {
  label: string;
  done: number;
  total: number | null;
  pct: number | null;
}) {
  return (
    <div>
      {label}{" "}
      {total == null ? "—" : `${done}／${total}（${fmtPct(pct)}）`}
    </div>
  );
}

export function AuditPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  const { user } = useAuth();
  const { can } = usePermissions();
  // v1.40.5：身分改以角色詮釋資料＋職稱旗標判斷，不再比對名稱
  const orgMeta = useOrgMeta();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ActiveRow[]>([]);
  const [dataRefreshKey, setDataRefreshKey] = useState(0);
  // v1.28 階段 6（B6）：審查紀錄分頁未拉完（觸及上限／分頁異常）時顯示可見提示
  const [recordsTruncated, setRecordsTruncated] = useState(false);
  // v1.59.1：本人任務分頁未拉完時顯示可見提示（任務不全＝加審／自審列可能少列）
  const [myTasksTruncated, setMyTasksTruncated] = useState(false);
  const { sortKey, sortDir, toggleSort, tableSort } = useSortState<SortKey>("group");
  const compact = useCompactLayout();
  // v1.20：清單上方篩選區（組別／指標／關鍵字）；表頭篩選列移除
  // v1.46.0：篩選區依序為組別／指標／進度／關鍵字；進度預設進行中
  const [selGroup, setSelGroup] = useState("");
  const [selIndicator, setSelIndicator] = useState("");
  const [selProgress, setSelProgress] =
    useState<AuditProgressState>("active");
  const [keyword, setKeyword] = useState("");
  const [keywordDraft, setKeywordDraft] = useState("");
  // 切到「已結束」才補讀歷史年份紀錄（之後維持已載入，避免來回切換重讀）
  const [historyLoaded, setHistoryLoaded] = useState(false);
  useEffect(() => {
    if (selProgress === "ended") setHistoryLoaded(true);
  }, [selProgress]);
  const [viewRow, setViewRow] = useState<ActiveRow | null>(null);
  const [selectedUnitFilter, setSelectedUnitFilter] = useState("");
  const [detailListOpen, setDetailListOpen] = useState(false);
  /** 檢視 modal：該指標題目（逐題明細分組＋指引用；v1.24） */
  const [viewQuestions, setViewQuestions] = useState<AuditQuestion[]>([]);
  const [viewShowGroups, setViewShowGroups] = useState(false);
  /** 檢視 modal：展開明細的紀錄 id 與其逐題作答 */
  const [expandedRecordId, setExpandedRecordId] = useState<string | null>(
    null,
  );
  const [expandedAnswers, setExpandedAnswers] = useState<ReviewAnswer[] | null>(
    null,
  );
  const [expandedEditHistory, setExpandedEditHistory] = useState<Record<string, unknown>[]>([]);
  const [expandedLoading, setExpandedLoading] = useState(false);
  const [execRow, setExecRow] = useState<ActiveRow | null>(null);
  const [execUnit, setExecUnit] = useState("");
  const [execMonth, setExecMonth] = useState("");
  /** v1.63.1：開窗時載入該排程區間內實際存在的任務（單位＋年月），選項只列有任務者 */
  const [execTaskKeys, setExecTaskKeys] = useState<Set<string> | null>(null);
  /** v1.88.19：已滿單位（已提交＋暫存 ≧ 應審件數；null＝尚未算出／讀取失敗，不反灰） */
  const [execFullUnits, setExecFullUnits] = useState<Set<string> | null>(null);
  const [execBusy, setExecBusy] = useState(false);
  /** v1.64.0：已封存的區間摘要（文件 ID → 摘要） */
  const [summaries, setSummaries] = useState<Map<string, StoredSummary>>(new Map());
  const [archivingId, setArchivingId] = useState<string | null>(null);
  /** v1.64.1：封存後修改待審申請（僅管理者範圍內可見者） */
  const [pendingReqs, setPendingReqs] = useState<EditRequest[]>([]);
  const [reqModalOpen, setReqModalOpen] = useState(false);
  const [viewLoadingKey, setViewLoadingKey] = useState<string | null>(null);
  const [reqBusyId, setReqBusyId] = useState<string | null>(null);
  /** v1.65.2：自上次進入品管審查後，有效排程的新增／取消 */
  const [scheduleChanges, setScheduleChanges] = useState<{
    added: string[];
    removed: string[];
  } | null>(null);
  const [executing, setExecuting] = useState<ExecuteTarget | null>(null);
  const [editableGroupIds, setEditableGroupIds] = useState<string[]>([]);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      setRows([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const db = getFirebaseDb();
        const staffId = user.staffId;
        const today = new Date();
        const [iSnap, gSnap, uSnap, sSnap, aSnap, meSnap, sysSnap, myTaskPage] =
          await Promise.all([
            loadRefCollection("indicators"),
            loadRefCollection("groups"),
            loadRefCollection("units"),
            getDocs(query(collection(db, "indicatorSchedules"), limit(500))),
            getDocs(query(collection(db, "indicatorAssignments"), limit(500))),
            getDoc(doc(db, "users", staffId)),
            // v1.46.0：補資料日取系統參數現值（讀不到用預設 10）
            getCachedRef(SYSTEM_CONFIG_KEY, () =>
              getDocCacheFirst(doc(db, "systemParams", "config")),
            ),
            // v1.59.1：本人任務（審查員聯集路徑；單一等號 where＋同欄位
            // orderBy，不需複合索引；分頁拉完，失敗／未拉完只影響聯集
            // 新增路徑，分工表路徑不受影響）
            fetchAllPaged(
              collection(db, "reviewTasks"),
              [where("reviewerId", "==", staffId)],
              undefined,
              { orderByField: "reviewerId" },
            ),
          ]);
        if (cancelled) return;
        let deadlineDay = 10;
        const sysData = sysSnap.data() as Record<string, unknown> | undefined;
        const dd = sysData?.supplementDeadlineDay;
        if (typeof dd === "number" && dd >= 1 && dd <= 31) deadlineDay = dd;

        const indicators = new Map<string, IndicatorLite>();
        iSnap.docs.forEach((d) => {
          const v = d.data() as Record<string, unknown>;
          indicators.set(d.id, {
            id: d.id,
            code: indicatorCodeOf(d.id),
            name: typeof v.name === "string" && v.name ? v.name : d.id,
            groupId: typeof v.groupId === "string" ? v.groupId : "",
            status: typeof v.status === "string" ? v.status : "",
            threshold: effectiveThreshold(v),
          });
        });
        const groupName = new Map<string, string>();
        gSnap.docs.forEach((d) => {
          const v = d.data() as Record<string, unknown>;
          groupName.set(
            d.id,
            typeof v.name === "string" && v.name ? v.name : d.id,
          );
        });
        const unitName = new Map<string, string>();
        const unitGroup = new Map<string, string>();
        uSnap.docs.forEach((d) => {
          const v = d.data() as Record<string, unknown>;
          unitName.set(
            d.id,
            typeof v.name === "string" && v.name ? v.name : d.id,
          );
          unitGroup.set(
            d.id,
            typeof v.groupId === "string" ? v.groupId : "",
          );
        });
        const unitNameOf = (code: string): string =>
          unitName.get(code) ?? code;
        const schedules: IndicatorSchedule[] = [];
        sSnap.docs.forEach((d) => {
          const s = parseIndicatorSchedule(d.data());
          if (s) schedules.push(s);
        });
        // 分工表：指標 → 審查員 → 單位與被分派月份（v1.88.19：已滿判斷用 reviewMonths）
        const reviewerOf = new Map<
          string,
          Map<string, { units: string[]; reviewMonths: string[] }>
        >();
        aSnap.docs.forEach((d) => {
          const v = d.data() as Record<string, unknown>;
          const indicatorId =
            typeof v.indicatorId === "string" ? v.indicatorId : d.id;
          const items = Array.isArray(v.items)
            ? v.items
                .map((it) => normalizeAssignmentItem(it))
                .filter((it) => it !== null)
            : [];
          const m = new Map<string, { units: string[]; reviewMonths: string[] }>();
          items.forEach((it) => {
            if (it)
              m.set(it.reviewerId, {
                units: it.units.map((u) => u.unitId),
                reviewMonths: it.reviewMonths ?? [],
              });
          });
          reviewerOf.set(indicatorId, m);
        });
        const meData = meSnap.exists()
          ? (meSnap.data() as Record<string, unknown>)
          : {};
        const myGroupIds = Array.isArray(meData.groupIds)
          ? (meData.groupIds as unknown[]).filter(
              (g): g is string => typeof g === "string",
            )
          : [];

        // ---- 角色範圍（多重身分取聯集；v1.40.5 改以類別／旗標判斷） ----
        const roles = user.roles ?? [];
        const title = user.title ?? "";
        const isAdmin = roles.includes("系統管理員");
        const flags = titleFlagsOf(
          title,
          user.titleId,
          orgMeta.titleMeta,
          orgMeta.titleMetaById,
        );
        const isSenior =
          flags.isHospitalHead ||
          flags.isDistrictHead ||
          hasRoleCategory(roles, "senior", orgMeta.roleMeta);
        const isReviewer = isReviewerRole(roles, orgMeta.roleMeta);
        const isHeadNurse =
          flags.isUnitHead ||
          flags.isOfficer ||
          hasRoleCategory(roles, "unitHead", orgMeta.roleMeta) ||
          hasRoleCategoryWithScope(roles, "officer", "unit", orgMeta.roleMeta);
        const isConvener =
          isConvenerRole(roles, orgMeta.roleMeta) ||
          isOfficerRole(roles, orgMeta.roleMeta);
        // 召集人／執行幹事的群組範圍：memberships 為主，舊 groupIds＋roles fallback；
        // 單位級角色以其單位所屬群組計
        const memberships = parseMemberships(meData.memberships, {
          roles,
          groupIds: myGroupIds,
        });
        const myConvenerGroupIds = groupsForRoles(
          memberships,
          // 角色主檔尚未載入時（空表）以本人 membership 角色的名稱關鍵字退路，
          // 載入後改以類別為準（召集人／執行幹事，不分組級／單位級）
          orgMeta.roleMeta.size === 0
            ? [...new Set(memberships.flatMap((m) => m.roles))].filter(
                (n) =>
                  deriveRoleCategory(n) === "convener" ||
                  deriveRoleCategory(n) === "officer",
              )
            : [
                ...convenerRoleNames(orgMeta.roleMeta),
                ...officerRoleNames(orgMeta.roleMeta),
              ],
          user.unitCode ? unitGroup.get(user.unitCode) : undefined,
          orgMeta.roleMeta,
          // v1.87.0：委員會 "ALL" 列展開為全部品管組
          [...groupName.keys()],
        );
        setEditableGroupIds(myConvenerGroupIds);

        // v1.59.1：本人任務（審查員聯集路徑；reviewTasks 無 scheduleId，
        // 以 indicatorId＋scheduleCategory＋schedulePeriod 對應排程，
        // 舊任務缺鍵時由 auditVisibility.ts fallback 歸屬）
        if (!cancelled) setMyTasksTruncated(myTaskPage.truncated);
        const myTasks: AuditTaskLike[] = [];
        myTaskPage.docs.forEach((d) => {
          const v = d.data() as Record<string, unknown>;
          const indicatorId =
            typeof v.indicatorId === "string" ? v.indicatorId : "";
          if (!indicatorId) return;
          myTasks.push({
            indicatorId,
            scheduleCategory:
              typeof v.scheduleCategory === "string"
                ? v.scheduleCategory
                : undefined,
            schedulePeriod:
              typeof v.schedulePeriod === "string"
                ? v.schedulePeriod
                : undefined,
            year: Number(v.year ?? 0),
            month: Number(v.month ?? 0),
            unitId: typeof v.unitId === "string" ? v.unitId : "",
          });
        });

        // v1.46.0：進度三態＋現階段區間（精確到日；空窗期仍算進行中）。
        // v1.59.1：先對全部排程分類（任務 fallback 歸屬需要區間月份），
        // 再以可見性過濾；一列一排程：進行中顯示包含今天（或空窗期對應）
        // 的區間；待完成顯示下一個未開始的區間；已結束顯示最後一個區間。
        const classifiedAll: {
          sched: IndicatorSchedule;
          state: AuditProgressState;
          interval: ReviewInterval;
        }[] = [];
        for (const s of schedules) {
          const indForSched = indicators.get(s.indicatorId);
          if (!indForSched) continue;
          // v1.63.2：只列「有效排程」——指標啟用、排程設定完整（單位／月份／件數），
          // 且週期排程（非自審）至少有一筆審查員／單位分工；未完成設定或
          // 無分工的殘留排程文件不再出現在品管審查清單。
          if (indForSched.status !== "啟用") continue;
          if (!scheduleSetupComplete(s)) continue;
          const cls = classifyScheduleProgress(
            schedLike(s),
            today,
            deadlineDay,
          );
          if (!cls) continue;
          if (
            (s.category === "year" || s.category === "academic") &&
            !s.selfReview &&
            cls.state !== "ended" &&
            (reviewerOf.get(s.indicatorId)?.size ?? 0) === 0
          )
            continue;
          classifiedAll.push({
            sched: s,
            state: cls.state,
            interval: cls.interval,
          });
        }
        const taskUnitsBySched = taskUnitsBySchedule(
          myTasks,
          classifiedAll.map((c): AuditScheduleLike => ({
            key: scheduleDocId(
              c.sched.indicatorId,
              c.sched.category,
              c.sched.period,
            ),
            indicatorId: c.sched.indicatorId,
            intervalMonthKeys: new Set(c.interval.allMonths.map(ymKey)),
          })),
        );

        interface Cand {
          sched: IndicatorSchedule;
          assigned: string[];
          /** v1.88.19：分工表上本人被分派的審查月份（空＝全部月份） */
          assignedReviewMonths: string[];
          state: AuditProgressState;
          interval: ReviewInterval;
        }
        const cands: Cand[] = [];
        for (const c of classifiedAll) {
          const s = c.sched;
          const ind = indicators.get(s.indicatorId);
          if (!ind) continue;
          let visible = false;
          const assigned: string[] = [];
          let assignedReviewMonths: string[] = [];
          if (isAdmin || isSenior) visible = true;
          if (isReviewer) {
            const mine = reviewerOf.get(s.indicatorId)?.get(staffId);
            if (mine) {
              visible = true;
              assigned.push(...mine.units);
              assignedReviewMonths = mine.reviewMonths;
            }
            // v1.59.1：任務指派聯集——臨時排程（加審／自審）無分工表，
            // 審查員改以 reviewTasks（reviewerId＝本人）所屬排程列出，
            // 不論 category 年度／學年度／temp；執行時仍只限被指派單位。
            const taskUnits = taskUnitsBySched.get(
              scheduleDocId(s.indicatorId, s.category, s.period),
            );
            if (taskUnits && taskUnits.size > 0) {
              visible = true;
              assigned.push(...taskUnits);
            }
          }
          if (
            isHeadNurse &&
            s.selfReview &&
            user.unitCode &&
            s.unitIds.includes(user.unitCode)
          ) {
            visible = true;
          }
          if (
            isConvener &&
            ind.groupId &&
            myConvenerGroupIds.includes(ind.groupId)
          ) {
            visible = true;
          }
          if (!visible) continue;
          cands.push({
            sched: s,
            assigned: unionUnits(assigned),
            assignedReviewMonths,
            state: c.state,
            interval: c.interval,
          });
        }
        if (cancelled) return;

        // 下游沿用 classified（已分類＋已過濾的可見列）。
        const classified = cands;

        // v1.65.2：使用者第一次啟動品管審查時，以剛讀到的「有效排程」和上次進入
        // 時記下的清單比對，提示新增／取消的排程；比對後更新記錄。
        // 第一次使用（沒有舊記錄）只記錄、不提示。
        if (!scheduleChangeChecked.has(staffId)) {
          scheduleChangeChecked.add(staffId);
          try {
            const storeKey = `qaweb:audit-schedules:${staffId}`;
            const current = classified.map((c) => ({
              id: scheduleDocId(c.sched.indicatorId, c.sched.category, c.sched.period),
              label: `${indicators.get(c.sched.indicatorId)?.name ?? stripInternalIdPrefix(c.sched.indicatorId)}・${c.sched.periodLabel}`,
            }));
            const raw = window.localStorage.getItem(storeKey);
            if (raw) {
              const prev = JSON.parse(raw) as { id: string; label: string }[];
              const prevIds = new Set(prev.map((x) => x.id));
              const curIds = new Set(current.map((x) => x.id));
              const added = current.filter((x) => !prevIds.has(x.id)).map((x) => x.label);
              const removed = prev.filter((x) => !curIds.has(x.id)).map((x) => x.label);
              if ((added.length > 0 || removed.length > 0) && !cancelled)
                setScheduleChanges({ added, removed });
            }
            window.localStorage.setItem(storeKey, JSON.stringify(current));
          } catch {
            // 瀏覽器不允許儲存時略過比對
          }
        }
        if (cancelled) return;

        // ---- 審查紀錄（v1.28 階段 6 B6）：單一查詢＋游標分頁，前端按指標分組 ----
        // 年份下限（v1.46.0 放寬）：已結束要回看更早區間，舊「去年」下限會讓
        // 舊區間進度顯示為 0。改以各列顯示區間的最早年份為準，至少去年、
        // 最多往前三年（讀取量上限約 4 年份紀錄；前端仍以區間月份鍵過濾，
        // 伺服器端年份只是預篩、不影響正確性）。
        // 單一範圍 where ＋ 同欄位 orderBy（分頁 helper 內加），不需複合索引；
        // 分頁循序拉完，修掉舊 limit(2000) 靜默截斷。
        // v1.62：預設只讀「目前年度（學年度）」的紀錄——年度＝今年；學年度 8 月制，
        // 8 月起為今年、之前為去年。進行中／待完成的列照樣依其區間起始年往前補讀
        // （補審期限內仍可能在上一年度）；「已結束」的列只在使用者切到「已結束」
        // 進度時才補讀歷史年份（historyLoaded），避免每次進頁都拉近四年全部紀錄。
        // v1.65.2：先讀封存摘要；「已結束」且有可用摘要的列直接用摘要算進度，
        // 不必為它補讀歷史年份的原始紀錄（讀不到摘要就維持原行為）。
        let summEarly = new Map<string, StoredSummary>();
        try {
          summEarly = await loadAllSummaries(db);
        } catch {
          /* 讀不到摘要：退回讀原始紀錄 */
        }
        const summaryFor = (c: { sched: IndicatorSchedule; interval: ReviewInterval }) => {
          const sm = summEarly.get(
            summaryDocId(c.sched.indicatorId, c.sched.category, c.sched.period, c.interval.start),
          );
          return sm && sm.schemaVersion === SUMMARY_SCHEMA_VERSION ? sm : undefined;
        };
        const sysCfg = sysSnap.data() as Record<string, unknown> | undefined;
        const academic = sysCfg?.statsCycle === "academic";
        let minYear =
          academic && today.getMonth() + 1 < 8
            ? today.getFullYear() - 1
            : today.getFullYear();
        for (const c of classified) {
          if (c.state !== "ended" || (historyLoaded && !summaryFor(c))) {
            minYear = Math.min(minYear, c.interval.start.year);
          }
        }
        minYear = Math.max(minYear, today.getFullYear() - 3);
        const recordsByIndicator = new Map<string, RecordRow[]>();
        let recordsTruncated = false;
        // 讀量優化：不再整年全讀。只對「需要算進度」的區間，依（指標，年）以
        // month in [...] 讀該區間月份的紀錄；已結束且有可用摘要者走摘要、完全不讀。
        // 年份下限 minYear 沿用原規則（歷史年份仍須切到「已結束」才補讀）。
        const needMonths = new Map<string, { indicatorId: string; year: number; months: Set<number> }>();
        for (const c of classified) {
          if (c.state === "ended" && summaryFor(c)) continue;
          for (const m of c.interval.allMonths) {
            if (m.year < minYear) continue;
            const key = `${c.sched.indicatorId}||${m.year}`;
            const entry = needMonths.get(key) ?? {
              indicatorId: c.sched.indicatorId,
              year: m.year,
              months: new Set<number>(),
            };
            entry.months.add(m.month);
            needMonths.set(key, entry);
          }
        }
        const seenRecordIds = new Set<string>();
        await Promise.all(
          [...needMonths.values()].map(async (job) => {
            try {
              const snap = await fetchIndicatorMonths(
                dbIndexedQueryApi,
                collection(db, "reviewRecords"),
                { indicatorId: job.indicatorId, year: job.year, months: [...job.months] },
              );
              snap.docs.forEach((d) => {
                if (seenRecordIds.has(d.id)) return;
                seenRecordIds.add(d.id);
                const row = toRecordRow(d.id, d.data() as Record<string, unknown>);
                if (!row) return;
                const list = recordsByIndicator.get(row.indicatorId) ?? [];
                list.push(row);
                recordsByIndicator.set(row.indicatorId, list);
              });
            } catch {
              // 該（指標，年）讀取失敗：進度不可信，視為未拉完，畫面顯示可見提示。
              recordsTruncated = true;
            }
          }),
        );
        if (cancelled) return;
        if (!cancelled) setRecordsTruncated(recordsTruncated);

        const out: ActiveRow[] = [];
        for (const { sched: s, assigned, assignedReviewMonths, state, interval: iv } of classified) {
          const ind = indicators.get(s.indicatorId);
          if (!ind) continue;
          const keys = new Set(iv.allMonths.map(ymKey));
          const periodicCategory =
            s.category === "year" || s.category === "academic"
              ? s.category
              : null;
          const scheduledUnitIds = new Set(s.unitIds);
          const intervalRecords = (recordsByIndicator.get(s.indicatorId) ?? []).filter(
            (record) =>
              keys.has(ymKey({ year: record.year, month: record.month })) &&
              (periodicCategory === null ||
                scheduledUnitIds.size === 0 ||
                scheduledUnitIds.has(record.unitId)),
          );
          const inRecords = periodicCategory
            ? intervalRecords.filter(
                (record) =>
                  record.source === "import" ||
                  record.quotaGroupId ===
                    periodicQuotaGroupId({
                      indicatorId: s.indicatorId,
                      // v1.51.0：不限單位紀錄 unitId 為 ""，配額組 key 的 unitId 段為 "NA"
                      unitId: record.unitId === "" ? "NA" : record.unitId,
                      category: periodicCategory,
                      period: s.period,
                      start: iv.start,
                    }),
              )
            : intervalRecords;
          const reviewMonthCount = iv.reviewMonths.length;
          const sm = state === "ended" ? summaryFor({ sched: s, interval: iv }) : undefined;
          const summarized = !!sm;
          const progressRecords = sm
            ? sm.cells
                // 摘要存全部紀錄；進度只算排程單位（週期排程；匯入紀錄也併入）
                .filter(
                  (c) =>
                    periodicCategory === null ||
                    scheduledUnitIds.size === 0 ||
                    scheduledUnitIds.has(c.unitId),
                )
                .flatMap((c) =>
                Array.from({ length: c.total }, () => ({
                  unitId: c.unitId,
                  year: c.year,
                  month: c.month,
                })),
              )
            : inRecords;
          const progress = computeIntervalProgress({
            // v1.51.0：不限單位視為一個虛擬單位（總人次＝件數、總單位＝1）
            unitCount: s.unlimitedUnits ? 1 : s.unitIds.length,
            caseCount: s.caseCount,
            reviewMonthCount,
            category: s.category,
            records: progressRecords,
            intervalMonthKeys: keys,
          });
          // v1.46.0：進行中 100% 的列照樣顯示（審查按鈕另外藏起），不再整列跳過
          // v1.23：區間內每個月皆為審查月（不再只有起始月）
          const monthOptions: MonthOption[] = iv.reviewMonths.map(
            ({ year, month }) => ({
              month,
              year,
              label: `${year}年${month}月`,
            }),
          );
          // v1.59.1：檢視彈窗可見單位（與上方清單可見性分支一一對應，
          // 多重身分取聯集；召集人／執行幹事為群組範圍＝整列可見，
          // 不可縮成單一單位；無分支貢獻時 []＝fail closed）
          const modalUnitIds = modalUnitScope({
            isAdmin,
            isSenior,
            isConvenerInGroup:
              isConvener &&
              !!ind.groupId &&
              myConvenerGroupIds.includes(ind.groupId),
            isHeadNurseApplies:
              isHeadNurse &&
              s.selfReview &&
              !!user.unitCode &&
              s.unitIds.includes(user.unitCode),
            ownUnitCode: user.unitCode ?? "",
            assignedUnits: assigned,
          });
          out.push({
            sched: s,
            indicatorId: s.indicatorId,
            indicatorCode: ind.code,
            indicatorName: ind.name,
            indicatorThreshold: ind.threshold,
            groupId: ind.groupId,
            groupName: groupName.get(ind.groupId) ?? "未分類",
            state,
            complete: isProgressComplete(progress),
            interval: iv,
            intervalLabel: intervalDisplay(iv, s.category),
            progress,
            reviewMonthCount,
            assignedUnitIds: assigned,
            assignedReviewMonths,
            modalUnitIds,
            monthOptions,
            summarized,
            records: (summarized ? [] : [...inRecords]).sort(
              (a, b) =>
                a.year - b.year ||
                a.month - b.month ||
                a.unitId.localeCompare(b.unitId, "zh-Hant"),
            ),
            unitNameOf,
            canArchive:
              isAdmin ||
              (isConvener &&
                !!ind.groupId &&
                myConvenerGroupIds.includes(ind.groupId)),
            endedTargets: endedIntervalsOf(
              { ...schedLike(s), indicatorId: s.indicatorId },
              today,
              deadlineDay,
            ).map((e) => ({
              id: e.archiveId,
              label: e.label,
              overdue: e.overdue,
              target: {
                indicatorId: s.indicatorId,
                category: s.category,
                period: s.period,
                start: e.interval.start,
                end: e.interval.end,
                monthKeys: new Set(e.interval.allMonths.map(ymKey)),
                unitIds: s.unitIds,
              },
            })),
          });
        }
        if (!cancelled) setSummaries(summEarly);
        try {
          if (isAdmin || isConvener) {
            const reqs = await loadPendingEditRequests(db);
            if (!cancelled)
              setPendingReqs(
                reqs.filter(
                  (r) =>
                    isAdmin ||
                    (!!r.groupId && myConvenerGroupIds.includes(r.groupId)),
                ),
              );
          } else if (!cancelled) setPendingReqs([]);
        } catch {
          // 讀不到待審申請不影響清單
        }
        setRows(out);
      } catch (e) {
        if (!cancelled) onAction(`讀取品管審查清單失敗：${toErrorMessage(e)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.staffId, dataRefreshKey, orgMeta.roleMeta, historyLoaded]);

  /* ---------- 檢視 modal：載入該指標題目（逐題明細分組＋指引用；v1.24） ---------- */
  useEffect(() => {
    setExpandedRecordId(null);
    setExpandedAnswers(null);
    setExpandedEditHistory([]);
    setSelectedUnitFilter("");
    setDetailListOpen(false);
    if (!viewRow) {
      setViewQuestions([]);
      setViewShowGroups(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const db = getFirebaseDb();
        const snap = await getDoc(doc(db, "indicators", viewRow.indicatorId));
        if (cancelled || !snap.exists()) return;
        const v = snap.data() as Record<string, unknown>;
        setViewQuestions(normalizeQuestions(v.questions).questions);
        setViewShowGroups(v.useQuestionGroups === true);
      } catch {
        if (!cancelled) {
          setViewQuestions([]);
          setViewShowGroups(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [viewRow]);

  /** 載入第三層明細彈窗的逐題作答與修改歷程 */
  async function toggleRecordDetail(rec: RecordRow) {
    setExpandedRecordId(rec.id);
    setExpandedAnswers(null);
    setExpandedLoading(true);
    try {
      const db = getFirebaseDb();
      const snap = await getDoc(doc(db, "reviewRecords", rec.id));
      const v = snap.exists()
        ? (snap.data() as Record<string, unknown>)
        : {};
      setExpandedAnswers(
        Array.isArray(v.answers) ? (v.answers as ReviewAnswer[]) : [],
      );
      setExpandedEditHistory(
        Array.isArray(v.editHistory)
          ? (v.editHistory as Record<string, unknown>[]).slice().reverse()
          : [],
      );
    } catch {
      setExpandedAnswers([]);
      setExpandedEditHistory([]);
    } finally {
      setExpandedLoading(false);
    }
  }

  function canEditRecord(rec: RecordRow): boolean {
    const groupId = viewRow?.groupId ?? "";
    if (!groupId || !can("editSubmitted", groupId)) return false;
    return (
      (user?.roles ?? []).includes("系統管理員") ||
      rec.reviewerEmpNo === user?.staffId ||
      (!!viewRow && editableGroupIds.includes(viewRow.groupId))
    );
  }

  function editRecord(rec: RecordRow) {
    if (!canEditRecord(rec)) {
      onAction("只有系統管理員、該指標所屬組別的召集人／執行幹事，或原審查員本人可修改此結果");
      return;
    }
    setViewRow(null);
    setDetailListOpen(false);
    setExpandedRecordId(null);
    setExecuting({ mode: "task", taskId: rec.taskId, editRecordId: rec.id });
  }

  // 篩選區選項：組別＝清單內的組別；指標＝清單內的指標（隨組別連動）
  const groupOptions = useMemo(() => {
    const m = new Map<string, string>();
    rows.forEach((r) => {
      if (!m.has(r.groupId)) m.set(r.groupId, r.groupName);
    });
    return [...m.entries()];
  }, [rows]);
  const indicatorOptions = useMemo(() => {
    const list = selGroup
      ? rows.filter((r) => r.groupId === selGroup)
      : rows;
    const m = new Map<string, { code: string; name: string }>();
    list.forEach((r) => {
      if (!m.has(r.indicatorId))
        m.set(r.indicatorId, { code: r.indicatorCode, name: r.indicatorName });
    });
    return [...m.entries()].sort((a, b) =>
      a[1].code.localeCompare(b[1].code, "zh-Hant", { numeric: true }),
    );
  }, [rows, selGroup]);

  const filtered = useMemo(() => {
    // 進行中＝查詢當月仍在審查區間內者；區間已結束、僅剩補資料期限的列不列入
    const now = new Date();
    const nowYm = now.getFullYear() * 100 + (now.getMonth() + 1);
    const list = rows.filter(
      (r) =>
        r.state === selProgress &&
        (selProgress !== "active" ||
          r.interval.end.year * 100 + r.interval.end.month >= nowYm) &&
        auditRowMatches(r, {
          groupId: selGroup,
          indicatorId: selIndicator,
          keyword,
        }),
    );
    const dir = sortDir;
    const val = (r: ActiveRow): number | string => {
      switch (sortKey) {
        case "code":
          return r.indicatorCode;
        case "name":
          return r.indicatorName;
        case "interval":
          return r.interval.start.year * 100 + r.interval.start.month;
        case "person":
          return r.progress.personPct == null ? -1 : r.progress.personPct;
        case "unit":
          return r.progress.unitPct;
        case "group":
        default:
          return r.groupName;
      }
    };
    return [...list].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      let c: number;
      if (typeof va === "number" && typeof vb === "number") c = va - vb;
      else
        c =
          String(va).localeCompare(String(vb), "zh-Hant") ||
          a.indicatorName.localeCompare(b.indicatorName, "zh-Hant");
      return c * dir;
    });
  }, [rows, selGroup, selIndicator, selProgress, keyword, sortKey, sortDir]);

  // v1.46.0：標題與空狀態依進度篩選器調整
  const progressTitle =
    selProgress === "active"
      ? "進行中的審查排程"
      : selProgress === "ended"
        ? "已結束的審查排程"
        : "待完成的審查排程";
  const progressNote =
    selProgress === "active"
      ? "依您的身分列出當月進行中的審查排程；點標題可排序"
      : selProgress === "ended"
        ? "依您的身分列出已結束的審查排程（已過排程區間及補資料日期）；檢視可查看結果，符合權限者可修改紀錄"
        : "依您的身分列出已排程但尚未開始的審查排程；點標題可排序";
  const progressEmptyTitle =
    selProgress === "active"
      ? "目前沒有進行中的審查排程"
      : selProgress === "ended"
        ? "目前沒有已結束的審查排程"
        : "目前沒有待完成的審查排程";
  const progressEmptyDesc =
    selProgress === "active"
      ? "可能尚無排程、排程皆已結束，或您的身分沒有被指派審查項目。"
      : selProgress === "ended"
        ? "可能尚無已結束的排程，或您的身分沒有被指派審查項目。"
        : "可能尚無尚未開始的排程，或您的身分沒有被指派審查項目。";

  const viewUnitSummaries = useMemo(() => {
    if (!viewRow) return [];
    const scope = viewRow.modalUnitIds;
    const summaries = new Map<string, { count: number; rates: number[] }>();
    viewRow.sched.unitIds.forEach((unitId) =>
      summaries.set(unitId, { count: 0, rates: [] }),
    );
    viewRow.records.forEach((record) => {
      // v1.59.1：紀錄單位不在彈窗可見範圍內不計入摘要
      if (!unitVisibleInModal(scope, record.unitId)) return;
      const summary = summaries.get(record.unitId) ?? { count: 0, rates: [] };
      summary.count += 1;
      if (record.rate != null) summary.rates.push(record.rate);
      summaries.set(record.unitId, summary);
    });
    return [...summaries.entries()]
      // v1.59.1：只列彈窗可見範圍內的單位（null＝全部）
      .filter(([unitId]) => unitVisibleInModal(scope, unitId))
      .map(([unitId, summary]) => ({
      unitId,
      count: summary.count,
      planned:
        viewRow.sched.caseCount == null
          ? null
          : viewRow.sched.caseCount *
            (viewRow.sched.category === "temp" ? viewRow.reviewMonthCount : 1),
      average:
        summary.rates.length > 0
          ? Math.round(
              (summary.rates.reduce((sum, rate) => sum + rate, 0) /
                summary.rates.length) *
                10,
            ) / 10
          : null,
    }));
  }, [viewRow]);
  const viewRecords = useMemo(
    () =>
      viewRow?.records.filter(
        (record) =>
          // v1.59.1：明細只列彈窗可見範圍內的單位（null＝全部）
          unitVisibleInModal(viewRow.modalUnitIds, record.unitId) &&
          (!selectedUnitFilter ||
            (selectedUnitFilter === "__na__"
              ? record.unitId === ""
              : record.unitId === selectedUnitFilter)),
      ) ?? [],
    [viewRow, selectedUnitFilter],
  );

  const SortTh = ({ label, k }: { label: string; k: SortKey }) => (
    <SortableTh label={label} sortKey={k} sort={tableSort} onSort={toggleSort} />
  );

  /** v1.65.2：進度取自摘要的列，按「檢視」時才讀該區間的原始紀錄 */
  async function openView(r: ActiveRow) {
    setDetailListOpen(false);
    setSelectedUnitFilter("");
    setExpandedRecordId(null);
    if (!r.summarized) {
      setViewRow(r);
      return;
    }
    setViewLoadingKey(rowKeyOf(r));
    try {
      const { docs, truncated } = await fetchAllPaged(
        collection(getFirebaseDb(), "reviewRecords"),
        [where("indicatorId", "==", r.indicatorId)],
        undefined,
        { orderByField: "indicatorId" },
      );
      if (truncated) throw new Error("審查紀錄未完整載入（分頁中斷），請稍後重試");
      const keys = new Set(r.interval.allMonths.map(ymKey));
      const periodic = r.sched.category === "year" || r.sched.category === "academic";
      const scheduled = new Set(r.sched.unitIds);
      const recs: RecordRow[] = [];
      docs.forEach((d) => {
        const row = toRecordRow(d.id, d.data() as Record<string, unknown>);
        if (!row || !keys.has(ymKey({ year: row.year, month: row.month }))) return;
        if (periodic) {
          if (scheduled.size > 0 && !scheduled.has(row.unitId)) return;
          const expected = periodicQuotaGroupId({
            indicatorId: r.indicatorId,
            unitId: row.unitId === "" ? "NA" : row.unitId,
            category: r.sched.category as "year" | "academic",
            period: r.sched.period,
            start: r.interval.start,
          });
          if (row.source !== "import" && row.quotaGroupId !== expected) return;
        }
        recs.push(row);
      });
      recs.sort(
        (a, b) =>
          a.year - b.year ||
          a.month - b.month ||
          a.unitId.localeCompare(b.unitId, "zh-Hant"),
      );
      setViewRow({ ...r, records: recs });
    } catch (e) {
      onAction(`讀取審查紀錄失敗：${toErrorMessage(e)}`);
    } finally {
      setViewLoadingKey(null);
    }
  }

  const rowKeyOf = (r: ActiveRow) =>
    `${r.indicatorId}|${r.sched.category}|${r.sched.period}`;

  async function handleArchive(row: ActiveRow) {
    if (!user) return;
    const missing = row.endedTargets.filter((e) => !summaries.has(e.id));
    const list = missing.length > 0 ? missing : row.endedTargets;
    if (list.length === 0) return;
    if (
      !window.confirm(
        missing.length > 0
          ? `封存「${row.indicatorName}」尚未封存的 ${list.length} 個已結束區間（${list.map((e) => e.label).join("、")}）？之後結果分析會先讀摘要；封存後補改紀錄需經審核。`
          : `重新封存「${row.indicatorName}」全部 ${list.length} 個已結束區間？將以目前審查紀錄覆寫舊摘要。`,
      )
    )
      return;
    setArchivingId(rowKeyOf(row));
    try {
      let count = 0;
      for (const e of list) {
        const saved = await archiveInterval(getFirebaseDb(), e.target, {
          id: user.staffId,
          name: user.name ?? user.staffId,
        });
        setSummaries((prev) => new Map(prev).set(e.id, saved));
        count += saved.recordCount;
      }
      onAction(`已封存摘要：${row.indicatorName}（${list.length} 個區間，${count} 筆紀錄）`);
    } catch (e) {
      onAction(`封存摘要失敗：${toErrorMessage(e)}`);
    } finally {
      setArchivingId(null);
    }
  }

  async function rearchiveById(archiveId: string) {
    if (!user) return;
    let found: ActiveRow["endedTargets"][number] | undefined;
    for (const r of rows) {
      found = r.endedTargets.find((e) => e.id === archiveId);
      if (found) break;
    }
    if (!found) throw new Error("找不到對應的區間");
    const saved = await archiveInterval(getFirebaseDb(), found.target, {
      id: user.staffId,
      name: user.name ?? user.staffId,
    });
    setSummaries((prev) => new Map(prev).set(archiveId, saved));
  }

  async function handleDecision(req: EditRequest, approve: boolean) {
    if (!user) return;
    const actor = { id: user.staffId, name: user.name ?? user.staffId };
    let note = "";
    if (!approve) {
      note = (window.prompt("請填寫駁回原因：") ?? "").trim();
      if (!note) return;
    }
    setReqBusyId(req.id);
    try {
      const db = getFirebaseDb();
      if (approve) await approveEditRequest(db, req, actor, rearchiveById);
      else await rejectEditRequest(db, req, actor, note);
      setPendingReqs((prev) => prev.filter((x) => x.id !== req.id));
      onAction(approve ? "已核准修改並重新封存摘要" : "已駁回修改申請");
      setDataRefreshKey((k) => k + 1);
    } catch (e) {
      onAction(`處理失敗：${toErrorMessage(e)}`);
      // 核准已套用但重新封存失敗時，申請已不在待審
      if (approve) setDataRefreshKey((k) => k + 1);
    } finally {
      setReqBusyId(null);
    }
  }

  function openExec(row: ActiveRow) {
    setExecRow(row);
    setExecTaskKeys(null);
    setExecFullUnits(null);
    setExecBusy(false);
    const baseUnits =
      row.assignedUnitIds.length > 0 ? row.assignedUnitIds : row.sched.unitIds;
    setExecUnit(baseUnits[0] ?? "");
    const firstReview = row.interval.reviewMonths[0];
    const defMonth =
      (firstReview != null
        ? row.monthOptions.find(
            (o) => o.year === firstReview.year && o.month === firstReview.month,
          )
        : undefined) ?? row.monthOptions[0];
    setExecMonth(defMonth ? `${defMonth.year}-${defMonth.month}` : "");
    // v1.63.1：排程清單的受審單位／月份不一定都有已展開的任務（分工表缺單位、
    // 尚未產生排程等），先查實際任務，避免點「審查」才跳「找不到審查任務」。
    // v1.88.19：同場加算已滿單位——依分工表被分派月份，計已提交＋暫存，
    // 對照應審件數；達標者下拉反灰（仍顯示），預設選項跳過已滿者。
    void (async () => {
      try {
        const db = getFirebaseDb();
        const years = [...new Set(row.monthOptions.map((o) => o.year))];
        const monthKeys = new Set(
          row.monthOptions.map((o) => `${o.year}-${o.month}`),
        );
        const snap = await getDocs(
          query(
            collection(db, "reviewTasks"),
            where("indicatorId", "==", row.indicatorId),
            where("year", "in", years.slice(0, 30)),
            limit(2000),
          ),
        );
        const keys = new Set<string>();
        // 任務歸屬（單位＋年月 → 任務 id／配額組），供已提交／暫存比對
        const taskIdsByKey = new Map<string, Set<string>>();
        const quotaByKey = new Map<string, string>();
        snap.docs.forEach((d) => {
          const v = d.data() as Record<string, unknown>;
          const ym = `${Number(v.year ?? 0)}-${Number(v.month ?? 0)}`;
          if (!monthKeys.has(ym)) return;
          const unit = String(v.unitId ?? "");
          const k = `${unit}|${ym}`;
          keys.add(k);
          const ids = taskIdsByKey.get(k) ?? new Set<string>();
          ids.add(d.id);
          taskIdsByKey.set(k, ids);
          if (typeof v.quotaGroupId === "string" && v.quotaGroupId)
            quotaByKey.set(k, v.quotaGroupId);
        });
        setExecTaskKeys(keys);
        // ---- 已滿計算（讀不到件數就不反灰，維持原行為） ----
        let fullUnits: Set<string> | null = null;
        let monthFull = (_unit: string, _ym: string) => false;
        try {
          // 被分派月份（空＝全部區間月份；"yyyy/mm" → "y-m" 鍵）
          const assignedKeys = new Set<string>(
            (row.assignedReviewMonths.length > 0
              ? row.assignedReviewMonths.map((s) => {
                  const [y, m] = s.split("/");
                  return `${Number(y)}-${Number(m)}`;
                })
              : [...monthKeys]
            ).filter((k) => monthKeys.has(k)),
          );
          const periodic =
            row.sched.category === "year" ||
            row.sched.category === "academic";
          const counts = new Map<string, number>(); // "單位|y-m" → 已提交＋暫存
          const countDoc = (data: Record<string, unknown>) => {
            const unit = String(data.unitId ?? "");
            const ym = `${Number(data.year ?? 0)}-${Number(data.month ?? 0)}`;
            if (!assignedKeys.has(ym)) return;
            const k = `${unit}|${ym}`;
            const taskIds = taskIdsByKey.get(k);
            const quota = quotaByKey.get(k);
            const taskId =
              typeof data.taskId === "string" ? data.taskId : "";
            const groupId =
              typeof data.quotaGroupId === "string" ? data.quotaGroupId : "";
            const source =
              typeof data.source === "string" ? data.source : "";
            // 歸屬：該任務的紀錄／暫存、匯入紀錄、或同一週期配額組者才計入
            if (
              taskIds?.has(taskId) ||
              source === "import" ||
              (periodic &&
                quota !== undefined &&
                groupId !== "" &&
                groupId === quota)
            ) {
              counts.set(k, (counts.get(k) ?? 0) + 1);
            }
          };
          const yearChunks: number[][] = [];
          for (let i = 0; i < years.length; i += 10)
            yearChunks.push(years.slice(i, i + 10));
          const [recSnaps, draftSnaps] = await Promise.all([
            Promise.all(
              yearChunks.map((ys) =>
                getDocs(
                  query(
                    collection(db, "reviewRecords"),
                    where("indicatorId", "==", row.indicatorId),
                    where("year", "in", ys),
                    limit(2000),
                  ),
                ),
              ),
            ),
            Promise.all(
              yearChunks.map((ys) =>
                getDocs(
                  query(
                    collection(db, "reviewDrafts"),
                    where("indicatorId", "==", row.indicatorId),
                    where("year", "in", ys),
                    limit(2000),
                  ),
                ),
              ),
            ),
          ]);
          recSnaps
            .flat()
            .forEach((s) =>
              s.docs.forEach((d) =>
                countDoc(d.data() as Record<string, unknown>),
              ),
            );
          draftSnaps
            .flat()
            .forEach((s) =>
              s.docs.forEach((d) =>
                countDoc(d.data() as Record<string, unknown>),
              ),
            );
          // 週期排程配額全區間共用：被分派月份合計達標即滿；
          // 臨時排程每個月各算一件配額：被分派月份全部達標才滿。
          monthFull = (unit, ym) =>
            isTaskComplete(counts.get(`${unit}|${ym}`) ?? 0, row.sched.caseCount);
          fullUnits = new Set<string>();
          for (const u of baseUnits) {
            const months = [...assignedKeys];
            if (months.length === 0) continue;
            const full = periodic
              ? isTaskComplete(
                  months.reduce(
                    (sum, ym) => sum + (counts.get(`${u}|${ym}`) ?? 0),
                    0,
                  ),
                  row.sched.caseCount,
                )
              : months.every((ym) => monthFull(u, ym));
            if (full) fullUnits.add(u);
          }
        } catch {
          fullUnits = null;
        }
        setExecFullUnits(fullUnits);
        const units = baseUnits;
        const pick = row.sched.unlimitedUnits
          ? [""]
          : units.filter(
              (u) =>
                row.monthOptions.some((o) =>
                  keys.has(`${u}|${o.year}-${o.month}`),
                ) && !fullUnits?.has(u),
            );
        const unit = row.sched.unlimitedUnits
          ? ""
          : (pick[0] ??
            units.filter((u) => !fullUnits?.has(u))[0] ??
            units[0] ??
            "");
        setExecUnit(unit);
        const m = row.monthOptions.find(
          (o) =>
            keys.has(`${unit}|${o.year}-${o.month}`) &&
            !monthFull(unit, `${o.year}-${o.month}`),
        );
        if (m) setExecMonth(`${m.year}-${m.month}`);
      } catch {
        // 讀不到就維持原行為（開始審查時再檢查）
        setExecTaskKeys(null);
        setExecFullUnits(null);
      }
    })();
  }

  async function confirmExec() {
    // v1.51.0：不限單位排程 execUnit 為 ""（不用選單位），只檢查月份
    if (!execRow || !execMonth) return;
    if (!execRow.sched.unlimitedUnits && !execUnit) return;
    // v1.88.19：已滿單位反灰不可選；萬一仍選到（例如件數在開窗後才滿），擋下不開啟
    if (!execRow.sched.unlimitedUnits && execFullUnits?.has(execUnit)) {
      onAction("該單位本區間審查件數已滿，請改選其他單位");
      return;
    }
    const [y, m] = execMonth.split("-").map(Number);
    if (!y || !m) return;
    setExecBusy(true);
    try {
      const db = getFirebaseDb();
      // v1.27.2：純等號條件（Firestore 以單欄位索引合併，不需複合索引），
      // 只取「該指標／該年／該月／該單位」的任務；原本拉該指標跨年全部任務（最多 2000 筆）。
      const snap = await getDocs(
        query(
          collection(db, "reviewTasks"),
          where("indicatorId", "==", execRow.indicatorId),
          where("year", "==", y),
          where("month", "==", m),
          where("unitId", "==", execUnit),
          limit(50),
        ),
      );
      const mine: string[] = [];
      const others: string[] = [];
      snap.docs.forEach((d) => {
        const v = d.data() as Record<string, unknown>;
        if (
          String(v.unitId ?? "") === execUnit &&
          Number(v.year ?? 0) === y &&
          Number(v.month ?? 0) === m
        ) {
          if (String(v.reviewerId ?? "") === (user?.staffId ?? "")) mine.push(d.id);
          else others.push(d.id);
        }
      });
      const taskId = mine[0] ?? others[0];
      if (!taskId) {
        onAction(
          execRow.sched.unlimitedUnits
            ? "找不到該月份的審查任務（不限單位），請先到「品管審查排程」產生排程"
            : "找不到該單位該月份的審查任務，請先到「品管審查排程」產生排程",
        );
        return;
      }
      setExecRow(null);
      setExecuting({ mode: "task", taskId });
    } catch (e) {
      onAction(`開啟審查失敗：${toErrorMessage(e)}`);
    } finally {
      setExecBusy(false);
    }
  }

  if (executing) {
    return (
      <ReviewExecutePage
        target={executing}
        onBack={() => {
          setExecuting(null);
          setDataRefreshKey((key) => key + 1);
        }}
        onAction={onAction}
      />
    );
  }

  return (
    <>
      <PageHeading page="audit" />
      {recordsTruncated && (
        <p
          className="settings-note"
          style={{ color: "#b3372f", fontWeight: 600 }}
        >
          審查紀錄讀取失敗或未完整載入（可能是系統用量額度已滿），進度數字不準確、「0」不代表尚未審查；請稍後重新整理再確認。
        </p>
      )}
      {myTasksTruncated && (
        <p
          className="settings-note"
          style={{ color: "#b3372f", fontWeight: 600 }}
        >
          本人任務未完整載入（分頁中斷），加審／自審排程可能未全列出；請重新整理後再確認。
        </p>
      )}
      {scheduleChanges && (
        <p className="settings-note" style={{ fontWeight: 600 }}>
          自上次進入後，有效排程有變動：
          {scheduleChanges.added.length > 0 &&
            `新增 ${scheduleChanges.added.length} 個（${scheduleChanges.added.slice(0, 5).join("、")}${scheduleChanges.added.length > 5 ? "…" : ""}）`}
          {scheduleChanges.added.length > 0 && scheduleChanges.removed.length > 0 && "；"}
          {scheduleChanges.removed.length > 0 &&
            `取消／移除 ${scheduleChanges.removed.length} 個（${scheduleChanges.removed.slice(0, 5).join("、")}${scheduleChanges.removed.length > 5 ? "…" : ""}）`}{" "}
          <button type="button" className="text-button" onClick={() => setScheduleChanges(null)}>
            知道了
          </button>
        </p>
      )}
      {(() => {
        const due = rows.filter(
          (r) =>
            r.canArchive &&
            r.endedTargets.some((e) => e.overdue && !summaries.has(e.id)),
        );
        if (due.length === 0) return null;
        const n = due.reduce(
          (c, r) => c + r.endedTargets.filter((e) => e.overdue && !summaries.has(e.id)).length,
          0,
        );
        const names = [...new Set(due.map((r) => r.indicatorName))];
        return (
          <p className="settings-note" style={{ color: "#b3372f", fontWeight: 600 }}>
            有 {n} 個審查區間已結束超過一個月仍未封存（{names.slice(0, 5).join("、")}
            {names.length > 5 ? `…等 ${names.length} 支指標` : ""}）。請盡快封存，否則會影響指標查詢結果。
          </p>
        );
      })()}
      {pendingReqs.length > 0 && (
        <p className="settings-note" style={{ color: "#b3372f", fontWeight: 600 }}>
          有 {pendingReqs.length} 筆封存後的審查結果修改待審核{" "}
          <button type="button" className="text-button" onClick={() => setReqModalOpen(true)}>
            前往審核
          </button>
        </p>
      )}
      <FilterPanel
        actions={
          (selGroup || selIndicator || keyword) && (
            <button
              type="button"
              className="button button-outline"
              onClick={() => {
                setSelGroup("");
                setSelIndicator("");
                setKeyword("");
                setKeywordDraft("");
              }}
            >
              清除篩選
            </button>
          )
        }
      >
          <FormSelect label="組別" value={selGroup}
                onChange={(e) => {
                  const g = e.target.value;
                  setSelGroup(g);
                  if (selIndicator && g) {
                    const ok = rows.some(
                      (r) =>
                        r.indicatorId === selIndicator && r.groupId === g,
                    );
                    if (!ok) setSelIndicator("");
                  }
                }}>
                <option value="">全部組別</option>
                {groupOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </FormSelect>
          <FormSelect label="指標" value={selIndicator}
                onChange={(e) => setSelIndicator(e.target.value)}>
                <option value="">全部指標</option>
                {indicatorOptions.map(([id, o]) => (
                  <option key={id} value={id}>
                    {o.code} {o.name}
                  </option>
                ))}
              </FormSelect>
          <FormSelect label="進度" value={selProgress}
                onChange={(e) =>
                  setSelProgress(e.target.value as AuditProgressState)
                }>
                <option value="active">進行中</option>
                <option value="ended">已結束</option>
                <option value="pending">待完成</option>
              </FormSelect>
          <FilterSearchField
            label="關鍵字"
            placeholder="搜尋指標名稱或編號"
            value={keywordDraft}
            onChange={setKeywordDraft}
            onSearch={() => setKeyword(keywordDraft)}
          />
      </FilterPanel>
      <ListPanel title={progressTitle} count={filtered.length}>
        {progressNote && <p className="settings-note">{progressNote}</p>}
        {loading ? (
          <p className="muted-text" role="status">
            載入中…
          </p>
        ) : rows.length === 0 ? (
          <EmptyState
            title={progressEmptyTitle}
            description={progressEmptyDesc}
          />
        ) : filtered.length === 0 ? (
          <p className="muted-text">沒有符合篩選條件的指標。</p>
        ) : (
          <>
            <div className={`audit-review-cards${compact ? " is-compact" : ""}`} aria-label="品管審查指標清單">
              {filtered.map((r) => (
                <article
                  key={`card-${r.indicatorId}__${r.sched.category}__${r.sched.period}`}
                  className="audit-review-card"
                >
                  <div className="audit-review-card-head">
                    <div className="audit-review-card-title">
                      <span className="audit-review-card-group">{r.groupName}</span>
                      <b>{r.indicatorCode}　{r.indicatorName}</b>
                    </div>
                    <span className={`audit-review-card-status is-${r.state}${r.complete ? " is-complete" : ""}`}>
                      {r.state === "pending" ? "待完成" : r.state === "ended" ? "已結束" : r.complete ? "已完成" : "進行中"}
                    </span>
                  </div>
                  <div className="audit-review-card-interval">
                    審查區間：{r.intervalLabel}
                    {r.sched.category === "temp" && (
                      <span className="badge">{r.sched.selfReview ? "自審" : "加審"}</span>
                    )}
                  </div>
                  <div className="audit-review-card-progress">
                    <CompactProgress
                      label="審核進度（人次）"
                      done={r.progress.donePersons}
                      total={r.progress.totalPersons}
                      pct={r.progress.personPct}
                    />
                    <CompactProgress
                      label="審核進度（單位次）"
                      done={r.progress.doneUnits}
                      total={r.progress.totalUnits}
                      pct={r.progress.unitPct}
                    />
                  </div>
                  {r.state === "ended" && r.endedTargets.length > 0 && (() => {
                    const overdue = r.canArchive && r.endedTargets.some((e) => e.overdue && !summaries.has(e.id));
                    const pend = pendingReqs.some((q) => r.endedTargets.some((e) => q.archiveIds.includes(e.id)));
                    const stale = r.endedTargets.some((e) => {
                      const summary = summaries.get(e.id);
                      return !!summary && isSummaryStale(summary, r.indicatorThreshold);
                    });
                    if (!overdue && !pend && !stale) return null;
                    return (
                      <p className={`audit-review-card-alert${overdue || stale ? " is-warning" : ""}`}>
                        {[overdue ? "逾期未封存" : "", pend ? "有待審修改" : "", stale ? "摘要已過期（閾值已變更），請重新封存" : ""]
                          .filter(Boolean)
                          .join("・")}
                      </p>
                    );
                  })()}
                  <div className="audit-review-card-actions">
                    {r.state === "pending" ? (
                      <span className="muted-text">尚未開始</span>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="button button-outline"
                          disabled={viewLoadingKey !== null}
                          onClick={() => openView(r)}
                        >
                          <Eye size={15} /> 檢視
                        </button>
                        {r.canArchive && r.state === "ended" && r.endedTargets.length > 0 && (
                          <button
                            type="button"
                            className="button button-outline"
                            disabled={archivingId !== null}
                            onClick={() => handleArchive(r)}
                          >
                            <Archive size={15} />{" "}
                            {archivingId === rowKeyOf(r)
                              ? "封存中…"
                              : r.endedTargets.every((e) => summaries.has(e.id))
                                ? "重新封存"
                                : "封存摘要"}
                          </button>
                        )}
                        {r.state === "active" && !r.complete && (
                          <button
                            type="button"
                            className="button button-primary"
                            onClick={() => openExec(r)}
                          >
                            <ClipboardCheck size={15} /> 審查
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
            <table className="data-table audit-review-table">
              <thead>
                <tr>
                  {compact ? (
                    <>
                      <SortTh label="組別／編號／指標名稱" k="group" />
                      <SortTh label="審查區間" k="interval" />
                      <SortTh label="審核進度" k="person" />
                    </>
                  ) : (
                    <>
                      <SortTh label="組別" k="group" />
                      <SortTh label="指標編號" k="code" />
                      <SortTh label="指標名稱" k="name" />
                      <SortTh label="審查區間" k="interval" />
                      <SortTh label="審核進度（人次）" k="person" />
                      <SortTh label="審核進度（單位次）" k="unit" />
                    </>
                  )}
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr
                    key={`${r.indicatorId}__${r.sched.category}__${r.sched.period}`}
                  >
                    {compact ? (
                      <>
                        <td>
                          <div>{r.groupName}</div>
                          <div>
                            <b>{r.indicatorCode}</b>
                          </div>
                          <div>{r.indicatorName}</div>
                        </td>
                        <td>
                          {r.intervalLabel}
                          {r.sched.category === "temp" && (
                            <>
                              {" "}
                              <span className="badge">
                                {r.sched.selfReview ? "自審" : "加審"}
                              </span>
                            </>
                          )}
                        </td>
                        <td>
                          <CompactProgress
                            label="人次"
                            done={r.progress.donePersons}
                            total={r.progress.totalPersons}
                            pct={r.progress.personPct}
                          />
                          <CompactProgress
                            label="單位"
                            done={r.progress.doneUnits}
                            total={r.progress.totalUnits}
                            pct={r.progress.unitPct}
                          />
                        </td>
                      </>
                    ) : (
                      <>
                        <td>{r.groupName}</td>
                        <td>
                          <b>{r.indicatorCode}</b>
                        </td>
                        <td>{r.indicatorName}</td>
                        <td>
                          {r.intervalLabel}
                          {r.sched.category === "temp" && (
                            <>
                              {" "}
                              <span className="badge">
                                {r.sched.selfReview ? "自審" : "加審"}
                              </span>
                            </>
                          )}
                        </td>
                        <td>
                          <ProgressCell
                            done={r.progress.donePersons}
                            total={r.progress.totalPersons}
                            pct={r.progress.personPct}
                          />
                        </td>
                        <td>
                          <ProgressCell
                            done={r.progress.doneUnits}
                            total={r.progress.totalUnits}
                            pct={r.progress.unitPct}
                          />
                        </td>
                      </>
                    )}
                    <td>
                      {r.state === "pending" ? (
                        <span className="muted-text">—</span>
                      ) : (
                        <div className={compact ? "row-actions row-actions-vertical" : "row-actions"}>
                          <button
                            type="button"
                            className="text-button"
                            disabled={viewLoadingKey !== null}
                            onClick={() => openView(r)}
                          >
                            <Eye size={14} /> 檢視
                          </button>
                          {r.canArchive && r.state === "ended" && r.endedTargets.length > 0 && (
                            <button
                              type="button"
                              className="text-button"
                              disabled={archivingId !== null}
                              onClick={() => handleArchive(r)}
                            >
                              <Archive size={14} />{" "}
                              {archivingId === rowKeyOf(r)
                                ? "封存中…"
                                : r.endedTargets.every((e) => summaries.has(e.id))
                                  ? "重新封存"
                                  : "封存摘要"}
                            </button>
                          )}
                          {!compact && r.state === "ended" && r.endedTargets.length > 0 &&
                            (() => {
                              const overdue =
                                r.canArchive &&
                                r.endedTargets.some((e) => e.overdue && !summaries.has(e.id));
                              const pend = pendingReqs.some((q) =>
                                r.endedTargets.some((e) => q.archiveIds.includes(e.id)),
                              );
                              const stale = r.endedTargets.some((e) => {
                                const sm = summaries.get(e.id);
                                return !!sm && isSummaryStale(sm, r.indicatorThreshold);
                              });
                              if (!overdue && !pend && !stale) return null;
                              return (
                                <span
                                  className="muted-text"
                                  style={overdue || stale ? { color: "#b3372f", fontWeight: 600 } : undefined}
                                >
                                  {[
                                    overdue ? "逾期未封存" : "",
                                    pend ? "有待審修改" : "",
                                    stale ? "摘要已過期（閾值已變更），請重新封存" : "",
                                  ]
                                    .filter(Boolean)
                                    .join("・")}
                                </span>
                              );
                            })()}
                          {r.state === "active" && !r.complete && (
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => openExec(r)}
                            >
                              <ClipboardCheck size={14} /> 審查
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </ListPanel>

      {viewRow && (
        <div className="reviewer-modal-backdrop" onClick={() => setViewRow(null)}>
          <div
            className="reviewer-modal wide panel"
            role="dialog"
            aria-modal="true"
            aria-label="品管審查結果摘要"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="reviewer-modal-head">
              <div>
                <h2>{viewRow.indicatorName}・排程審查結果摘要</h2>
                <p>{viewRow.intervalLabel}・摘要以目前最新審查結果計算</p>
              </div>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setViewRow(null)}
                aria-label="關閉"
              >
                <X size={16} />
              </button>
            </div>
            {viewUnitSummaries.length === 0 ? (
              <p className="muted-text">本區間尚無單位審查結果。</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>排程單位</th>
                      <th>已審／應審件數</th>
                      <th>平均正確率</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewUnitSummaries.map((summary) => (
                      <tr key={summary.unitId}>
                        <td data-label="排程單位">{summary.unitId === "" ? "NA" : viewRow.unitNameOf(summary.unitId)}</td>
                        <td data-label="已審／應審件數">{summary.count}／{summary.planned ?? "—"} 件</td>
                        <td data-label="平均正確率">{summary.average == null ? "—" : `${summary.average}%`}</td>
                        <td data-label="操作">
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => {
                              // v1.51.0：NA 單位用 "__na__" 哨兵（"" 同時是「不過濾」）
                              setSelectedUnitFilter(summary.unitId === "" ? "__na__" : summary.unitId);
                              setDetailListOpen(true);
                            }}
                          >
                            <Eye size={14} /> 檢視個人結果
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="audit-unit-summary-cards" aria-label="單位審查摘要">
              {viewUnitSummaries.map((summary) => (
                <article className="audit-unit-summary-card" key={`mobile-${summary.unitId}`}>
                  <h3>{summary.unitId === "" ? "NA（不限單位）" : viewRow.unitNameOf(summary.unitId)}</h3>
                  <div className="audit-unit-summary-metrics">
                    <div><span>已審／應審件數</span><b>{summary.count}／{summary.planned ?? "—"} 件</b></div>
                    <div><span>平均正確率</span><b>{summary.average == null ? "—" : `${summary.average}%`}</b></div>
                  </div>
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={() => {
                      setSelectedUnitFilter(summary.unitId === "" ? "__na__" : summary.unitId);
                      setDetailListOpen(true);
                    }}
                  >
                    <Eye size={16} /> 檢視個人審查結果
                  </button>
                </article>
              ))}
            </div>
            <div className="form-actions">
              <button type="button" className="button button-ghost" onClick={() => setViewRow(null)}>
                關閉
              </button>
            </div>
          </div>
        </div>
      )}

      {viewRow && detailListOpen && (
        <div className="reviewer-modal-backdrop reviewer-modal-layer-2" onClick={() => setDetailListOpen(false)}>
          <div
            className="reviewer-modal wide panel"
            role="dialog"
            aria-modal="true"
            aria-label="審查明細"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="reviewer-modal-head">
              <div>
                <h2>審查明細</h2>
                <p>{selectedUnitFilter === "__na__" ? "NA" : viewRow.unitNameOf(selectedUnitFilter)}・{viewRecords.length} 筆</p>
              </div>
              <button type="button" className="button button-ghost" onClick={() => setDetailListOpen(false)} aria-label="關閉審查明細">
                <X size={16} />
              </button>
            </div>
            {viewRecords.length === 0 ? (
              <p className="muted-text">本區間尚無提交紀錄。</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>年月</th>
                      <th>審查日期</th>
                      <th>審查人員</th>
                      <th>受審人員</th>
                      <th>正確率</th>
                      <th>個人結果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewRecords.map((record) => (
                      <tr key={record.id}>
                        <td data-label="年月">{record.year}年{record.month}月</td>
                        <td data-label="審查日期">{fmtYmd(record.reviewDate)}</td>
                        <td data-label="審查人員">{staffLabel(record.reviewerEmpNo, record.reviewerName)}</td>
                        <td data-label="受審人員">{staffLabel(record.reviewedPersonEmpNo, record.reviewedPersonName)}</td>
                        <td data-label="正確率">{record.rate == null ? "—" : `${record.rate}%`}</td>
                        <td data-label="個人結果">
                          <div className="review-record-actions">
                            <button type="button" className="text-button" onClick={() => void toggleRecordDetail(record)}>
                              <Eye size={14} /> 檢視
                            </button>
                            {canEditRecord(record) && (
                              <button type="button" className="text-button" onClick={() => editRecord(record)}>
                                <Pencil size={14} /> 修改
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="form-actions">
              <button type="button" className="button button-ghost" onClick={() => setDetailListOpen(false)}>
                返回摘要
              </button>
            </div>
          </div>
        </div>
      )}

      {viewRow && detailListOpen && expandedRecordId && (
        <div className="reviewer-modal-backdrop reviewer-modal-layer-3" onClick={() => setExpandedRecordId(null)}>
          <div
            className="reviewer-modal wide panel"
            role="dialog"
            aria-modal="true"
            aria-label="審查項目結果"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="reviewer-modal-head">
              <div>
                <h2>審查項目結果</h2>
                <p>{viewRow.indicatorName}・{viewRecords.find((record) => record.id === expandedRecordId)?.year}年{viewRecords.find((record) => record.id === expandedRecordId)?.month}月</p>
              </div>
              <button type="button" className="button button-ghost" onClick={() => setExpandedRecordId(null)} aria-label="關閉審查項目結果">
                <X size={16} />
              </button>
            </div>
            {expandedLoading || expandedAnswers == null ? (
              <p className="muted-text">載入明細中…</p>
            ) : (
              <>
                {expandedAnswers.length === 0 ? (
                  <p className="muted-text">此筆紀錄沒有逐題作答資料。</p>
                ) : (
                  <ReviewQuestionList
                    mode="view"
                    questions={viewQuestions}
                    showGroups={viewShowGroups}
                    answers={expandedAnswers}
                  />
                )}
                <div className="form-actions">
                  {viewRecords.some((record) => record.id === expandedRecordId && canEditRecord(record)) && <button
                    type="button"
                    className="button button-primary"
                    onClick={() => {
                      const record = viewRecords.find((item) => item.id === expandedRecordId);
                      if (!record) return;
                      editRecord(record);
                    }}
                  >
                    <Pencil size={15} /> 編輯審查結果
                  </button>}
                </div>
                <SectionTitle title="修改紀錄" note={`${expandedEditHistory.length} 次修改`} />
                {expandedEditHistory.length === 0 ? (
                  <p className="muted-text">尚無修改紀錄；送出後的首次修改會記錄變更前後內容。</p>
                ) : (
                  <div className="review-edit-history">
                    {expandedEditHistory.map((entry, index) => {
                      const changes = entry.changes && typeof entry.changes === "object"
                        ? (entry.changes as Record<string, { before?: unknown; after?: unknown }>)
                        : {};
                      const labels: Record<string, string> = {
                        answers: "逐題作答", totalScore: "總得分", maxScore: "計分題數", rate: "正確率",
                        reviewDate: "審查日期", reviewerEmpNo: "審查人員職編", reviewerName: "審查人員",
                        reviewedPersonEmpNo: "受審人員職編", reviewedPersonName: "受審人員", bedNo: "床號", auditItem: "審核項目",
                      };
                      const stamp = typeof entry.editedAt === "string"
                        ? fmtIsoDateTime(entry.editedAt)
                        : "時間未記錄";
                      return (
                        <article className="review-edit-history-item" key={`${String(entry.editedAt)}-${index}`}>
                          <b>
                            {entry.actorName
                              ? maskName(String(entry.actorName))
                              : String(entry.actorId ?? "未知修改者")}
                          </b>
                          <span>{stamp}</span>
                          <ul>
                            {Object.entries(changes).map(([key, change]) => (
                              <li key={key}>
                                <strong>{labels[key] ?? key}</strong>
                                {key === "answers" ? (
                                  <details>
                                    <summary>查看逐題內容前後差異</summary>
                                    <pre>{JSON.stringify(change, null, 2)}</pre>
                                  </details>
                                ) : key === "reviewerName" ||
                                  key === "reviewedPersonName" ? (
                                  <span>
                                    {maskName(String(change.before ?? ""))} →{" "}
                                    {maskName(String(change.after ?? ""))}
                                  </span>
                                ) : (
                                  <span>{JSON.stringify(change.before)} → {JSON.stringify(change.after)}</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </article>
                      );
                    })}
                  </div>
                )}
              </>
            )}
            <div className="form-actions">
              <button type="button" className="button button-ghost" onClick={() => setExpandedRecordId(null)}>
                返回審查明細
              </button>
            </div>
          </div>
        </div>
      )}

      {reqModalOpen && (
        <div className="reviewer-modal-backdrop" onClick={() => setReqModalOpen(false)}>
          <div
            className="reviewer-modal wide panel"
            role="dialog"
            aria-modal="true"
            aria-label="封存後修改待審核"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="reviewer-modal-head">
              <div>
                <h2>封存後修改待審核</h2>
                <p>核准後才會套用到審查紀錄，並自動重新封存摘要</p>
              </div>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setReqModalOpen(false)}
                aria-label="關閉"
              >
                <X size={16} />
              </button>
            </div>
            {pendingReqs.length === 0 ? (
              <p className="muted-text">目前沒有待審核的修改。</p>
            ) : (
              pendingReqs.map((q) => {
                const nm = rows.find((r) => r.indicatorId === q.indicatorId);
                return (
                  <div key={q.id} className="panel" style={{ marginBottom: 12 }}>
                    <p>
                      <b>{nm?.indicatorName ?? stripInternalIdPrefix(q.indicatorId)}</b>・
                      {nm?.unitNameOf(q.unitId) ?? q.unitId}・{q.year}年{q.month}月
                    </p>
                    <p className="muted-text">
                      申請人：{q.requestedByName || q.requestedBy}・原因：{q.reason}
                    </p>
                    <p className="muted-text">
                      異動欄位：{Object.keys(q.changes).join("、") || "—"}
                      {typeof q.changes.rate !== "undefined" &&
                        `（正確率 ${String(q.changes.rate.before ?? "—")}% → ${String(q.changes.rate.after ?? "—")}%）`}
                    </p>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="button button-primary"
                        disabled={reqBusyId !== null}
                        onClick={() => handleDecision(q, true)}
                      >
                        {reqBusyId === q.id ? "處理中…" : "核准並重新封存"}
                      </button>
                      <button
                        type="button"
                        className="button button-outline"
                        disabled={reqBusyId !== null}
                        onClick={() => handleDecision(q, false)}
                      >
                        駁回
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {execRow && (
        <div className="reviewer-modal-backdrop" onClick={() => setExecRow(null)}>
          <div
            className="reviewer-modal panel"
            role="dialog"
            aria-modal="true"
            aria-label="選擇審查單位與月份"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="reviewer-modal-head">
              <div>
                <h2>進行品管審查</h2>
                <p>
                  {execRow.indicatorName}・{execRow.intervalLabel}
                </p>
              </div>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setExecRow(null)}
                aria-label="關閉"
              >
                <X size={16} />
              </button>
            </div>
            <div className="form-field">
              <label className="field-label">
                受審單位
                {execRow.sched.unlimitedUnits
                  ? "（不限單位）"
                  : execRow.assignedUnitIds.length > 0
                    ? "（您的被指派單位）"
                    : "（本排程受審單位）"}
              </label>
              {execRow.sched.unlimitedUnits ? (
                <p>
                  <b>NA（不限單位）</b>
                </p>
              ) : (
                <div className="select-wrap">
                  <select
                    value={execUnit}
                    onChange={(e) => {
                      const u = e.target.value;
                      setExecUnit(u);
                      if (execTaskKeys) {
                        const m = execRow.monthOptions.find((o) =>
                          execTaskKeys.has(`${u}|${o.year}-${o.month}`),
                        );
                        if (m) setExecMonth(`${m.year}-${m.month}`);
                      }
                    }}
                  >
                    {(execRow.assignedUnitIds.length > 0
                      ? execRow.assignedUnitIds
                      : execRow.sched.unitIds
                    )
                      .filter(
                        (c) =>
                          !execTaskKeys ||
                          execRow.monthOptions.some((o) =>
                            execTaskKeys.has(`${c}|${o.year}-${o.month}`),
                          ),
                      )
                      .map((c) => (
                        <option
                          key={c}
                          value={c}
                          disabled={execFullUnits?.has(c) ?? false}
                        >
                          {execRow.unitNameOf(c)}（{c}）
                          {execFullUnits?.has(c) ? "（已滿）" : ""}
                        </option>
                      ))}
                  </select>
                </div>
              )}
              {execFullUnits && execFullUnits.size > 0 && !execRow.sched.unlimitedUnits && (
                <p className="settings-note" style={{ color: "#b3372f" }}>
                  以下單位在本區間被分派月份的審查件數已滿（已提交＋暫存），無法再選：
                  {[...execFullUnits]
                    .map((c) => execRow.unitNameOf(c))
                    .join("、")}
                  。
                </p>
              )}
              {execTaskKeys && !execRow.sched.unlimitedUnits && (() => {
                const base =
                  execRow.assignedUnitIds.length > 0
                    ? execRow.assignedUnitIds
                    : execRow.sched.unitIds;
                const missing = base.filter(
                  (c) =>
                    !execRow.monthOptions.some((o) =>
                      execTaskKeys.has(`${c}|${o.year}-${o.month}`),
                    ),
                );
                return missing.length > 0 ? (
                  <p className="settings-note" style={{ color: "#b3372f" }}>
                    以下單位在本區間尚無審查任務，無法開啟審查表：
                    {missing.map((c) => execRow.unitNameOf(c)).join("、")}
                    。請至「品管審查排程」確認審查員／單位分工表含該單位後重新產生排程。
                  </p>
                ) : null;
              })()}
              {execTaskKeys &&
                execRow.sched.unlimitedUnits &&
                !execRow.monthOptions.some((o) =>
                  execTaskKeys.has(`|${o.year}-${o.month}`),
                ) && (
                  <p className="settings-note" style={{ color: "#b3372f" }}>
                    本區間尚無審查任務，請至「品管審查排程」產生排程。
                  </p>
                )}
            </div>
            <div className="form-field">
              <label className="field-label">審查月份</label>
              <div className="select-wrap">
                <select
                  value={execMonth}
                  onChange={(e) => setExecMonth(e.target.value)}
                >
                  {execRow.monthOptions
                    .filter(
                      (o) =>
                        !execTaskKeys ||
                        execTaskKeys.has(`${execUnit}|${o.year}-${o.month}`),
                    )
                    .map((o) => (
                    <option key={`${o.year}-${o.month}`} value={`${o.year}-${o.month}`}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="button button-primary"
                disabled={
                  execBusy ||
                  (!execRow.sched.unlimitedUnits && !execUnit) ||
                  (!execRow.sched.unlimitedUnits &&
                    (execFullUnits?.has(execUnit) ?? false)) ||
                  !execMonth
                }
                onClick={confirmExec}
              >
                {execBusy ? "開啟中…" : "開始審查"}
              </button>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setExecRow(null)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
