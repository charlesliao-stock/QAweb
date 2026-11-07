/**
 * 儀表板共用資料（v1.15.0 新增；v1.28 階段 2 瘦身）。
 * 只拉「本月任務提醒」所需資料：
 * 任務＝本月＋次月預告＋全量鎖定＋逾期未完成（校正用）；
 * 紀錄＝本月＋48h 警示窗口（submittedAt >= 48 小時前）＋鎖定／逾期任務的紀錄
 * （taskId in 查詢分批補，每批 30 個、上限 90 個任務）。
 * 查詢皆為單欄位等號／單一範圍，不需複合索引——除了逾期校正查詢
 * where("status","==","pending").where("deadline","<",今天)，需複合索引
 * (status ASC, deadline ASC)，見 firestore.indexes.json。
 * 索引未就緒時該查詢會拋 FAILED_PRECONDITION：跳過校正、畫面顯示提示，
 * 絕不讓儀表板掛掉。
 * 載入時自動校正任務狀態（完成→done；逾期→locked；其餘→pending，沿用 v1.12.2 模式）。
 */
import { useCallback, useEffect, useState } from "react";
import {
  collection,
  doc,
  getDocs,
  query,
  serverTimestamp,
  timestampFromMs,
  where,
  writeBatch,
} from "../../lib/db";
import { getFirebaseDb } from "../../lib/firebase";
import { getCachedRefCollection } from "../../lib/refCache";
import { getDocsCacheFirst } from "../../lib/cacheFirst";
import { correctTaskStatus } from "../../lib/reviewProgress";
import {
  markCorrectionWritten,
  shouldWriteCorrection,
} from "../../lib/correctionThrottle";
import { primaryThreshold } from "../../lib/indicators";
import { todayStr } from "../../lib/scheduling";
import type {
  DashRecord,
  DashTask,
} from "../../lib/dashboardStats";
import {
  countRecordsByTask,
  dashboardMonthWindow,
  mergeDashTasks,
  taskProgressCount,
} from "../../lib/dashboardStats";
import type { ReviewTaskStatus } from "../../lib/scheduling";

/** 鎖定／逾期任務補紀錄的上限（taskId in 每批 30 個，最多 3 批） */
const EXTRA_RECORD_TASK_CAP = 90;
const IN_BATCH_SIZE = 30;

export interface DashIndicator {
  id: string;
  name: string;
  groupId: string;
  threshold: number;
  requireBedNo: boolean;
}
export interface DashGroup {
  id: string;
  name: string;
}
export interface DashUnit {
  id: string;
  code: string;
  name: string;
  groupId: string;
}
export interface DashUnlock {
  id: string;
  taskId: string;
  indicatorId: string;
  unitId: string;
  year: number;
  month: number;
  requestedBy: string;
  requestedByName: string;
  reason: string;
  status: string;
}

export interface DashboardData {
  indicators: DashIndicator[];
  indicatorMap: Map<string, string>;
  indicatorById: Map<string, DashIndicator>;
  groups: DashGroup[];
  groupMap: Map<string, string>;
  units: DashUnit[];
  unitMap: Map<string, DashUnit>;
  tasks: DashTask[];
  records: DashRecord[];
  unlockPending: DashUnlock[];
  loading: boolean;
  reload: () => void;
  /**
   * v1.28 階段 2：逾期校正查詢因 (status, deadline) 複合索引未就緒而跳過。
   * 畫面應顯示可見提示，提醒使用者稍後再試；其餘內容不受影響。
   */
  correctionSkipped: boolean;
  /**
   * v1.28 階段 6（B8）：狀態校正寫入失敗（batch.commit() 被拒）。
   * 畫面應顯示可見提示；失敗的校正不記入節流，下次載入再試。
   */
  correctionFailed: boolean;
}

function parseTask(
  id: string,
  data: Record<string, unknown>,
): Omit<DashTask, "doneCount"> {
  const cc = data.caseCount;
  const st = String(data.status ?? "pending");
  const quotaCategory =
    data.quotaCategory === "year" || data.quotaCategory === "academic"
      ? data.quotaCategory
      : undefined;
  return {
    id,
    indicatorId: String(data.indicatorId ?? ""),
    unitId: String(data.unitId ?? ""),
    reviewerId: String(data.reviewerId ?? ""),
    year: Number(data.year ?? 0),
    month: Number(data.month ?? 0),
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
    deadline: String(data.deadline ?? ""),
    status: (st === "done" ? "done" : st === "locked" ? "locked" : "pending") as ReviewTaskStatus,
  };
}

function parseRecord(
  id: string,
  data: Record<string, unknown>,
): DashRecord {
  const ans = Array.isArray(data.answers) ? data.answers : [];
  return {
    id,
    taskId:
      typeof data.taskId === "string" ? data.taskId : id,
    indicatorId: String(data.indicatorId ?? ""),
    unitId: String(data.unitId ?? ""),
    year: Number(data.year ?? 0),
    month: Number(data.month ?? 0),
    reviewDate: typeof data.reviewDate === "string" ? data.reviewDate : "",
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
    rate: typeof data.rate === "number" ? data.rate : null,
    quotaGroupId:
      typeof data.quotaGroupId === "string" ? data.quotaGroupId : undefined,
    source: typeof data.source === "string" ? data.source : undefined,
    answers: (ans as Record<string, unknown>[]).map((a) => ({
      questionId: String(a.questionId ?? ""),
      itemText: String(a.itemText ?? ""),
      optionLabel: String(a.optionLabel ?? ""),
      score: Number(a.score ?? 0),
      excluded: a.excluded === true,
      note: typeof a.note === "string" ? a.note : "",
    })),
    submittedAt: data.submittedAt,
  };
}

export function useDashboardData(): DashboardData {
  const win = dashboardMonthWindow(new Date());
  const { curYear, curMonth, nextYear, nextMonth } = win;
  const [indicators, setIndicators] = useState<DashIndicator[]>([]);
  const [groups, setGroups] = useState<DashGroup[]>([]);
  const [units, setUnits] = useState<DashUnit[]>([]);
  const [tasks, setTasks] = useState<DashTask[]>([]);
  const [records, setRecords] = useState<DashRecord[]>([]);
  const [unlockPending, setUnlockPending] = useState<DashUnlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [correctionSkipped, setCorrectionSkipped] = useState(false);
  const [correctionFailed, setCorrectionFailed] = useState(false);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setCorrectionFailed(false); // 每輪載入重新計算寫入失敗狀態
      try {
        const db = getFirebaseDb();
        const today = todayStr();
        const [isnap, gsnap, usnap, monthTsnap, nextTsnap, lockedTsnap, monthRsnap, alertRsnap, usnap2] = await Promise.all([
          getCachedRefCollection("indicators", () =>
            getDocsCacheFirst(collection(db, "indicators")),
          ),
          getCachedRefCollection("groups", () =>
            getDocsCacheFirst(collection(db, "groups")),
          ),
          getCachedRefCollection("units", () =>
            getDocsCacheFirst(collection(db, "units")),
          ),
          // v1.28 階段 2：任務只拉本月（年＋月兩個等號，不需複合索引）
          getDocs(
            query(
              collection(db, "reviewTasks"),
              where("year", "==", curYear),
              where("month", "==", curMonth),
            ),
          ),
          // 次月預告（次月尚無紀錄，不拉紀錄）
          getDocs(
            query(
              collection(db, "reviewTasks"),
              where("year", "==", nextYear),
              where("month", "==", nextMonth),
            ),
          ),
          // 逾期鎖定清單（不限月份；筆數通常少）
          getDocs(
            query(collection(db, "reviewTasks"), where("status", "==", "locked")),
          ),
          // 紀錄只拉本月
          getDocs(
            query(
              collection(db, "reviewRecords"),
              where("year", "==", curYear),
              where("month", "==", curMonth),
            ),
          ),
          // 48h 警示：submittedAt 單一範圍查詢（每月 1–2 日窗口跨到上月也涵蓋）
          getDocs(
            query(
              collection(db, "reviewRecords"),
              where("submittedAt", ">=", timestampFromMs(win.alertSinceMs)),
            ),
          ),
          getDocs(
            query(
              collection(db, "unlockRequests"),
              where("status", "==", "pending"),
            ),
          ).catch(() => ({ docs: [] as never[] })),
        ]);
        if (cancelled) return;
        const inds: DashIndicator[] = [];
        isnap.docs.forEach((d) => {
          const v = d.data() as Record<string, unknown>;
          inds.push({
            id: d.id,
            name: typeof v.name === "string" ? v.name : d.id,
            groupId: typeof v.groupId === "string" ? v.groupId : "",
            // v1.17：頂層 threshold 存檔時已寫入基本資料閾值；舊資料缺值時 fallback 主閾值
            threshold:
              typeof v.threshold === "number"
                ? v.threshold
                : primaryThreshold(v),
            requireBedNo: v.requireBedNo === true,
          });
        });
        const grps: DashGroup[] = [];
        gsnap.docs.forEach((d) => {
          const v = d.data() as Record<string, unknown>;
          grps.push({
            id: d.id,
            name: typeof v.name === "string" ? v.name : d.id,
          });
        });
        const uns: DashUnit[] = [];
        usnap.docs.forEach((d) => {
          const v = d.data() as Record<string, unknown>;
          uns.push({
            id: d.id,
            code: d.id,
            name: typeof v.name === "string" ? v.name : d.id,
            groupId: typeof v.groupId === "string" ? v.groupId : "",
          });
        });
        // 逾期校正專用查詢（獨立 try/catch：索引未就緒時跳過校正、不影響畫面）
        // status 等號＋deadline 範圍需複合索引 (status ASC, deadline ASC)
        let overdueDocs: { id: string; data: () => Record<string, unknown> }[] = [];
        let skipped = false;
        try {
          const osnap = await getDocs(
            query(
              collection(db, "reviewTasks"),
              where("status", "==", "pending"),
              where("deadline", "<", today),
            ),
          );
          overdueDocs = osnap.docs as unknown as {
            id: string;
            data: () => Record<string, unknown>;
          }[];
        } catch (e) {
          if ((e as { code?: string })?.code === "failed-precondition") {
            skipped = true;
          }
          // 其他錯誤亦跳過校正（下次載入再試），不影響畫面
        }
        if (cancelled) return;
        // 任務合併：本月＋次月＋鎖定＋逾期（依 id 去重）
        const parsedMonth = monthTsnap.docs.map((d) => ({
          ...parseTask(d.id, d.data() as Record<string, unknown>),
          doneCount: 0,
        }));
        const parsedNext = nextTsnap.docs.map((d) => ({
          ...parseTask(d.id, d.data() as Record<string, unknown>),
          doneCount: 0,
        }));
        const parsedLocked = lockedTsnap.docs.map((d) => ({
          ...parseTask(d.id, d.data() as Record<string, unknown>),
          doneCount: 0,
        }));
        const parsedOverdue = overdueDocs.map((d) => ({
          ...parseTask(d.id, d.data()),
          doneCount: 0,
        }));
        const list = mergeDashTasks(
          parsedMonth,
          parsedNext,
          parsedLocked,
          parsedOverdue,
        );
        // 紀錄合併：本月＋48h（依 id 去重；48h 可能跨月，屬上月任務者亦計入）
        const recMap = new Map<string, DashRecord>();
        for (const snap of [monthRsnap, alertRsnap]) {
          snap.docs.forEach((d) => {
            const r = parseRecord(d.id, d.data() as Record<string, unknown>);
            if (!recMap.has(r.id)) recMap.set(r.id, r);
          });
        }
        // 非本月鎖定／逾期任務的紀錄：taskId in 分批補（每批 30 個、上限 90 個任務）
        const inMonth = (t: DashTask) =>
          t.year === curYear && t.month === curMonth;
        const needIds = [...new Set(
          list.filter((t) => !inMonth(t)).map((t) => t.id),
        )];
        const fetchIds = needIds.slice(0, EXTRA_RECORD_TASK_CAP);
        for (let i = 0; i < fetchIds.length; i += IN_BATCH_SIZE) {
          const batchIds = fetchIds.slice(i, i + IN_BATCH_SIZE);
          try {
            const bsnap = await getDocs(
              query(
                collection(db, "reviewRecords"),
                where("taskId", "in", batchIds),
              ),
            );
            bsnap.docs.forEach((d) => {
              const r = parseRecord(d.id, d.data() as Record<string, unknown>);
              if (!recMap.has(r.id)) recMap.set(r.id, r);
            });
          } catch {
            /* 補紀錄失敗不影響畫面：該批任務進度暫顯示為未知 */
            for (const id of batchIds) {
              const t = list.find((x) => x.id === id);
              if (t) t.doneCountUnknown = true;
            }
          }
          if (cancelled) return;
        }
        // 超過上限者：完成進度未知（畫面顯示「—」，不顯示錯誤的 0）
        for (const id of needIds.slice(EXTRA_RECORD_TASK_CAP)) {
          const t = list.find((x) => x.id === id);
          if (t) t.doneCountUnknown = true;
        }
        const recs = [...recMap.values()];
        // 逐件完成數（本月任務的紀錄即足夠；鎖定／逾期任務已另補）
        const countMap = countRecordsByTask(recs);
        for (const t of list) {
          t.doneCount = countMap.get(t.id) ?? 0;
        }
        const quotaTasks = list.filter(
          (task) => task.quotaVersion === 1 && task.quotaGroupId,
        );
        if (quotaTasks.length > 0) {
          try {
            const { loadPeriodicQuotaCounts } = await import(
              "./periodicQuotaCounts"
            );
            const { counts, failedGroups } = await loadPeriodicQuotaCounts(
              db,
              quotaTasks,
            );
            if (cancelled) return;
            quotaTasks.forEach((task) => {
              const groupId = task.quotaGroupId!;
              task.quotaDoneCount = counts.get(groupId) ?? 0;
              if (failedGroups.has(groupId))
                task.quotaDoneCountUnknown = true;
            });
          } catch {
            quotaTasks.forEach((task) =>
              (task.quotaDoneCountUnknown = true),
            );
          }
        }
        // 狀態自動校正（v1.12.2 模式＋v1.15.0 鎖定）
        // v1.27.2：只收集「真的不同」的任務，單一 writeBatch 提交（失敗不影響畫面，下次再試）
        // v1.28 階段 6（B8）：再節流——同一任務一小時內已寫入過相同目標狀態
        // 就不再重寫（記憶體節流，同一分頁工作階段有效；目標狀態變了仍寫）。
        // 只有 commit 成功才記入節流；失敗時顯示可見提示（correctionFailed），
        // 且不記入節流，下次載入再試。
        const fixes: { id: string; patch: Record<string, unknown> }[] = [];
        for (const t of list) {
          const progressCount = taskProgressCount(t);
          if (progressCount == null) continue;
          const right = correctTaskStatus(
            progressCount,
            t.caseCount,
            t.deadline,
            t.status,
          );
          if (right !== t.status) {
            t.status = right;
            const patch: Record<string, unknown> = { status: right };
            if (right === "done") patch.completedAt = serverTimestamp();
            if (shouldWriteCorrection(t.id, right)) {
              fixes.push({ id: t.id, patch });
            }
          }
        }
        if (fixes.length > 0) {
          const db2 = getFirebaseDb();
          for (let i = 0; i < fixes.length; i += 400) {
            const chunk = fixes.slice(i, i + 400);
            const batch = writeBatch(db2);
            chunk.forEach((f) =>
              batch.update(doc(db2, "reviewTasks", f.id), f.patch),
            );
            batch
              .commit()
              .then(() => {
                chunk.forEach((f) =>
                  markCorrectionWritten(f.id, String(f.patch.status)),
                );
              })
              .catch(() => {
                if (!cancelled) setCorrectionFailed(true);
              });
          }
        }
        const ups: DashUnlock[] = [];
        (usnap2.docs as { id: string; data: () => Record<string, unknown> }[]).forEach(
          (d) => {
            const v = d.data();
            ups.push({
              id: d.id,
              taskId: String(v.taskId ?? ""),
              indicatorId: String(v.indicatorId ?? ""),
              unitId: String(v.unitId ?? ""),
              year: Number(v.year ?? 0),
              month: Number(v.month ?? 0),
              requestedBy: String(v.requestedBy ?? ""),
              requestedByName: String(v.requestedByName ?? ""),
              reason: String(v.reason ?? ""),
              status: String(v.status ?? "pending"),
            });
          },
        );
        if (cancelled) return;
        setIndicators(inds);
        setGroups(grps);
        setUnits(uns);
        setTasks(list);
        setRecords(recs);
        setUnlockPending(ups);
        setCorrectionSkipped(skipped);
      } catch {
        /* 讀不到就顯示空狀態 */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const indicatorMap = new Map(indicators.map((i) => [i.id, i.name]));
  const indicatorById = new Map(indicators.map((i) => [i.id, i]));
  const groupMap = new Map(groups.map((g) => [g.id, g.name]));
  const unitMap = new Map(units.map((u) => [u.id, u]));

  return {
    indicators,
    indicatorMap,
    indicatorById,
    groups,
    groupMap,
    units,
    unitMap,
    tasks,
    records,
    unlockPending,
    loading,
    reload,
    correctionSkipped,
    correctionFailed,
  };
}
