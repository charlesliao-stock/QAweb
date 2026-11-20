import { useMemo, useEffect, useCallback } from "react";
import { getFirebaseDb } from "../../../lib/firebase";
import { loadRefCollection } from "../../../lib/refLoad";
import { getDocsCacheFirst } from "../../../lib/cacheFirst";
import { collection, getDocs, query, where } from "../../../lib/db";
import type { IndicatorOpt } from "../model/types";
import { indicatorCodeOf, effectiveThreshold, normalizeQuestions } from "../../../lib/indicators";
import { type AnalysisGranularity, type AnalysisPeriodColumn, expandMonthRangeColumns, calendarYearsOf } from "../../../lib/analysisPeriod";
import { type SummaryCell as ArchiveCell, SUMMARY_SCHEMA_VERSION, isSummaryStale } from "../../../lib/reviewSummary";
import { ymKeyOf, shiftYm, pad2 } from "../../../lib/ym";
import type { AnalysisRecord } from "../../../lib/analysisRates";
import { type CachedYears, getCachedYears, setCachedYear, mergeYearDocs, invalidateCachedYears } from "../../../lib/resultsCache";
import { fetchIndicatorMonths, dbIndexedQueryApi, fetchYearDocs } from "../../../lib/indexedRecords";
import { recordDocToAnalysis } from "../../../lib/summaryStore";
import { buildTempTaskKeys } from "../../../lib/tempChartNote";
import type { useResultsState } from "./useResultsState";
import type { useResultsScope } from "./useResultsScope";

export function useResultsQuery(prev: ReturnType<typeof useResultsState> & ReturnType<typeof useResultsScope>) {
  const { tab, setTab, section, selIndG, selIndicator, selIndU, setSelfReviewTempKeys, setIndicators, setGroups, setUnits, setMetaLoaded, startMonth, endMonth, interval, applied, rawFull, scope, archiveCtx, indicators, selGroup, selGroupU, selUnit, setSearchPrompt, visibleUnitCodes, setRawHint, setRawFull, setPendingChart, archiveReady, setLoading, cacheScope, setRecords, setTasks, setIndexFallback, setIndexFallbackDismissed, setFetchedAt, reloadNonce, isNurseLeader, setInterval, now, setStartMonth, setEndMonth, setApplied, setReloadNonce, tasks, records, selfReviewTempKeys } = prev;

  /**
   * v1.28 階段 7（B7）：單一指標限縮查詢的指標。
   * - 指標分析頁籤：永遠只看一支指標（selIndicator）。
   * - 單位分析頁籤：選了特定指標（selIndU ≠ "all"）時限縮；選「全部」時不加條件。
   * - 組別分析／匯入頁籤：矩陣要看整組指標，不限縮，維持按年查詢。
   * 限縮只影響「查回哪些紀錄」，不影響權限範圍（scopedRecords 照舊過濾）。
   */
  const singleIndicatorId = useMemo(() => {
    if (tab === "indicator") return selIndicator || null;
    if (tab === "unit" && selIndU !== "all") return selIndU;
    // v1.88.33 Q3：組別模式選了特定指標時亦限縮查詢。
    if (tab === "group" && selIndG !== "all") return selIndG;
    return null;
  }, [tab, selIndicator, selIndU, selIndG]);

  // 指標／組別／單位（掛載時載入一次）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = getFirebaseDb();
        const [isnap, gsnap, usnap, ssnap] = await Promise.all([
          loadRefCollection("indicators"),
          loadRefCollection("groups"),
          loadRefCollection("units"),
          // v1.59.0：臨時排程自審旗標（曲線圖加審標註排除自審任務用）
          getDocsCacheFirst(collection(db, "indicatorSchedules")),
        ]);
        if (cancelled) return;
        const selfKeys = new Set<string>();
        ssnap.docs.forEach((d) => {
          const data = d.data() as Record<string, unknown>;
          if (
            data.category === "temp" &&
            data.selfReview === true &&
            typeof data.indicatorId === "string" &&
            typeof data.period === "string"
          ) {
            selfKeys.add(`${data.indicatorId}|${data.period}`);
          }
        });
        setSelfReviewTempKeys(selfKeys);
        const list: IndicatorOpt[] = [];
        isnap.docs.forEach((d) => {
          const data = d.data() as Record<string, unknown>;
          list.push({
            id: d.id,
            code: indicatorCodeOf(d.id),
            name:
              typeof data.name === "string" && data.name ? data.name : d.id,
            groupId: typeof data.groupId === "string" ? data.groupId : "",
            status: typeof data.status === "string" ? data.status : "",
            version: typeof data.version === "string" ? data.version : "v1.0",
            threshold: effectiveThreshold(data),
            groupScoring: data.groupScoring === true,
            auditItems: Array.isArray(data.auditItems)
              ? data.auditItems.map(String).map((x) => x.trim()).filter(Boolean)
              : [],
            questions: normalizeQuestions(data.questions).questions,
          });
        });
        list.sort((a, b) => a.code.localeCompare(b.code, "zh-Hant"));
        setIndicators(list);
        setGroups(
          gsnap.docs
            .map((d) => ({
              id: d.id,
              name:
                typeof d.data().name === "string" ? d.data().name : d.id,
            }))
            .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")),
        );
        setUnits(
          usnap.docs
            .map((d) => {
              const data = d.data();
              return {
                code: d.id,
                name: typeof data.name === "string" ? data.name : d.id,
                groupId:
                  typeof data.groupId === "string" ? data.groupId : "",
                mergedFromUnitCodes: Array.isArray(data.mergedFromUnitCodes)
                  ? data.mergedFromUnitCodes.map(String).filter(Boolean)
                  : [],
              };
            })
            .sort((a, b) => a.code.localeCompare(b.code, "zh-Hant")),
        );
      } catch {
        if (!cancelled) {
          setIndicators([]);
          setGroups([]);
          setUnits([]);
        }
      } finally {
        if (!cancelled) setMetaLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rangeValid = Boolean(startMonth && endMonth && startMonth <= endMonth);
  /**
   * v1.88.17：期間欄一律一月一欄（月／年／學年三種模式皆然），
   * 資料格的合併改由每列自己的排程區間決定（見 buildRowSpans），
   * 欄位不再由排程區間聯集產生。區間單位只影響預設起訖範圍
   * （見 handleIntervalChange），不決定欄位切法。
   */
  const buildColumns = useCallback(
    (
      s: string,
      e: string,
      _g: AnalysisGranularity,
    ): AnalysisPeriodColumn[] => expandMonthRangeColumns(s, e, "month"),
    [],
  );
  // 期間欄只取所選年月範圍內的月份，再依月／年／學年分組。
  const columns = useMemo(
    () => buildColumns(startMonth, endMonth, interval),
    [buildColumns, startMonth, endMonth, interval],
  );
  const queryYears = useMemo(() => calendarYearsOf(columns), [columns]);
  const queryLoadYears = useMemo(
    () => queryYears.length > 0
      ? [...new Set([...queryYears, Math.min(...queryYears) - 1])].sort((a, b) => a - b)
      : queryYears,
    [queryYears],
  );
  /** 已生效的期間欄：未查詢前沿用 live 值（畫面為空白頁，不渲染矩陣） */
  const appliedColumns = useMemo(
    () =>
      applied
        ? buildColumns(
            applied.startMonth,
            applied.endMonth,
            applied.interval,
          )
        : columns,
    [applied, columns, buildColumns],
  );
  const appliedYearsKey = applied ? applied.years.join(",") : "";
  const allMonths = useMemo(
    () => appliedColumns.flatMap((c) => c.months),
    [appliedColumns],
  );

  /**
   * v1.66.0：指標分析摘要模式。該指標有可用封存摘要的月份讀摘要格（每月只採
   * 一份摘要，避免重疊區間重複計），其餘月份才讀原始紀錄。審查員範圍不走摘要。
   */
  /** 本頁籤要載入的指標（審查員範圍或尚未載入封存資訊時為空＝沿用舊讀法） */
  const planTargets = useMemo<string[]>(() => {
    if (!applied || rawFull || scope.kind === "reviewer" || !archiveCtx) return [];
    if (tab === "indicator") return selIndicator ? [selIndicator] : [];
    if (tab === "group")
      return indicators
        .filter((i) => i.groupId === selGroup && (selIndG === "all" || i.id === selIndG))
        .map((i) => i.id);
    if (tab === "unit")
      return indicators
        .filter(
          (i) =>
            (selGroupU === "all" || i.groupId === selGroupU) &&
            (selIndU === "all" || i.id === selIndU),
        )
        .map((i) => i.id);
    return [];
  }, [tab, selIndicator, selGroup, selGroupU, selIndU, selIndG, applied, rawFull, scope.kind, archiveCtx, indicators]);
  const summaryPlans = useMemo(() => {
    const out = new Map<
      string,
      {
        coveredKeys: string[];
        uncovered: { year: number; month: number }[];
        archivedCells: ArchiveCell[];
        staleLabels: string[];
      }
    >();
    if (planTargets.length === 0 || !archiveCtx) return out;
    const wantedList: string[] = allMonths.map((x) => `${x.year}-${x.month}`);
    const wanted = new Set<string>(wantedList);
    for (const id of planTargets) {
      const opt = indicators.find((i) => i.id === id);
      if (!opt) continue;
      const owner = new Map<string, string>();
      const list = [...archiveCtx.summaries.values()]
        .filter((sm) => sm.indicatorId === id && sm.schemaVersion === SUMMARY_SCHEMA_VERSION)
        .sort((a, b) => a.id.localeCompare(b.id));
      for (const sm of list) {
        let cur = { year: sm.start.year, month: sm.start.month };
        while (cur.year * 12 + cur.month <= sm.end.year * 12 + sm.end.month) {
          const k = ymKeyOf(cur.year, cur.month);
          if (!owner.has(k)) owner.set(k, sm.id);
          cur = shiftYm(cur.year, cur.month, 1);
        }
      }
      const coveredKeys: string[] = wantedList.filter(
        (k, i) => wantedList.indexOf(k) === i && owner.has(k),
      );
      if (coveredKeys.length === 0) continue;
      const archivedCells: ArchiveCell[] = [];
      for (const sm of list)
        for (const c of sm.cells) {
          const k = `${c.year}-${c.month}`;
          if (!wanted.has(k) || owner.get(k) !== sm.id) continue;
          if (scope.kind === "staff" && !visibleUnitCodes.has(c.unitId)) continue;
          archivedCells.push(c);
        }
      out.set(id, {
        coveredKeys,
        uncovered: allMonths.filter((x) => !owner.has(`${x.year}-${x.month}`)),
        archivedCells,
        staleLabels: list
          .filter((sm) => isSummaryStale(sm, opt.threshold))
          .filter((sm) => [...owner.values()].includes(sm.id))
          .map(
            (sm) =>
              `${opt.name}（${sm.start.year}/${sm.start.month}~${sm.end.year}/${sm.end.month}）`,
          ),
      });
    }
    return out;
  }, [planTargets, archiveCtx, indicators, allMonths, scope.kind, visibleUnitCodes]);
  const perIndMode = summaryPlans.size > 0;
  const plansKey = useMemo(
    () =>
      perIndMode
        ? `${tab}|${planTargets.join(",")}|${[...summaryPlans]
            .map(([id, p]) => `${id}:${[...p.coveredKeys].sort().join(",")}`)
            .join(";")}`
        : "",
    [perIndMode, tab, planTargets, summaryPlans],
  );
  /** 指標分析頁用（單一指標） */
  const summaryPlan = tab === "indicator" && selIndicator ? summaryPlans.get(selIndicator) ?? null : null;
  /** 需要原始紀錄的操作（選項明細、下探、原因詞庫）：先載入全部原始紀錄，請使用者再點一次。 */
  function requireRaw(indicatorId?: string): boolean {
    if (!perIndMode) return false;
    if (indicatorId && !summaryPlans.has(indicatorId)) return false;
    setRawHint("此操作需原始紀錄，已開始載入，載入完成後自動開啟。");
    setRawFull(true);
    return true;
  }
  useEffect(() => {
    setRawFull(false);
    setRawHint("");
    setPendingChart(null);
  }, [selIndicator, selGroup, selGroupU, selIndU, applied, tab]);

  // 審查紀錄（查詢閘門＋按年份快取）：
  // 未按「查詢」不觸發（applied 為 null）；已查過的年份直接吃記憶體快取，
  // 缺的年份才按年發查詢，併回後畫面永遠從合併後的快取渲染。
  // 快取鍵含權限範圍（見 resultsCache），不同範圍不共用。
  useEffect(() => {
    // v1.88.33：頂層切到匯入／管理時不查分析紀錄（tab 只剩查詢模式）。
    if (!applied || section !== "analysis") return;
    if ((tab === "indicator" || tab === "group" || tab === "unit") && scope.kind !== "reviewer" && !archiveReady) {
      setLoading(true);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const db = getFirebaseDb();
        const years = applied.years;
        // v1.28 階段 7（B7）：單一指標限縮時改走 indicatorId＋year 複合索引
        // 查詢；索引未就緒時 fetchYearDocs 自動退回舊查詢＋前端過濾。
        const indFilter = singleIndicatorId ?? undefined;
        const perInd = summaryPlans.size > 0;
        let rlSummary: AnalysisRecord[] | null = null;
        let recCached: CachedYears<AnalysisRecord> = {
          hits: new Map(),
          missing: [],
          fetchedAt: null,
        };
        const recFresh = new Map<number, AnalysisRecord[]>();
        let fellBack = false;
        if (perInd) {
          // 摘要模式：每支指標只讀未封存月份的原始紀錄（不寫年份快取，避免半份資料被當整年）
          const jobs: Promise<Awaited<ReturnType<typeof fetchIndicatorMonths>>>[] = [];
          for (const id of planTargets) {
            const months = summaryPlans.get(id)?.uncovered ?? allMonths;
            const byYear = new Map<number, number[]>();
            for (const m of months) {
              const arr = byYear.get(m.year) ?? [];
              arr.push(m.month);
              byYear.set(m.year, arr);
            }
            for (const [y, ms] of byYear)
              jobs.push(
                fetchIndicatorMonths(dbIndexedQueryApi, collection(db, "reviewRecords"), {
                  indicatorId: id,
                  year: y,
                  months: ms,
                }),
              );
          }
          const got = await Promise.all(jobs);
          rlSummary = [];
          got.forEach((snap) => {
            if (snap.fellBack) fellBack = true;
            snap.docs.forEach((d) => {
              const v = d.data() as Record<string, unknown>;
              const rec = recordDocToAnalysis(d.id, v);
              rec.taskId = typeof v.taskId === "string" ? v.taskId : undefined;
              rlSummary!.push(rec);
            });
          });
        } else {
        recCached = getCachedYears<AnalysisRecord>(
          "reviewRecords",
          years,
          cacheScope,
          indFilter,
        );
        if (recCached.missing.length > 0) {
          const snaps = await Promise.all(
            recCached.missing.map((y) =>
              fetchYearDocs(
                dbIndexedQueryApi,
                collection(db, "reviewRecords"),
                { indicatorId: indFilter, year: y },
              ),
            ),
          );
          snaps.forEach((snap, i) => {
            if (snap.fellBack) fellBack = true;
            const y = recCached.missing[i];
            const docs: AnalysisRecord[] = [];
            snap.docs.forEach((d) => {
              const v = d.data() as Record<string, unknown>;
              const answers = Array.isArray(v.answers)
                ? v.answers.map((a) => {
                    const r = (a ?? {}) as Record<string, unknown>;
                    return {
                      questionId:
                        typeof r.questionId === "string" ? r.questionId : "",
                      itemText:
                        typeof r.itemText === "string" ? r.itemText : "",
                      optionLabel:
                        typeof r.optionLabel === "string" ? r.optionLabel : "",
                      score: typeof r.score === "number" ? r.score : 0,
                      excluded: r.excluded === true,
                      commonErrors: Array.isArray(r.commonErrors)
                        ? r.commonErrors.filter((word): word is string => typeof word === "string")
                        : [],
                      note: typeof r.note === "string" ? r.note : "",
                    };
                  })
                : [];
              docs.push({
                indicatorId: String(v.indicatorId ?? ""),
                taskId: typeof v.taskId === "string" ? v.taskId : undefined,
                unitId: String(v.unitId ?? ""),
                year: Number(v.year ?? 0),
                month: Number(v.month ?? 0),
                rate: typeof v.rate === "number" ? v.rate : null,
                thresholdAtSchedule:
                  typeof v.thresholdAtSchedule === "number" ? v.thresholdAtSchedule : undefined,
                indicatorVersion:
                  typeof v.indicatorVersionAtSchedule === "string"
                    ? v.indicatorVersionAtSchedule
                    : undefined,
                answers,
                personEmpNo: String(v.reviewedPersonEmpNo ?? ""),
                personName: String(v.reviewedPersonName ?? ""),
                bedNo: typeof v.bedNo === "string" ? v.bedNo : "",
              });
            });
            setCachedYear("reviewRecords", y, cacheScope, docs, indFilter);
            recFresh.set(y, docs);
          });
        }
        }
        const rl = rlSummary ?? mergeYearDocs(recCached.hits, recFresh);
        // v1.59.0：任務表改為全部身分皆載入（原只限審查員範圍過濾用），
        // 曲線圖加審標註需反查 reviewTasks.scheduleCategory。
        let tl: {
          id: string;
          unitId: string;
          reviewerId: string;
          indicatorId: string;
          year: number;
          month: number;
          scheduleCategory?: string;
          schedulePeriod?: string;
        }[] = [];
        let taskFetchedAt: number | null = null;
        if (perInd) {
          // 摘要模式：任務表只讀本頁籤的指標（不寫年份快取）
          const tsn = await Promise.all(
            planTargets.flatMap((id) =>
              years.map((y) =>
                fetchYearDocs(dbIndexedQueryApi, collection(db, "reviewTasks"), {
                  indicatorId: id,
                  year: y,
                }),
              ),
            ),
          );
          tsn.forEach((snap) => {
            snap.docs.forEach((d) => {
              const v = d.data() as Record<string, unknown>;
              tl.push({
                id: d.id,
                unitId: String(v.unitId ?? ""),
                reviewerId: String(v.reviewerId ?? ""),
                indicatorId: String(v.indicatorId ?? ""),
                year: Number(v.year ?? 0),
                month: Number(v.month ?? 0),
                scheduleCategory:
                  typeof v.scheduleCategory === "string" ? v.scheduleCategory : undefined,
                schedulePeriod:
                  typeof v.schedulePeriod === "string" ? v.schedulePeriod : undefined,
              });
            });
          });
        } else {
          const taskCached = getCachedYears<{
            id: string;
            unitId: string;
            reviewerId: string;
            indicatorId: string;
            year: number;
            month: number;
            scheduleCategory?: string;
            schedulePeriod?: string;
          }>("reviewTasks", years, cacheScope);
          const taskFresh = new Map<
            number,
            {
              id: string;
              unitId: string;
              reviewerId: string;
              indicatorId: string;
              year: number;
              month: number;
              scheduleCategory?: string;
              schedulePeriod?: string;
            }[]
          >();
          if (taskCached.missing.length > 0) {
            const tsnaps = await Promise.all(
              taskCached.missing.map((y) =>
                getDocs(
                  query(
                    collection(db, "reviewTasks"),
                    where("year", "==", y),
                  ),
                ),
              ),
            );
            tsnaps.forEach((snap, i) => {
              const y = taskCached.missing[i];
              const docs: {
                id: string;
                unitId: string;
                reviewerId: string;
                indicatorId: string;
                year: number;
                month: number;
                scheduleCategory?: string;
                schedulePeriod?: string;
              }[] = [];
              snap.docs.forEach((d) => {
                const v = d.data() as Record<string, unknown>;
                docs.push({
                  id: d.id,
                  unitId: String(v.unitId ?? ""),
                  reviewerId: String(v.reviewerId ?? ""),
                  indicatorId: String(v.indicatorId ?? ""),
                  year: Number(v.year ?? 0),
                  month: Number(v.month ?? 0),
                  scheduleCategory:
                    typeof v.scheduleCategory === "string"
                      ? v.scheduleCategory
                      : undefined,
                  schedulePeriod:
                    typeof v.schedulePeriod === "string"
                      ? v.schedulePeriod
                      : undefined,
                });
              });
              setCachedYear("reviewTasks", y, cacheScope, docs);
              taskFresh.set(y, docs);
            });
          }
          tl = mergeYearDocs(taskCached.hits, taskFresh);
          taskFetchedAt = taskCached.fetchedAt;
        }
        if (cancelled) return;
        setRecords(rl);
        setTasks(tl);
        if (fellBack) {
          console.warn(
            "結果分析：複合索引 (indicatorId, year) 尚未就緒，已自動退回按年查詢＋前端過濾（結果一致）。請至 Firebase Console → Firestore → 索引建立該索引，之後查詢會更快。",
          );
          setIndexFallback(true);
          setIndexFallbackDismissed(false);
        } else {
          setIndexFallback(false);
        }
        const at = Math.max(recCached.fetchedAt ?? 0, taskFetchedAt ?? 0);
        setFetchedAt(at > 0 ? at : Date.now());
      } catch {
        if (!cancelled) {
            setRecords([]);
          setTasks([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedYearsKey, reloadNonce, archiveReady, plansKey, rawFull, scope.kind, scope.kind === "reviewer" ? scope.staffId : "", scope.kind === "staff" ? scope.unitCode : "", tab, section, singleIndicatorId, isNurseLeader, visibleUnitCodes]);

  /** 每次查詢皆失效所選年份，避免再次查詢命中過期快取。 */
  /**
   * v1.88.17：區間單位下拉只影響預設起訖範圍（切換時重設起訖月份；
   * 欄位切法已與下拉脫鉤，三種模式都一月一格）。
   * 月＝今年 1 月～本月；年＝今年 1～12 月；學年＝當學年 8 月～隔年 7 月。
   */
  function handleIntervalChange(g: AnalysisGranularity) {
    setInterval(g);
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    if (g === "year") {
      setStartMonth(`${y}-01`);
      setEndMonth(`${y}-12`);
    } else if (g === "academic") {
      const startYear = m >= 8 ? y : y - 1;
      setStartMonth(`${startYear}-08`);
      setEndMonth(`${startYear + 1}-07`);
    } else {
      setStartMonth(`${y}-01`);
      setEndMonth(`${y}-${pad2(m)}`);
    }
  }
  /**
   * 檢視由篩選器決定（不再有組別／單位／指標模式標籤）：
   * 指標有選 → 單一指標分析；未選指標、單位有選 → 單位分析；
   * 未選指標與單位、品管組有選 → 品管組分析。
   * 複合篩選維持交集，優先順序指標＞單位＞品管組。
   */
  function resolveView(): "group" | "unit" | "indicator" | null {
    if (selIndicator) return "indicator";
    if (selUnit) return "unit";
    if (selGroup) return "group";
    return null;
  }
  function handleQuery() {
    if (!rangeValid || section !== "analysis") return;
    const view = resolveView();
    if (!view) {
      setSearchPrompt("請先選擇品管組、單位或指標其中之一，再按「搜尋」。");
      return;
    }
    setSearchPrompt("");
    setTab(view);
    invalidateCachedYears("reviewRecords", queryLoadYears, cacheScope);
    invalidateCachedYears("reviewTasks", queryLoadYears, cacheScope);
    setApplied({ years: queryLoadYears, startMonth, endMonth, interval });
    setReloadNonce((n) => n + 1);
  }
  // 範圍內紀錄（依權限範圍過濾）
  // v1.88.4：reviewer 分支保留，但與靜態範圍（dataScope）取聯集——
  // 審查員除了自己負責任務的單位，也看得到其他身分放寬的單位。
  const reviewerTaskUnitCodes = useMemo(() => {
    if (scope.kind !== "reviewer") return new Set<string>();
    return new Set(
      tasks.filter((t) => t.reviewerId === scope.staffId).map((t) => t.unitId),
    );
  }, [tasks, scope]);

  const scopedRecords = useMemo(() => {
    if (scope.kind === "admin") return records;
    if (scope.kind === "staff")
      return records.filter((r) => visibleUnitCodes.has(r.unitId));
    return records.filter(
      (r) =>
        reviewerTaskUnitCodes.has(r.unitId) || visibleUnitCodes.has(r.unitId),
    );
  }, [records, tasks, scope, visibleUnitCodes, reviewerTaskUnitCodes]);

  /**
   * v1.59.0：加審任務月鍵集合（曲線圖標註反查用）。
   * 任務表以查詢年份載入（全部身分）；自審任務以 indicatorSchedules
   * 的 selfReview 排除。注意：任務不分權限範圍載入，標註只看任務
   * 存在與否，實際顯示的紀錄仍受 scopedRecords 權限過濾。
   */
  const tempTaskKeys = useMemo(
    () => buildTempTaskKeys(tasks, selfReviewTempKeys),
    [tasks, selfReviewTempKeys],
  );
  const tempTaskIds = useMemo(
    () => new Set(tasks.filter((task) =>
      task.scheduleCategory === "temp" &&
      !(task.schedulePeriod && selfReviewTempKeys.has(`${task.indicatorId}|${task.schedulePeriod}`)),
    ).map((task) => task.id)),
    [tasks, selfReviewTempKeys],
  );

  return {
    tempTaskIds,
    tempTaskKeys,
    appliedColumns,
    scopedRecords,
    allMonths,
    reviewerTaskUnitCodes,
    summaryPlans,
    requireRaw,
    perIndMode,
    summaryPlan,
    handleIntervalChange,
    handleQuery,
    rangeValid,
  };
}
