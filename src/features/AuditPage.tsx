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
 */
import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpDown,
  ChevronDown,
  ClipboardCheck,
  Eye,
  Pencil,
  ShieldCheck,
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
import {
  getCachedRef,
  getCachedRefCollection,
  SYSTEM_CONFIG_KEY,
} from "../lib/refCache";
import { getDocCacheFirst, getDocsCacheFirst } from "../lib/cacheFirst";
import { fetchAllPaged } from "../lib/pagedQuery";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { useAuth } from "../lib/auth";
import { usePermissions } from "../lib/usePermissions";
import { staffLabel } from "../lib/mask";
import {
  normalizeAssignmentItem,
  parseIndicatorSchedule,
  periodicQuotaGroupId,
  type IndicatorSchedule,
} from "../lib/scheduling";
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
import {
  normalizeQuestions,
  type AuditQuestion,
} from "../lib/indicators";
import type { ReviewAnswer } from "../lib/reviewRecords";
import { ReviewExecutePage, type ExecuteTarget } from "./ReviewExecutePage";
import { ReviewQuestionList } from "./ReviewQuestionList";

interface IndicatorLite {
  id: string;
  name: string;
  groupId: string;
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
  indicatorName: string;
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
  monthOptions: MonthOption[];
  /** 該指標本區間的審查紀錄（檢視用） */
  records: RecordRow[];
  unitNameOf: (code: string) => string;
}

type SortKey = "group" | "name" | "interval" | "person" | "unit";

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "讀寫失敗，請檢查網路連線後再試";
}

function fmtPct(p: number | null): string {
  return p == null ? "—" : `${p}%`;
}

function schedLike(s: IndicatorSchedule) {
  return {
    category: s.category,
    period: s.period,
    months: s.months,
    frequency: s.frequency,
    intervalMonths: s.intervalMonths,
    refYear: s.refYear,
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
      <div className="progress-track" aria-hidden="true">
        <div className="progress-fill" style={{ width: `${w}%` }} />
      </div>
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
  const [sortKey, setSortKey] = useState<SortKey>("group");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  // v1.20：清單上方篩選區（組別／指標／關鍵字）；表頭篩選列移除
  // v1.46.0：篩選區依序為組別／指標／進度／關鍵字；進度預設進行中
  const [selGroup, setSelGroup] = useState("");
  const [selIndicator, setSelIndicator] = useState("");
  const [selProgress, setSelProgress] =
    useState<AuditProgressState>("active");
  const [keyword, setKeyword] = useState("");
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
  const [execBusy, setExecBusy] = useState(false);
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
        const [iSnap, gSnap, uSnap, sSnap, aSnap, meSnap, sysSnap] =
          await Promise.all([
            getCachedRefCollection("indicators", () =>
              getDocsCacheFirst(query(collection(db, "indicators"), limit(500))),
            ),
            getCachedRefCollection("groups", () =>
              getDocsCacheFirst(query(collection(db, "groups"), limit(200))),
            ),
            getCachedRefCollection("units", () =>
              getDocsCacheFirst(query(collection(db, "units"), limit(2000))),
            ),
            getDocs(query(collection(db, "indicatorSchedules"), limit(500))),
            getDocs(query(collection(db, "indicatorAssignments"), limit(500))),
            getDoc(doc(db, "users", staffId)),
            // v1.46.0：補資料日取系統參數現值（讀不到用預設 10）
            getCachedRef(SYSTEM_CONFIG_KEY, () =>
              getDocCacheFirst(doc(db, "systemParams", "config")),
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
            name: typeof v.name === "string" && v.name ? v.name : d.id,
            groupId: typeof v.groupId === "string" ? v.groupId : "",
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
        // 分工表：指標 → 審查員 → 單位
        const reviewerOf = new Map<string, Map<string, string[]>>();
        aSnap.docs.forEach((d) => {
          const v = d.data() as Record<string, unknown>;
          const indicatorId =
            typeof v.indicatorId === "string" ? v.indicatorId : d.id;
          const items = Array.isArray(v.items)
            ? v.items
                .map((it) => normalizeAssignmentItem(it))
                .filter((it) => it !== null)
            : [];
          const m = new Map<string, string[]>();
          items.forEach((it) => {
            if (it) m.set(it.reviewerId, it.units.map((u) => u.unitId));
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
        );
        setEditableGroupIds(myConvenerGroupIds);

        interface Cand {
          sched: IndicatorSchedule;
          assigned: string[];
        }
        const cands: Cand[] = [];
        for (const s of schedules) {
          const ind = indicators.get(s.indicatorId);
          if (!ind) continue;
          let visible = false;
          const assigned: string[] = [];
          if (isAdmin || isSenior) visible = true;
          if (isReviewer) {
            const units = reviewerOf.get(s.indicatorId)?.get(staffId);
            if (units) {
              visible = true;
              assigned.push(...units);
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
          cands.push({ sched: s, assigned: [...new Set(assigned)] });
        }
        if (cancelled) return;

        // v1.46.0：進度三態＋現階段區間（精確到日；空窗期仍算進行中）。
        // 一列一排程：進行中顯示包含今天（或空窗期對應）的區間；
        // 待完成顯示下一個未開始的區間；已結束顯示最後一個區間。
        const classified: {
          sched: IndicatorSchedule;
          assigned: string[];
          state: AuditProgressState;
          interval: ReviewInterval;
        }[] = [];
        for (const c of cands) {
          const cls = classifyScheduleProgress(
            schedLike(c.sched),
            today,
            deadlineDay,
          );
          if (!cls) continue;
          classified.push({ ...c, state: cls.state, interval: cls.interval });
        }
        if (cancelled) return;

        // ---- 審查紀錄（v1.28 階段 6 B6）：單一查詢＋游標分頁，前端按指標分組 ----
        // 年份下限（v1.46.0 放寬）：已結束要回看更早區間，舊「去年」下限會讓
        // 舊區間進度顯示為 0。改以各列顯示區間的最早年份為準，至少去年、
        // 最多往前三年（讀取量上限約 4 年份紀錄；前端仍以區間月份鍵過濾，
        // 伺服器端年份只是預篩、不影響正確性）。
        // 單一範圍 where ＋ 同欄位 orderBy（分頁 helper 內加），不需複合索引；
        // 分頁循序拉完，修掉舊 limit(2000) 靜默截斷。
        let minYear = today.getFullYear() - 1;
        for (const c of classified) {
          minYear = Math.min(minYear, c.interval.start.year);
        }
        minYear = Math.max(minYear, today.getFullYear() - 3);
        const recordsByIndicator = new Map<string, RecordRow[]>();
        let recordsTruncated = false;
        try {
          const { docs, truncated } = await fetchAllPaged(
            collection(db, "reviewRecords"),
            [where("year", ">=", minYear)],
          );
          recordsTruncated = truncated;
          docs.forEach((d) => {
            const v = d.data() as Record<string, unknown>;
            const iid =
              typeof v.indicatorId === "string" ? v.indicatorId : "";
            if (!iid) return;
            const ym = recordYearMonth(v);
            if (!ym) return;
            const rate =
              typeof v.rate === "number" && Number.isFinite(v.rate)
                ? v.rate
                : null;
            const row: RecordRow = {
              id: d.id,
              taskId: typeof v.taskId === "string" ? v.taskId : d.id,
              indicatorId: iid,
              unitId: typeof v.unitId === "string" ? v.unitId : "",
              year: ym.year,
              month: ym.month,
              reviewDate:
                typeof v.reviewDate === "string" ? v.reviewDate : "",
              reviewerEmpNo:
                typeof v.reviewerEmpNo === "string" ? v.reviewerEmpNo : "",
              reviewerName:
                typeof v.reviewerName === "string" ? v.reviewerName : "",
              reviewedPersonEmpNo:
                typeof v.reviewedPersonEmpNo === "string"
                  ? v.reviewedPersonEmpNo
                  : "",
              reviewedPersonName:
                typeof v.reviewedPersonName === "string"
                  ? v.reviewedPersonName
                  : "",
              auditItem:
                typeof v.auditItem === "string" ? v.auditItem : "",
              rate,
              quotaGroupId:
                typeof v.quotaGroupId === "string" ? v.quotaGroupId : "",
              source: typeof v.source === "string" ? v.source : "",
            };
            const list = recordsByIndicator.get(iid) ?? [];
            list.push(row);
            recordsByIndicator.set(iid, list);
          });
        } catch {
          // 單一查詢失敗：紀錄留空（進度暫顯示為 0），不讓整頁掛掉；
          // 視為未拉完，畫面顯示可見提示。
          recordsTruncated = true;
        }
        if (cancelled) return;
        if (!cancelled) setRecordsTruncated(recordsTruncated);

        const out: ActiveRow[] = [];
        for (const { sched: s, assigned, state, interval: iv } of classified) {
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
          const progress = computeIntervalProgress({
            // v1.51.0：不限單位視為一個虛擬單位（總人次＝件數、總單位＝1）
            unitCount: s.unlimitedUnits ? 1 : s.unitIds.length,
            caseCount: s.caseCount,
            reviewMonthCount,
            category: s.category,
            records: inRecords,
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
          out.push({
            sched: s,
            indicatorId: s.indicatorId,
            indicatorName: ind.name,
            groupId: ind.groupId,
            groupName: groupName.get(ind.groupId) ?? "未分類",
            state,
            complete: isProgressComplete(progress),
            interval: iv,
            intervalLabel: intervalDisplay(iv, s.category),
            progress,
            reviewMonthCount,
            assignedUnitIds: assigned,
            monthOptions,
            records: [...inRecords].sort(
              (a, b) =>
                a.year - b.year ||
                a.month - b.month ||
                a.unitId.localeCompare(b.unitId, "zh-Hant"),
            ),
            unitNameOf,
          });
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
  }, [user?.staffId, dataRefreshKey, orgMeta.roleMeta]);

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
    const m = new Map<string, string>();
    list.forEach((r) => {
      if (!m.has(r.indicatorId)) m.set(r.indicatorId, r.indicatorName);
    });
    return [...m.entries()];
  }, [rows, selGroup]);

  const filtered = useMemo(() => {
    const list = rows.filter(
      (r) =>
        r.state === selProgress &&
        auditRowMatches(r, {
          groupId: selGroup,
          indicatorId: selIndicator,
          keyword,
        }),
    );
    const dir = sortDir;
    const val = (r: ActiveRow): number | string => {
      switch (sortKey) {
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
      ? "依您的身分列出進行中的審查排程（含區間已結束、仍在補資料期限內的區間）；點標題可排序"
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
    const summaries = new Map<string, { count: number; rates: number[] }>();
    viewRow.sched.unitIds.forEach((unitId) =>
      summaries.set(unitId, { count: 0, rates: [] }),
    );
    viewRow.records.forEach((record) => {
      const summary = summaries.get(record.unitId) ?? { count: 0, rates: [] };
      summary.count += 1;
      if (record.rate != null) summary.rates.push(record.rate);
      summaries.set(record.unitId, summary);
    });
    return [...summaries.entries()].map(([unitId, summary]) => ({
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
          !selectedUnitFilter ||
          (selectedUnitFilter === "__na__"
            ? record.unitId === ""
            : record.unitId === selectedUnitFilter),
      ) ?? [],
    [viewRow, selectedUnitFilter],
  );

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(1);
    }
  }

  function SortTh({ label, k }: { label: string; k: SortKey }) {
    const active = sortKey === k;
    return (
      <th>
        <button
          type="button"
          className={`th-sort${active ? " active" : ""}`}
          onClick={() => toggleSort(k)}
          aria-label={`依${label}排序`}
        >
          {label}
          <ArrowUpDown size={13} />
          {active && (sortDir === 1 ? " ▲" : " ▼")}
        </button>
      </th>
    );
  }

  function openExec(row: ActiveRow) {
    setExecRow(row);
    const units =
      row.assignedUnitIds.length > 0 ? row.assignedUnitIds : row.sched.unitIds;
    setExecUnit(units[0] ?? "");
    const firstReview = row.interval.reviewMonths[0];
    const defMonth =
      (firstReview != null
        ? row.monthOptions.find(
            (o) => o.year === firstReview.year && o.month === firstReview.month,
          )
        : undefined) ?? row.monthOptions[0];
    setExecMonth(defMonth ? `${defMonth.year}-${defMonth.month}` : "");
    setExecBusy(false);
  }

  async function confirmExec() {
    // v1.51.0：不限單位排程 execUnit 為 ""（不用選單位），只檢查月份
    if (!execRow || !execMonth) return;
    if (!execRow.sched.unlimitedUnits && !execUnit) return;
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
      <div className="privacy-note">
        <ShieldCheck size={16} />
        <span>
          <b>隱私提醒</b>
          ：稽核時請勿拍攝病人臉部或可辨識身分之資訊。
        </span>
      </div>
      {recordsTruncated && (
        <p
          className="settings-note"
          style={{ color: "#b3372f", fontWeight: 600 }}
        >
          審查紀錄未完整載入（分頁中斷），進度可能低估；請重新整理後再確認。
        </p>
      )}
      <section className="panel">
        <SectionTitle title={progressTitle} note={progressNote} />
        <div className="filter-bar">
          <div className="form-field" style={{ maxWidth: 200 }}>
            <label className="field-label">組別</label>
            <div className="select-wrap">
              <select
                value={selGroup}
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
                }}
              >
                <option value="">全部組別</option>
                {groupOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} />
            </div>
          </div>
          <div className="form-field" style={{ maxWidth: 280 }}>
            <label className="field-label">指標</label>
            <div className="select-wrap">
              <select
                value={selIndicator}
                onChange={(e) => setSelIndicator(e.target.value)}
              >
                <option value="">全部指標</option>
                {indicatorOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}（{id}）
                  </option>
                ))}
              </select>
              <ChevronDown size={15} />
            </div>
          </div>
          <div className="form-field" style={{ maxWidth: 200 }}>
            <label className="field-label">進度</label>
            <div className="select-wrap">
              <select
                value={selProgress}
                onChange={(e) =>
                  setSelProgress(e.target.value as AuditProgressState)
                }
              >
                <option value="active">進行中</option>
                <option value="ended">已結束</option>
                <option value="pending">待完成</option>
              </select>
              <ChevronDown size={15} />
            </div>
          </div>
          <div className="form-field" style={{ maxWidth: 260 }}>
            <label className="field-label">關鍵字</label>
            <input
              className="text-input"
              placeholder="指標名稱或編號"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
        </div>
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
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <SortTh label="組別" k="group" />
                  <SortTh label="指標名稱" k="name" />
                  <SortTh label="審核區間" k="interval" />
                  <SortTh label="審核進度（人次）" k="person" />
                  <SortTh label="審核進度（單位次）" k="unit" />
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr
                    key={`${r.indicatorId}__${r.sched.category}__${r.sched.period}`}
                  >
                    <td>{r.groupName}</td>
                    <td>
                      <b>{r.indicatorName}</b>
                      <div className="muted-text">{r.indicatorId}</div>
                      {r.sched.category === "temp" && (
                        <span className="badge">臨時</span>
                      )}
                    </td>
                    <td>{r.intervalLabel}</td>
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
                    <td>
                      {r.state === "pending" ? (
                        <span className="muted-text">—</span>
                      ) : (
                        <div className="row-actions">
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => setViewRow(r)}
                          >
                            <Eye size={14} /> 檢視
                          </button>
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
          </div>
        )}
      </section>

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
                      <th>審核項目</th>
                      <th>正確率</th>
                      <th>個人結果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewRecords.map((record) => (
                      <tr key={record.id}>
                        <td data-label="年月">{record.year}年{record.month}月</td>
                        <td data-label="審查日期">{record.reviewDate || "—"}</td>
                        <td data-label="審查人員">{staffLabel(record.reviewerEmpNo, record.reviewerName)}</td>
                        <td data-label="受審人員">{staffLabel(record.reviewedPersonEmpNo, record.reviewedPersonName)}</td>
                        <td data-label="審核項目">{record.auditItem || "—"}</td>
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
                        ? new Date(entry.editedAt).toLocaleString("zh-TW", { hour12: false })
                        : "時間未記錄";
                      return (
                        <article className="review-edit-history-item" key={`${String(entry.editedAt)}-${index}`}>
                          <b>{String(entry.actorName ?? entry.actorId ?? "未知修改者")}</b>
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
                    onChange={(e) => setExecUnit(e.target.value)}
                  >
                    {(execRow.assignedUnitIds.length > 0
                      ? execRow.assignedUnitIds
                      : execRow.sched.unitIds
                    ).map((c) => (
                      <option key={c} value={c}>
                        {execRow.unitNameOf(c)}（{c}）
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="form-field">
              <label className="field-label">審查月份</label>
              <div className="select-wrap">
                <select
                  value={execMonth}
                  onChange={(e) => setExecMonth(e.target.value)}
                >
                  {execRow.monthOptions.map((o) => (
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
