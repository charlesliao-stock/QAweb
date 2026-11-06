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
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  ArrowUpDown,
  ChevronDown,
  ClipboardCheck,
  Eye,
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
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { useAuth } from "../lib/auth";
import { maskName } from "../lib/mask";
import {
  normalizeAssignmentItem,
  parseIndicatorSchedule,
  type IndicatorSchedule,
} from "../lib/scheduling";
import {
  CONVENER_ROLES,
  OFFICER_ROLES,
  groupsForRoles,
  isConvenerRole,
  isOfficerRole,
  isReviewerRole,
  parseMemberships,
} from "../lib/roleIdentity";
import {
  auditRowMatches,
  computeIntervalProgress,
  containingInterval,
  intervalDisplay,
  isProgressComplete,
  recordYearMonth,
  ymKey,
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
  indicatorId: string;
  unitId: string;
  year: number;
  month: number;
  reviewDate: string;
  reviewerName: string;
  reviewedPersonName: string;
  rate: number | null;
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
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ActiveRow[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("group");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  // v1.20：清單上方篩選區（組別／指標／關鍵字）；表頭篩選列移除
  const [selGroup, setSelGroup] = useState("");
  const [selIndicator, setSelIndicator] = useState("");
  const [keyword, setKeyword] = useState("");
  const [viewRow, setViewRow] = useState<ActiveRow | null>(null);
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
  const [expandedLoading, setExpandedLoading] = useState(false);
  const [execRow, setExecRow] = useState<ActiveRow | null>(null);
  const [execUnit, setExecUnit] = useState("");
  const [execMonth, setExecMonth] = useState("");
  const [execBusy, setExecBusy] = useState(false);
  const [executing, setExecuting] = useState<ExecuteTarget | null>(null);

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
        const [iSnap, gSnap, uSnap, sSnap, aSnap, meSnap] = await Promise.all([
          getDocs(query(collection(db, "indicators"), limit(500))),
          getDocs(query(collection(db, "groups"), limit(200))),
          getDocs(query(collection(db, "units"), limit(2000))),
          getDocs(query(collection(db, "indicatorSchedules"), limit(500))),
          getDocs(query(collection(db, "indicatorAssignments"), limit(500))),
          getDoc(doc(db, "users", staffId)),
        ]);
        if (cancelled) return;

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

        // ---- 角色範圍（多重身分取聯集；v1.21 新舊並認） ----
        const roles = user.roles ?? [];
        const title = user.title ?? "";
        const isAdmin = roles.includes("系統管理員");
        const isSenior = title.includes("主任") || title.includes("督導");
        const isReviewer = isReviewerRole(roles);
        const isHeadNurse =
          title.includes("護理長") ||
          title.includes("執行幹事") ||
          roles.includes("單位執行幹事");
        const isConvener = isConvenerRole(roles) || isOfficerRole(roles);
        // 召集人／執行幹事的群組範圍：memberships 為主，舊 groupIds＋roles fallback；
        // 單位級角色以其單位所屬群組計
        const memberships = parseMemberships(meData.memberships, {
          roles,
          groupIds: myGroupIds,
        });
        const myConvenerGroupIds = groupsForRoles(
          memberships,
          [...CONVENER_ROLES, ...OFFICER_ROLES],
          user.unitCode ? unitGroup.get(user.unitCode) : undefined,
        );

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
          // v1.20：只顯示包含本月區間的指標（今天不在任何區間內就不列）
          const iv = containingInterval(schedLike(s), today);
          if (!iv) continue;
          cands.push({ sched: s, assigned: [...new Set(assigned)] });
        }
        if (cancelled) return;

        // ---- 審查紀錄（每支指標一個查詢，單一 where 避免複合索引） ----
        const indicatorIds = [...new Set(cands.map((c) => c.sched.indicatorId))];
        const recordsByIndicator = new Map<string, RecordRow[]>();
        await Promise.all(
          indicatorIds.map(async (iid) => {
            try {
              const rsnap = await getDocs(
                query(
                  collection(db, "reviewRecords"),
                  where("indicatorId", "==", iid),
                  limit(2000),
                ),
              );
              const list: RecordRow[] = [];
              rsnap.docs.forEach((d) => {
                const v = d.data() as Record<string, unknown>;
                const ym = recordYearMonth(v);
                if (!ym) return;
                const rate =
                  typeof v.rate === "number" && Number.isFinite(v.rate)
                    ? v.rate
                    : null;
                list.push({
                  id: d.id,
                  indicatorId: iid,
                  unitId: typeof v.unitId === "string" ? v.unitId : "",
                  year: ym.year,
                  month: ym.month,
                  reviewDate:
                    typeof v.reviewDate === "string" ? v.reviewDate : "",
                  reviewerName:
                    typeof v.reviewerName === "string" ? v.reviewerName : "",
                  reviewedPersonName:
                    typeof v.reviewedPersonName === "string"
                      ? v.reviewedPersonName
                      : "",
                  rate,
                });
              });
              if (!cancelled) recordsByIndicator.set(iid, list);
            } catch {
              if (!cancelled) recordsByIndicator.set(iid, []);
            }
          }),
        );
        if (cancelled) return;

        const out: ActiveRow[] = [];
        for (const { sched: s, assigned } of cands) {
          const ind = indicators.get(s.indicatorId);
          if (!ind) continue;
          const iv = containingInterval(schedLike(s), today);
          if (!iv) continue;
          const keys = new Set(iv.allMonths.map(ymKey));
          const inRecords = (recordsByIndicator.get(s.indicatorId) ?? []).filter(
            (r) => keys.has(ymKey({ year: r.year, month: r.month })),
          );
          const reviewMonthCount = iv.reviewMonths.length;
          const progress = computeIntervalProgress({
            unitCount: s.unitIds.length,
            caseCount: s.caseCount,
            reviewMonthCount,
            records: inRecords,
            intervalMonthKeys: keys,
          });
          if (isProgressComplete(progress)) continue; // 已達 100%
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
  }, [user?.staffId]);

  /* ---------- 檢視 modal：載入該指標題目（逐題明細分組＋指引用；v1.24） ---------- */
  useEffect(() => {
    setExpandedRecordId(null);
    setExpandedAnswers(null);
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

  /** 檢視 modal：展開／收起單筆紀錄的逐題明細（選項＋備註） */
  async function toggleRecordDetail(rec: RecordRow) {
    if (expandedRecordId === rec.id) {
      setExpandedRecordId(null);
      setExpandedAnswers(null);
      return;
    }
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
    } catch {
      setExpandedAnswers([]);
    } finally {
      setExpandedLoading(false);
    }
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
    const list = rows.filter((r) =>
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
  }, [rows, selGroup, selIndicator, keyword, sortKey, sortDir]);

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
    if (!execRow || !execUnit || !execMonth) return;
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
          "找不到該單位該月份的審查任務，請先到「品管審查排程」產生排程",
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
        onBack={() => setExecuting(null)}
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
      <section className="panel">
        <SectionTitle
          title="進行中的審查排程"
          note="依您的身分列出有排程且尚未結束的指標（只顯示包含本月區間者）；點標題可排序"
        />
        <div className="filter-bar">
          <div className="form-field" style={{ maxWidth: 200 }}>
            <label className="field-label">組別篩選</label>
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
            <label className="field-label">指標篩選</label>
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
          <div className="form-field" style={{ maxWidth: 260 }}>
            <label className="field-label">指標關鍵字</label>
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
            title="目前沒有進行中的審查排程"
            description="可能尚無排程、排程皆已結束，或您的身分沒有被指派審查項目。"
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
                      <div className="row-actions">
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => setViewRow(r)}
                        >
                          <Eye size={14} /> 檢視
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => openExec(r)}
                        >
                          <ClipboardCheck size={14} /> 審查
                        </button>
                      </div>
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
            className="reviewer-modal panel"
            role="dialog"
            aria-modal="true"
            aria-label="審查結果檢視"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="reviewer-modal-head">
              <div>
                <h2>審查結果</h2>
                <p>
                  {viewRow.indicatorName}・{viewRow.intervalLabel}
                </p>
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
            <SectionTitle title="排程設定摘要" />
            <dl className="detail-list">
              <div>
                <dt>組別</dt>
                <dd>{viewRow.groupName}</dd>
              </div>
              <div>
                <dt>年別</dt>
                <dd>
                  {viewRow.sched.category === "temp"
                    ? "臨時"
                    : viewRow.sched.periodLabel}
                </dd>
              </div>
              <div>
                <dt>審核區間</dt>
                <dd>{viewRow.intervalLabel}</dd>
              </div>
              <div>
                <dt>審查月份</dt>
                <dd>
                  {viewRow.monthOptions.map((o) => o.label).join("、") || "—"}
                </dd>
              </div>
              <div>
                <dt>受審單位</dt>
                <dd>
                  {viewRow.sched.unitIds.length} 個：
                  {viewRow.sched.unitIds
                    .map((c) => viewRow.unitNameOf(c))
                    .join("、") || "—"}
                </dd>
              </div>
              <div>
                <dt>每輪件數</dt>
                <dd>
                  {viewRow.sched.caseCount != null
                    ? `${viewRow.sched.caseCount} 件`
                    : "未設定"}
                </dd>
              </div>
              <div>
                <dt>審查頻次／區間</dt>
                <dd>
                  {viewRow.sched.frequency != null
                    ? `${viewRow.sched.frequency}次/年`
                    : "—"}
                  ／
                  {viewRow.sched.intervalMonths != null
                    ? `${viewRow.sched.intervalMonths}個月`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>最後編輯</dt>
                <dd>
                  {viewRow.sched.updatedByName || viewRow.sched.updatedBy || "—"}
                  {fmtTs(viewRow.sched.updatedAt)
                    ? `・${fmtTs(viewRow.sched.updatedAt)}`
                    : ""}
                </dd>
              </div>
            </dl>
            <SectionTitle
              title="已提交審查紀錄（本區間）"
              note={`${viewRow.records.length} 筆，唯讀`}
            />
            {viewRow.records.length === 0 ? (
              <p className="muted-text">本區間尚無提交紀錄。</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>年月</th>
                      <th>單位</th>
                      <th>審查日期</th>
                      <th>審查人員</th>
                      <th>受審人員</th>
                      <th>正確率</th>
                      <th>明細</th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewRow.records.map((r) => (
                      <Fragment key={r.id}>
                        <tr>
                          <td>
                            {r.year}年{r.month}月
                          </td>
                          <td>{viewRow.unitNameOf(r.unitId)}</td>
                          <td>{r.reviewDate || "—"}</td>
                          <td>{maskName(r.reviewerName) || "—"}</td>
                          <td>{maskName(r.reviewedPersonName) || "—"}</td>
                          <td>{r.rate == null ? "—" : `${r.rate}%`}</td>
                          <td>
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => toggleRecordDetail(r)}
                              aria-expanded={expandedRecordId === r.id}
                            >
                              {expandedRecordId === r.id ? "▾ 收起" : "▸ 明細"}
                            </button>
                          </td>
                        </tr>
                        {expandedRecordId === r.id ? (
                          <tr>
                            <td colSpan={7}>
                              {expandedLoading || expandedAnswers == null ? (
                                <p className="muted-text">載入明細中…</p>
                              ) : expandedAnswers.length === 0 ? (
                                <p className="muted-text">
                                  此筆紀錄沒有逐題作答資料。
                                </p>
                              ) : (
                                <ReviewQuestionList
                                  mode="view"
                                  questions={viewQuestions}
                                  showGroups={viewShowGroups}
                                  answers={expandedAnswers}
                                />
                              )}
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setViewRow(null)}
              >
                關閉
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
                {execRow.assignedUnitIds.length > 0
                  ? "（您的被指派單位）"
                  : "（本排程受審單位）"}
              </label>
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
                disabled={execBusy || !execUnit || !execMonth}
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
