import { useEffect, useCallback } from "react";
import { getCachedRef, SYSTEM_CONFIG_KEY } from "../../../lib/refCache";
import { getDocCacheFirst } from "../../../lib/cacheFirst";
import { doc, getDocs, collection, query, where } from "../../../lib/db";
import { getFirebaseDb } from "../../../lib/firebase";
import { loadRefCollection } from "../../../lib/refLoad";
import { indicatorCodeOf } from "../../../lib/indicators";
import { listSchedules, type IndicatorAssignment, type AssignmentItem, normalizeAssignmentItem } from "../../../lib/scheduling";
import { isReviewerAccessActive } from "../../../lib/reviewerValidity";
import type { ReviewerLite } from "../model/types";
import { toErrorMessage } from "../../../lib/errors";
import { buildTaskIndex, buildTaskUnitIndex } from "../../../lib/taskIndex";
import type { SchedulePageProps } from "../model/pageProps";
import type { useScheduleState } from "./useScheduleState";
import type { useScheduleScope } from "./useScheduleScope";

export function useScheduleData(props: SchedulePageProps, prev: ReturnType<typeof useScheduleState> & ReturnType<typeof useScheduleScope>) {
  const { onAction } = props;
  const { setStatsCycle, setDeadlineDay, setGroupMap, setIndicators, setQueried, setLoading, setSchedules, setAssignments, setUnits, setUsers, setReviewersByGroup, setTaskReloadTick, queried, filterYear, setTaskIndex, setTaskUnitIndex, taskReloadTick } = prev;

  // 系統參數：統計週期（年別篩選鎖定用；設定改了這裡跟著變）＋補審截止日（產生任務用）
  useEffect(() => {
    (async () => {
      try {
        const snap = await getCachedRef(SYSTEM_CONFIG_KEY, () =>
          getDocCacheFirst(doc(getFirebaseDb(), "systemParams", "config")),
        );
        const data = snap.data() as Record<string, unknown> | undefined;
        setStatsCycle(data?.statsCycle === "academic" ? "academic" : "year");
        const dd = data?.supplementDeadlineDay;
        if (typeof dd === "number" && dd >= 1 && dd <= 31) setDeadlineDay(dd);
      } catch {
        /* 讀不到就用預設值 */
      }
    })();
  }, []);

  // 篩選下拉用的輕量參考資料（走 refCache，不另計費）；排程本體須按「查詢」才載入
  const applyRefs = useCallback(
    (
      isnap: Awaited<ReturnType<typeof loadRefCollection>>,
      gsnap: Awaited<ReturnType<typeof loadRefCollection>>,
    ) => {
      const gm = new Map<string, string>();
      gsnap.docs.forEach((d) => {
        const name = d.data().name;
        if (typeof name === "string") gm.set(d.id, name);
      });
      setGroupMap(gm);
      setIndicators(
        isnap.docs
          .map((d) => {
            const data = d.data();
            return {
              id: d.id,
              code: indicatorCodeOf(d.id),
              name: typeof data.name === "string" ? data.name : "",
              groupId: typeof data.groupId === "string" ? data.groupId : "",
              status: typeof data.status === "string" ? data.status : "",
            };
          })
          .sort((a, b) => a.id.localeCompare(b.id, "zh-Hant")),
      );
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [isnap, gsnap] = await Promise.all([
          loadRefCollection("indicators"),
          loadRefCollection("groups"),
        ]);
        if (!cancelled) applyRefs(isnap, gsnap);
      } catch {
        /* 下拉選項讀不到時留空，按查詢仍會完整載入 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyRefs]);

  const loadData = useCallback(async () => {
    setQueried(true);
    setLoading(true);
    try {
      const db = getFirebaseDb();
      const [isnap, gsnap, asnap, usnap, unsnap, rsnap, scheds] =
        await Promise.all([
          loadRefCollection("indicators"),
          loadRefCollection("groups"),
          getDocs(collection(db, "indicatorAssignments")),
          loadRefCollection("units"),
          loadRefCollection("users"),
          getDocs(collection(db, "reviewReviewers")),
          listSchedules(db),
        ]);

      applyRefs(isnap, gsnap);
      setSchedules(scheds);

      const am = new Map<string, IndicatorAssignment>();
      asnap.docs.forEach((d) => {
        const data = d.data();
        const items: AssignmentItem[] = Array.isArray(data.items)
          ? data.items
              .map(normalizeAssignmentItem)
              .filter((it): it is AssignmentItem => it !== null)
          : [];
        const indicatorId =
          typeof data.indicatorId === "string" ? data.indicatorId : d.id;
        am.set(indicatorId, { indicatorId, items, updatedAt: data.updatedAt });
      });
      setAssignments(am);

      setUnits(
        usnap.docs
          .map((d) => {
            const data = d.data();
            return {
              code: d.id,
              name: typeof data.name === "string" ? data.name : d.id,
              groupId: typeof data.groupId === "string" ? data.groupId : "",
              mergedFromUnitCodes: Array.isArray(data.mergedFromUnitCodes)
                ? data.mergedFromUnitCodes.map(String).filter(Boolean)
                : [],
            };
          })
          .sort((a, b) => a.code.localeCompare(b.code, "zh-Hant")),
      );

      setUsers(
        unsnap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            name: typeof data.name === "string" ? data.name : d.id,
            unitCode: typeof data.unitCode === "string" ? data.unitCode : "",
            status: typeof data.status === "string" ? data.status : "在職",
            reviewerAccessActive: isReviewerAccessActive(data.reviewerAccessExpiresAt),
            activated: typeof data.activatedAt === "string" && data.activatedAt !== "",
            roles: Array.isArray(data.roles) ? data.roles.map(String) : [],
          };
        }),
      );

      const um = new Map<string, string>();
      unsnap.docs.forEach((d) => {
        const name = d.data().name;
        um.set(d.id, typeof name === "string" ? name : d.id);
      });
      const rbm = new Map<string, ReviewerLite[]>();
      const activeReviewerIds = new Set(
        unsnap.docs
          .filter((person) => isReviewerAccessActive(person.data().reviewerAccessExpiresAt))
          .map((person) => person.id),
      );
      rsnap.docs.forEach((d) => {
        const data = d.data();
        const groupId = typeof data.groupId === "string" ? data.groupId : "";
        const personId = typeof data.personId === "string" ? data.personId : "";
        if (!groupId || !personId || !activeReviewerIds.has(personId)) return;
        const arr = rbm.get(groupId) ?? [];
        arr.push({ personId, name: um.get(personId) ?? personId });
        rbm.set(groupId, arr);
      });
      rbm.forEach((arr) =>
        arr.sort((a, b) => a.personId.localeCompare(b.personId, "zh-Hant")),
      );
      setReviewersByGroup(rbm);

      // 任務索引改由 loadTaskIndex 依檢視年度讀取；操作後重載時一併刷新。
      setTaskReloadTick((t) => t + 1);
    } catch (error) {
      onAction(`讀取排程資料失敗：${toErrorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, [onAction, applyRefs]);

  // 任務索引（v1.28 階段 6 B5 起）：前端按 indicatorId 分組取代 N+1 查詢。
  // 只讀「檢視年度」的任務（年度＝該年；學年度 8 月～隔年 7 月，故讀 Y 與 Y+1 兩個
  // 日曆年），不再整個集合全掃。year 單欄位 in 查詢，免複合索引。
  // 臨時排程若屬其他年度，切換到該年度檢視時才會有任務數。
  useEffect(() => {
    if (!queried) return;
    let cancelled = false;
    (async () => {
      try {
        const db = getFirebaseDb();
        const tsnap = await getDocs(
          query(
            collection(db, "reviewTasks"),
            where("year", "in", [filterYear, filterYear + 1]),
          ),
        );
        if (cancelled) return;
        setTaskIndex(
          buildTaskIndex(
            tsnap.docs as unknown as Array<{
              data: () => Record<string, unknown>;
            }>,
          ),
        );
        // v1.88.5：同一批文件多建單位維度索引（不另讀取），供單位排程者計數。
        setTaskUnitIndex(
          buildTaskUnitIndex(
            tsnap.docs as unknown as Array<{
              data: () => Record<string, unknown>;
            }>,
          ),
        );
      } catch {
        /* 任務索引讀取失敗：索引留空，任務數顯示為 0，不影響其他資料 */
        if (!cancelled) setTaskIndex(new Map());
        if (!cancelled) setTaskUnitIndex(new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filterYear, taskReloadTick, queried]);

  return {
    loadData,
  };
}
