/**
 * 儀表板共用資料（v1.15.0 新增）。
 * 一次載入指標／群組／單位／任務／逐件紀錄／待審核解鎖申請；
 * 載入時自動校正任務狀態（完成→done；逾期→locked；其餘→pending，沿用 v1.12.2 模式）。
 */
import { useCallback, useEffect, useState } from "react";
import {
  collection,
  doc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "../../lib/db";
import { getFirebaseDb } from "../../lib/firebase";
import { correctTaskStatus } from "../../lib/reviewProgress";
import { primaryThreshold } from "../../lib/indicators";
import type {
  DashRecord,
  DashTask,
} from "../../lib/dashboardStats";
import type { ReviewTaskStatus } from "../../lib/scheduling";

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
}

function parseTask(
  id: string,
  data: Record<string, unknown>,
): Omit<DashTask, "doneCount"> {
  const cc = data.caseCount;
  const st = String(data.status ?? "pending");
  return {
    id,
    indicatorId: String(data.indicatorId ?? ""),
    unitId: String(data.unitId ?? ""),
    reviewerId: String(data.reviewerId ?? ""),
    year: Number(data.year ?? 0),
    month: Number(data.month ?? 0),
    caseCount:
      typeof cc === "number" && Number.isInteger(cc) && cc >= 1 ? cc : null,
    deadline: String(data.deadline ?? ""),
    status: (st === "done" ? "done" : st === "locked" ? "locked" : "pending") as ReviewTaskStatus,
  };
}

export function useDashboardData(): DashboardData {
  const now = new Date();
  const curYear = now.getFullYear();
  const [indicators, setIndicators] = useState<DashIndicator[]>([]);
  const [groups, setGroups] = useState<DashGroup[]>([]);
  const [units, setUnits] = useState<DashUnit[]>([]);
  const [tasks, setTasks] = useState<DashTask[]>([]);
  const [records, setRecords] = useState<DashRecord[]>([]);
  const [unlockPending, setUnlockPending] = useState<DashUnlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const db = getFirebaseDb();
        const [isnap, gsnap, usnap, tsnap, rsnap, usnap2] = await Promise.all([
          getDocs(collection(db, "indicators")),
          getDocs(collection(db, "groups")),
          getDocs(collection(db, "units")),
          getDocs(collection(db, "reviewTasks")),
          getDocs(collection(db, "reviewRecords")),
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
        // 逐件完成數
        const countMap = new Map<string, number>();
        const recs: DashRecord[] = [];
        rsnap.docs.forEach((d) => {
          const v = d.data() as Record<string, unknown>;
          const year = Number(v.year ?? 0);
          if (year < curYear - 1) return;
          const tid =
            typeof v.taskId === "string" ? v.taskId : d.id;
          countMap.set(tid, (countMap.get(tid) ?? 0) + 1);
          const ans = Array.isArray(v.answers) ? v.answers : [];
          recs.push({
            id: d.id,
            taskId: tid,
            indicatorId: String(v.indicatorId ?? ""),
            unitId: String(v.unitId ?? ""),
            year,
            month: Number(v.month ?? 0),
            reviewDate: typeof v.reviewDate === "string" ? v.reviewDate : "",
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
            rate: typeof v.rate === "number" ? v.rate : null,
            answers: (ans as Record<string, unknown>[]).map((a) => ({
              questionId: String(a.questionId ?? ""),
              itemText: String(a.itemText ?? ""),
              optionLabel: String(a.optionLabel ?? ""),
              score: Number(a.score ?? 0),
              excluded: a.excluded === true,
              note: typeof a.note === "string" ? a.note : "",
            })),
            submittedAt: v.submittedAt,
          });
        });
        const list: DashTask[] = [];
        tsnap.docs.forEach((d) => {
          const v = d.data() as Record<string, unknown>;
          const year = Number(v.year ?? 0);
          if (year < curYear - 1) return;
          list.push({
            ...parseTask(d.id, v),
            doneCount: countMap.get(d.id) ?? 0,
          });
        });
        // 狀態自動校正（v1.12.2 模式＋v1.15.0 鎖定）
        const db2 = getFirebaseDb();
        for (const t of list) {
          const right = correctTaskStatus(
            t.doneCount,
            t.caseCount,
            t.deadline,
            t.status,
          );
          if (right !== t.status) {
            t.status = right;
            const patch: Record<string, unknown> = { status: right };
            if (right === "done") patch.completedAt = serverTimestamp();
            updateDoc(doc(db2, "reviewTasks", t.id), patch).catch(() => {
              /* 下次載入再試 */
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
  };
}
