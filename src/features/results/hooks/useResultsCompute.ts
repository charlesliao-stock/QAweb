import type { AnalysisPeriodColumn, CalendarMonth } from "../../../lib/analysisPeriod";
import { recordsForIndex, buildRecordIndex, columnRecordCount } from "../../../lib/resultsMatrix";
import { columnTempNote } from "../../../lib/tempChartNote";
import { fmtYm } from "../../../lib/ym";
import { type ScheduleSpanGroup, scheduleIntervalsInRange, groupSchedulesForRows, type RowSpan, buildRowSpans } from "../../../lib/analysisSpans";
import { scheduleDocId } from "../../../lib/scheduling";
import type { IndicatorOpt, UnitMode, MatrixRow, CellValue } from "../model/types";
import { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { recordsInMonths, type AnalysisRecord, unitPassRate, passRateOf, type PassRate, unitScoringBreakdownRows, personScoringBreakdownRows, columnThresholdOf, formatPassRate, resolveDrillSection, sectionPassRateOf, type OptionDetailRow } from "../../../lib/analysisRates";
import { getFirebaseDb } from "../../../lib/firebase";
import { recordDocToAnalysis } from "../../../lib/summaryStore";
import { fetchIndicatorMonths, dbIndexedQueryApi, fetchYearDocs } from "../../../lib/indexedRecords";
import { collection } from "../../../lib/db";
import { type SummaryCell as ArchiveCell, buildReviewSummary, cellsInMonths, unitPassRateFromCells, passRateFromCells, unitScoringRowsFromCells, personScoringRowsFromCells, columnThresholdFromCells } from "../../../lib/reviewSummary";
import type { CapaCase } from "../../capa/model";
import { loadCapaCasesByUnit, loadCapaCasesByIndicator } from "../../capa/store";
import { unarchivedOverdue } from "../../../lib/archiveReminder";
import type { AuditQuestion } from "../../../lib/indicators";
import type { useResultsState } from "./useResultsState";
import type { useResultsScope } from "./useResultsScope";
import type { useResultsQuery } from "./useResultsQuery";

export function useResultsCompute(prev: ReturnType<typeof useResultsState> & ReturnType<typeof useResultsScope> & ReturnType<typeof useResultsQuery>) {
  const { tempTaskIds, tempTaskKeys, appliedColumns, archiveCtx, scopedRecords, allMonths, records, scope, visibleUnitCodes, reviewerTaskUnitCodes, tasks, summaryPlans, indicators, units, selUnit, tab, applied, errorUnit, selIndicator, groups, user, selGroup, setSelGroup, selGroup2, setSelGroup2, setSelUnit, setSelIndicator, selGroupU, selIndU, setSelGroupU, setSelIndU, hideEmptyMonths, unitUnit, groupUnit, startMonth, endMonth, interval } = prev;

  const hasTempReview = (
    indicatorId: string,
    col: AnalysisPeriodColumn,
    unitId?: string,
  ) => {
    const hcs = cellsOfInd(indicatorId, col.months, unitId);
    if (hcs) {
      const extra = recordsForIndex(recordIndex, indicatorId, col.months, unitId);
      return (
        extra.some((record) => Boolean(record.taskId && tempTaskIds.has(record.taskId))) ||
        columnTempNote(pseudoRecs(indicatorId, hcs), tempTaskKeys, col.months.length) != null
      );
    }
    const periodRecords = recordsForIndex(recordIndex, indicatorId, col.months, unitId);
    return periodRecords.some((record) => Boolean(record.taskId && tempTaskIds.has(record.taskId))) ||
      columnTempNote(periodRecords, tempTaskKeys, col.months.length) != null;
  };


  /** 該指標在指定月份內有加審紀錄的月份鍵集合（原始紀錄 taskId 或封存摘要反查任務鍵）。 */
  function tempMonthKeysOf(
    indicatorId: string,
    months: CalendarMonth[],
    unitId: string | undefined,
  ): Set<string> {
    const keys = new Set<string>();
    for (const m of months) {
      const col: AnalysisPeriodColumn = {
        key: `${m.year}-${m.month}`,
        label: fmtYm(m.year, m.month),
        months: [m],
      };
      if (hasTempReview(indicatorId, col, unitId)) keys.add(`${m.year}-${m.month}`);
    }
    return keys;
  }

  /**
   * 該指標的非臨時排程分組（區間已裁切到 applied 範圍；重疊排程分組，
   * 見 groupSchedulesForRows）。無排程／範圍內無區間時回一組空區間（全單月格）。
   */
  function scheduleGroupsOf(indicatorId: string): ScheduleSpanGroup[] {
    const rangeMonths = appliedColumns.flatMap((c) => c.months);
    const inputs = (archiveCtx?.schedules ?? [])
      .filter((sc) => sc.category !== "temp" && sc.indicatorId === indicatorId)
      .map((sc) => ({
        key: scheduleDocId(sc.indicatorId, sc.category, sc.period),
        periodLabel: sc.periodLabel,
        intervals: scheduleIntervalsInRange(sc, rangeMonths),
      }))
      .filter((g) => g.intervals.length > 0);
    const groups = groupSchedulesForRows(inputs);
    return groups.length > 0
      ? groups
      : [{ key: "__none__", periodLabels: [], intervals: [] }];
  }

  /**
   * 該指標在指定月份範圍、指定單位範圍內的 spans（全部排程聯集；
   * 重疊區間以起始月較早者優先，僅為防禦性 fallback——矩陣列應走
   * buildMatrixRows 的分組 spans）。指標分析曲線圖／openChart 備援用。
   */
  function spansForIndicator(
    indicatorId: string,
    months: CalendarMonth[],
    unitId: string | undefined,
  ): RowSpan[] {
    const groups = scheduleGroupsOf(indicatorId);
    const intervals = groups.flatMap((g) => g.intervals);
    return buildRowSpans(
      months,
      intervals,
      tempMonthKeysOf(indicatorId, months, unitId),
    );
  }

  /**
   * CAPA 偵測用 spans（v1.88.18）：一個排程區間算一次審查；
   * 加審月份不切出、歸併原區間（不另算一期）。與 spansForIndicator 的差別
   * 只在 tempMonthKeys 傳空集合；分列排程仍走聯集（防禦性 fallback，
   * 指標層級偵測用，矩陣列仍走 buildMatrixRows 的分組 spans）。
   */
  function capaSpansForIndicator(
    indicatorId: string,
    months: CalendarMonth[],
  ): RowSpan[] {
    const groups = scheduleGroupsOf(indicatorId);
    const intervals = groups.flatMap((g) => g.intervals);
    return buildRowSpans(months, intervals, new Set());
  }

  /** 建矩陣列：每支指標依排程分組分列（重疊才分列，否則一列）；每列 spans＋分組明細列。 */
  function buildMatrixRows(
    inds: IndicatorOpt[],
    months: CalendarMonth[],
    unitId: string | undefined,
    mode: UnitMode,
    withDetails: boolean,
  ): MatrixRow[] {
    const rows: MatrixRow[] = [];
    for (const ind of inds) {
      const groups = scheduleGroupsOf(ind.id);
      for (const group of groups) {
        const spans = buildRowSpans(
          months,
          group.intervals,
          tempMonthKeysOf(ind.id, months, unitId),
        );
        const split = groups.length > 1;
        rows.push({
          id: split ? `${ind.id}__${group.key}` : ind.id,
          indicatorId: ind.id,
          label: split
            ? `${ind.code}・${ind.name}（${group.periodLabels.join("、")}）`
            : `${ind.code}・${ind.name}`,
          spans,
          details: withDetails
            ? matrixScoringDetails(ind, spans, unitId, mode)
            : [],
        });
      }
    }
    return rows;
  }

  const causeCountRows = useMemo(() => {    const counts = new Map<string, number>();
    for (const record of recordsInMonths(scopedRecords, allMonths)) {
      for (const answer of record.answers) {
        for (const word of new Set(answer.commonErrors ?? [])) {
          const cause = word.trim();
          if (cause) counts.set(cause, (counts.get(cause) ?? 0) + 1);
        }
      }
    }
    return [...counts.entries()]
      .map(([cause, count]) => ({ cause, count }))
      .sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause, "zh-Hant"));
  }, [scopedRecords, allMonths]);

  /**
   * v1.28 階段 7（A3）：矩陣索引——進資料時預建一次
   * Map<指標, Map<曆年月, 紀錄[]>>，cellValue／曲線／明細／下探改查表，
   * 不再每格對全部 scopedRecords 做 filter。
   */
  // v1.73.0：「顯示近 N 次」補讀的歷史月份紀錄（已封存或超出查詢年份者）；
  // 套用同一權限範圍後併入 recordIndex，換查詢條件（records 變動）即清空。
  const [historyExtra, setHistoryExtra] = useState<AnalysisRecord[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyNote, setHistoryNote] = useState("");
  const historyFetched = useRef<Set<string>>(new Set());
  useEffect(() => {
    historyFetched.current = new Set();
    setHistoryExtra([]);
    setHistoryNote("");
  }, [records]);
  const scopedHistory = useMemo(() => {
    if (historyExtra.length === 0) return historyExtra;
    if (scope.kind === "admin") return historyExtra;
    if (scope.kind === "staff")
      return historyExtra.filter((r) => visibleUnitCodes.has(r.unitId));
    return historyExtra.filter(
      (r) =>
        reviewerTaskUnitCodes.has(r.unitId) || visibleUnitCodes.has(r.unitId),
    );
  }, [historyExtra, tasks, scope, visibleUnitCodes, reviewerTaskUnitCodes]);
  const recordIndex = useMemo(
    () => buildRecordIndex(scopedHistory.length > 0 ? [...scopedRecords, ...scopedHistory] : scopedRecords),
    [scopedRecords, scopedHistory],
  );
  const recordIndexRef = useRef(recordIndex);
  recordIndexRef.current = recordIndex;
  const archiveCtxRef = useRef(archiveCtx);
  archiveCtxRef.current = archiveCtx;
  /**
   * 「顯示近 N 次」：找出選定期間之前、該指標有資料的前 N 個月（原始紀錄已載入，或封存摘要
   * 有該月），缺原始紀錄的月份只對該月補讀；不足 N 個月再逐年往前補讀（最多 3 年）。
   */
  const ensureHistory = useCallback(async (indicatorId: string, beforeKey: number, n: number): Promise<void> => {
    setHistoryBusy(true);
    setHistoryNote("");
    try {
      const db = getFirebaseDb();
      const added: AnalysisRecord[] = [];
      const toAnalysis = (d: { id: string; data: () => unknown }) => {
        const v = d.data() as Record<string, unknown>;
        const rec = recordDocToAnalysis(d.id, v);
        rec.taskId = typeof v.taskId === "string" ? v.taskId : undefined;
        return rec;
      };
      const knownKeys = () => {
        const keys = new Set<number>(recordIndexRef.current.get(indicatorId)?.keys() ?? []);
        for (const k of historyFetched.current) {
          const [ind, ym] = k.split("|");
          if (ind === indicatorId && ym.includes("-")) {
            const [y, m] = ym.split("-").map(Number);
            keys.add(y * 100 + m);
          }
        }
        for (const sm of archiveCtxRef.current?.summaries.values() ?? []) {
          if (sm.indicatorId !== indicatorId) continue;
          for (const c of sm.cells) if (c.total > 0) keys.add(c.year * 100 + c.month);
        }
        return keys;
      };
      for (let round = 0; round < 4; round++) {
        const target = [...knownKeys()].filter((k) => k < beforeKey).sort((a, b) => b - a).slice(0, n);
        const rawKeys = new Set<number>(recordIndexRef.current.get(indicatorId)?.keys() ?? []);
        const need = target.filter((k) => {
          if (rawKeys.has(k)) return false;
          return !historyFetched.current.has(`${indicatorId}|${Math.floor(k / 100)}-${k % 100}`);
        });
        if (need.length > 0) {
          const byYear = new Map<number, number[]>();
          for (const k of need) {
            const y = Math.floor(k / 100);
            byYear.set(y, [...(byYear.get(y) ?? []), k % 100]);
          }
          const got = await Promise.all(
            [...byYear].map(([year, months]) =>
              fetchIndicatorMonths(dbIndexedQueryApi, collection(db, "reviewRecords"), { indicatorId, year, months }),
            ),
          );
          got.forEach((snap, i) => {
            const year = [...byYear.keys()][i];
            for (const m of byYear.get(year) ?? []) historyFetched.current.add(`${indicatorId}|${year}-${m}`);
            snap.docs.forEach((d) => added.push(toAnalysis(d)));
          });
          if (added.length > 0) {
            const batch = [...added];
            added.length = 0;
            setHistoryExtra((prev) => [...prev, ...batch]);
          }
          continue;
        }
        if (target.length >= n) break;
        // 已知月份不足 N 個：再往前補讀一年（該指標整年）
        const earliest = Math.min(beforeKey, ...[...knownKeys()]);
        const y = Math.floor(earliest / 100) - 1;
        const yk = `${indicatorId}|${y}`;
        if (round >= 3 || historyFetched.current.has(yk)) break;
        historyFetched.current.add(yk);
        const snap = await fetchYearDocs(dbIndexedQueryApi, collection(db, "reviewRecords"), { indicatorId, year: y });
        const batch: AnalysisRecord[] = [];
        snap.docs.forEach((d) => {
          const rec = toAnalysis(d);
          const mk = `${indicatorId}|${rec.year}-${rec.month}`;
          if (historyFetched.current.has(mk) || recordIndexRef.current.get(indicatorId)?.has(rec.year * 100 + rec.month)) return;
          batch.push(rec);
        });
        for (const r of batch) historyFetched.current.add(`${indicatorId}|${r.year}-${r.month}`);
        if (batch.length === 0) break;
        setHistoryExtra((prev) => [...prev, ...batch]);
      }
      const finalTarget = [...knownKeys()].filter((k) => k < beforeKey).length;
      if (finalTarget < n) setHistoryNote(`該指標在此之前只找到 ${finalTarget} 次審查資料。`);
    } catch {
      setHistoryNote("歷史月份讀取失敗（可能是系統用量額度已滿），稍後再試。");
    } finally {
      setHistoryBusy(false);
    }
  }, []);

  /**
   * 下探 L2（再下探）才讀原始紀錄：對尚無原始紀錄的指標月份補讀一次並快取，
   * 同指標同月份再點別的單位不再讀取。L1（各單位結果）一律優先用封存摘要，不走這裡。
   */
  const ensureMonths = useCallback(async (indicatorId: string, months: { year: number; month: number }[]): Promise<void> => {
    const have = recordIndexRef.current.get(indicatorId);
    const need = months.filter(
      ({ year, month }) =>
        !(have?.get(year * 100 + month)?.length) &&
        !historyFetched.current.has(`${indicatorId}|${year}-${month}`),
    );
    if (need.length === 0) return;
    setHistoryBusy(true);
    setHistoryNote("");
    try {
      const db = getFirebaseDb();
      const byYear = new Map<number, number[]>();
      for (const { year, month } of need) byYear.set(year, [...(byYear.get(year) ?? []), month]);
      const years = [...byYear.keys()];
      const got = await Promise.all(
        years.map((year) =>
          fetchIndicatorMonths(dbIndexedQueryApi, collection(db, "reviewRecords"), {
            indicatorId,
            year,
            months: byYear.get(year) ?? [],
          }),
        ),
      );
      const batch: AnalysisRecord[] = [];
      got.forEach((snap, i) => {
        for (const m of byYear.get(years[i]) ?? []) historyFetched.current.add(`${indicatorId}|${years[i]}-${m}`);
        snap.docs.forEach((d) => {
          const v = d.data() as Record<string, unknown>;
          const rec = recordDocToAnalysis(d.id, v);
          rec.taskId = typeof v.taskId === "string" ? v.taskId : undefined;
          batch.push(rec);
        });
      });
      if (batch.length > 0) setHistoryExtra((prev) => [...prev, ...batch]);
    } catch {
      setHistoryNote("原始紀錄讀取失敗（可能是系統用量額度已滿），稍後再試。");
    } finally {
      setHistoryBusy(false);
    }
  }, []);

  /** v1.66.0：有封存摘要的指標＝已封存月份的摘要格＋其餘月份原始紀錄現算的格 */
  const hybridByInd = useMemo(() => {
    const out = new Map<string, ArchiveCell[]>();
    for (const [id, plan] of summaryPlans) {
      const opt = indicators.find((i) => i.id === id);
      if (!opt) continue;
      const rawCells = buildReviewSummary({
        indicatorId: id,
        scheduleCategory: "",
        schedulePeriod: "",
        start: { year: 0, month: 0 },
        end: { year: 0, month: 0 },
        records: recordsForIndex(recordIndex, id, allMonths),
        questions: opt.questions,
        threshold: opt.threshold,
      }).cells;
      out.set(id, [...plan.archivedCells, ...rawCells]);
    }
    return out;
  }, [summaryPlans, indicators, recordIndex, allMonths]);
  /** 指定指標（摘要模式）在期間欄／單位內的格；非摘要指標回 null */
  function cellsOfInd(
    indicatorId: string,
    months: { year: number; month: number }[],
    unitId?: string,
  ): ArchiveCell[] | null {
    const hc = hybridByInd.get(indicatorId);
    if (!hc) return null;
    const cs = cellsInMonths(hc, months);
    return unitId === undefined ? cs : cs.filter((c) => c.unitId === unitId);
  }
  const pseudoRecs = (indicatorId: string, cs: ArchiveCell[]) =>
    cs.map((c) => ({ indicatorId, year: c.year, month: c.month, unitId: c.unitId }));

  const scopedUnitCodes = useMemo(() => {
    if (scope.kind === "admin") return new Set(units.map((u) => u.code));
    if (scope.kind === "staff") return visibleUnitCodes;
    return new Set([...reviewerTaskUnitCodes, ...visibleUnitCodes]);
  }, [units, tasks, scope, visibleUnitCodes, reviewerTaskUnitCodes]);

  const scopedUnits = useMemo(
    () => units.filter((u) => scopedUnitCodes.has(u.code)),
    [units, scopedUnitCodes],
  );

  /** v1.51.0：不限單位選項值（紀錄／任務的 unitId 為 ""，顯示為 NA） */
  const NA_UNIT = "NA";
  const selUnitCode = selUnit === NA_UNIT ? "" : selUnit;
  // 單位分析：該單位的 CAPA 案件（單位條件一次查詢），供「C」標記使用
  const [unitCapaCases, setUnitCapaCases] = useState<CapaCase[]>([]);
  useEffect(() => {
    if (tab !== "unit" || !applied || !selUnitCode) {
      setUnitCapaCases([]);
      return;
    }
    let alive = true;
    loadCapaCasesByUnit(selUnitCode)
      .then((rows) => { if (alive) setUnitCapaCases(rows); })
      .catch(() => { if (alive) setUnitCapaCases([]); });
    return () => { alive = false; };
  }, [tab, applied, selUnitCode]);
  const errorUnitCode = errorUnit === NA_UNIT ? "" : errorUnit;
  // v1.88.14：指標頁籤曲線圖的 CAPA 案件（依指標一次查詢），供「C」標記使用；
  // 沿用單位圖的接線寫法（每欄只取第一件未撤案且落在該欄月份內的案件）。
  const [indCapaCases, setIndCapaCases] = useState<CapaCase[]>([]);
  useEffect(() => {
    if (tab !== "indicator" || !applied || !selIndicator) {
      setIndCapaCases([]);
      return;
    }
    let alive = true;
    loadCapaCasesByIndicator(selIndicator)
      .then((rows) => { if (alive) setIndCapaCases(rows); })
      .catch(() => { if (alive) setIndCapaCases([]); });
    return () => { alive = false; };
  }, [tab, applied, selIndicator]);
  const hasNaUnit = useMemo(
    () =>
      scopedRecords.some((r) => r.unitId === "") ||
      tasks.some((t) => t.unitId === ""),
    [scopedRecords, tasks],
  );

  const scopedGroups = useMemo(() => {
    if (scope.kind === "admin") return groups;
    const gids = new Set(scopedUnits.map((u) => u.groupId).filter(Boolean));
    const list = groups.filter((g) => gids.has(g.id));
    return list.length > 0 ? list : groups;
  }, [groups, scopedUnits, scope]);

  /**
   * v1.88.4：使用者所屬單位尚未歸屬品管組時，組別頁籤顯示明確提示而非「無指標」。
   * 條件：staff 範圍、本人單位在 units 上存在但 groupId 為空、且可見單位中
   * 沒有任何已歸組者（否則組別頁籤仍有可看的組別，不顯示此提示）。
   */
  const ownUnitUngrouped = useMemo(() => {
    if (!user?.unitCode || scope.kind !== "staff") return false;
    const own = units.find((u) => u.code === user.unitCode);
    if (!own || own.groupId) return false;
    return scopedUnits.every((u) => !u.groupId);
  }, [user?.unitCode, scope.kind, units, scopedUnits]);

  // 選項預設（資料載入後補）
  useEffect(() => {
    if (scopedGroups.length > 0 && !scopedGroups.some((g) => g.id === selGroup))
      setSelGroup(scopedGroups[0].id);
  }, [scopedGroups, selGroup]);
  useEffect(() => {
    if (scopedGroups.length > 0 && !scopedGroups.some((g) => g.id === selGroup2))
      setSelGroup2(scopedGroups[0].id);
  }, [scopedGroups, selGroup2]);
  useEffect(() => {
    if (
      scopedUnits.length > 0 &&
      selUnit !== NA_UNIT &&
      !scopedUnits.some((u) => u.code === selUnit)
    )
      setSelUnit(scopedUnits[0].code);
    else if (selUnit === NA_UNIT && !hasNaUnit)
      setSelUnit(scopedUnits[0]?.code ?? "");
  }, [scopedUnits, selUnit, hasNaUnit]);

  const indOf = useMemo(
    () => new Map(indicators.map((i) => [i.id, i])),
    [indicators],
  );
  const unitNameOf = useMemo(
    () => new Map(units.map((u) => [u.code, u.name])),
    [units],
  );
  const groupNameOf = useMemo(
    () => new Map(groups.map((g) => [g.id, g.name])),
    [groups],
  );

  const groupIndicators = useMemo(
    () => indicators.filter((i) => i.groupId === selGroup),
    [indicators, selGroup],
  );
  const indTabIndicators = useMemo(
    () => indicators.filter((i) => i.groupId === selGroup2),
    [indicators, selGroup2],
  );
  useEffect(() => {
    if (
      indTabIndicators.length > 0 &&
      !indTabIndicators.some((i) => i.id === selIndicator)
    )
      setSelIndicator(indTabIndicators[0].id);
  }, [indTabIndicators, selIndicator]);

  // 單位分析：該單位在所選期間審查過的指標（依編號排序，再經組別／指標過濾）
  const unitIndicatorsBase = useMemo(() => {
    const periodRecs = recordsInMonths(
      scopedRecords.filter((r) => r.unitId === selUnitCode),
      allMonths,
    );
    const idSet = new Set<string>(periodRecs.map((r) => r.indicatorId));
    for (const [id, plan] of summaryPlans)
      if (plan.archivedCells.some((c) => c.unitId === selUnitCode)) idSet.add(id);
    const ids = [...idSet];
    return ids
      .map((id) => indOf.get(id))
      .filter((i): i is IndicatorOpt => i != null)
      .sort((a, b) => a.code.localeCompare(b.code, "zh-Hant"));
  }, [scopedRecords, selUnitCode, allMonths, indOf, summaryPlans]);
  const unitIndicators = useMemo(
    () =>
      unitIndicatorsBase.filter(
        (i) =>
          (selGroupU === "all" || i.groupId === selGroupU) &&
          (selIndU === "all" || i.id === selIndU),
      ),
    [unitIndicatorsBase, selGroupU, selIndU],
  );
  // 單位分析指標下拉選項（依組別過濾＋全部）
  const unitIndOptions = useMemo(
    () =>
      unitIndicatorsBase.filter(
        (i) => selGroupU === "all" || i.groupId === selGroupU,
      ),
    [unitIndicatorsBase, selGroupU],
  );
  // 單位分析組別預設第一個組別；組別變動時指標重設為全部
  useEffect(() => {
    if (scopedGroups.length > 0 && !scopedGroups.some((g) => g.id === selGroupU) && selGroupU !== "all")
      setSelGroupU(scopedGroups[0].id);
  }, [scopedGroups, selGroupU]);
  useEffect(() => {
    if (selIndU !== "all" && !unitIndOptions.some((i) => i.id === selIndU))
      setSelIndU("all");
  }, [unitIndOptions, selIndU]);

  /**
   * v1.40.2「未審月份不顯示」：勾選時隱藏無資料的期間。
   * v1.88.17：改為「隱藏整段無資料區間」——隱藏單位是每列的合併格（span），
   * 不是單月欄：某月只有在「所有列包含它的 span 都無紀錄」時才隱藏，
   * 有紀錄的 span 內的無資料月份仍顯示（不切斷合併格、不破壞 colspan 對齊）。
   * 判斷以目前查詢範圍內的審查紀錄為準（組別分析＝該組指標、單位分析＝該單位
   * 該組／指標；皆限已查詢的年份區間），含封存摘要。只影響矩陣的期間欄位顯示，
   * 不改計算公式、不改下探邏輯、不動 allMonths。
   * 指標分析無矩陣，沿用舊的按月判定（只影響下探 CAPA 偵測用的欄位）。
   */
  const inArchivedMonths = useCallback(
    (
      ids: string[],
      months: { year: number; month: number }[],
      unitId?: string,
    ): boolean =>
      ids.some((id) =>
        (summaryPlans.get(id)?.archivedCells ?? []).some(
          (c) =>
            (unitId === undefined || c.unitId === unitId) &&
            months.some((m) => m.year === c.year && m.month === c.month),
        ),
      ),
    [summaryPlans],
  );
  /** 全範圍（未隱藏）的矩陣列：僅供 hideEmptyMonths 時判斷哪些月份屬於有資料的 span。 */
  const allMonthRows = useMemo<MatrixRow[]>(() => {
    if (!hideEmptyMonths || (tab !== "group" && tab !== "unit")) return [];
    const months = appliedColumns.flatMap((c) => c.months);
    if (tab === "unit") {
      return buildMatrixRows(unitIndicators, months, selUnitCode, unitUnit, false);
    }
    return buildMatrixRows(groupIndicators, months, undefined, groupUnit, false);
    // buildMatrixRows 為當次 render 的閉包（讀最新值）；deps 列其全部反應式輸入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hideEmptyMonths,
    tab,
    appliedColumns,
    groupIndicators,
    unitIndicators,
    selUnitCode,
    groupUnit,
    unitUnit,
    archiveCtx,
    recordIndex,
    tempTaskIds,
    tempTaskKeys,
    hybridByInd,
  ]);
  const visibleColumns = useMemo(() => {
    if (!hideEmptyMonths) return appliedColumns;
    if (tab === "indicator") {
      const hasRecords = (col: AnalysisPeriodColumn): boolean =>
        selIndicator !== "" &&
        (columnRecordCount(recordIndex, [selIndicator], col.months) > 0 ||
          inArchivedMonths([selIndicator], col.months));
      return appliedColumns.filter(hasRecords);
    }
    if (tab !== "group" && tab !== "unit") return appliedColumns;
    const unitId = tab === "unit" ? selUnitCode : undefined;
    const visibleKeys = new Set<string>();
    for (const row of allMonthRows) {
      for (const span of row.spans) {
        const hasData =
          columnRecordCount(recordIndex, [row.indicatorId], span.months, unitId) > 0 ||
          inArchivedMonths([row.indicatorId], span.months, unitId);
        if (!hasData) continue;
        for (const m of span.months) visibleKeys.add(`${m.year}-${m.month}`);
      }
    }
    return appliedColumns.filter((c) => visibleKeys.has(c.key));
  }, [
    hideEmptyMonths,
    appliedColumns,
    recordIndex,
    tab,
    selIndicator,
    selUnitCode,
    summaryPlans,
    allMonthRows,
    inArchivedMonths,
  ]);

  /** 目前頁籤的矩陣列（組別／單位分析；指標分析無矩陣回 []）。 */
  const matrixRows = useMemo<MatrixRow[]>(() => {
    const months = visibleColumns.flatMap((c) => c.months);
    if (tab === "group") {
      return buildMatrixRows(groupIndicators, months, undefined, groupUnit, true);
    }
    if (tab === "unit") {
      return buildMatrixRows(unitIndicators, months, selUnitCode, unitUnit, true);
    }
    return [];
    // 同 allMonthRows：deps 列 buildMatrixRows 的全部反應式輸入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tab,
    visibleColumns,
    groupIndicators,
    unitIndicators,
    selUnitCode,
    groupUnit,
    unitUnit,
    archiveCtx,
    recordIndex,
    tempTaskIds,
    tempTaskKeys,
    hybridByInd,
  ]);
  /** 列 id → 列（含指標 id 與 spans；分列時 id 帶排程 key，勿直接當指標 id 用）。 */
  const rowMetaById = useMemo(
    () => new Map(matrixRows.map((r) => [r.id, r])),
    [matrixRows],
  );
  const rowIndOf = (rowId: string): string =>
    rowMetaById.get(rowId)?.indicatorId ?? rowId;
  const rowSpansOf = (rowId: string): RowSpan[] =>
    rowMetaById.get(rowId)?.spans ?? [];

  // 期間說明文字（modal 副標共用；顯示已生效的查詢條件）
  const periodDesc = useMemo(() => {
    const from = applied?.startMonth ?? startMonth;
    const to = applied?.endMonth ?? endMonth;
    const granularity = applied?.interval ?? interval;
    const display = (value: string) => value.replace("-", "/");
    const label =
      granularity === "month"
        ? "月"
        : granularity === "academic"
          ? "學年"
          : "年";
    return `${display(from)} ~ ${display(to)}・單位：${label}`;
  }, [applied, startMonth, endMonth, interval]);

  /** 本次分析用到、但已過期（閾值變更）的封存摘要 */
  const staleSummaryLabels = useMemo(
    () => [...new Set([...summaryPlans.values()].flatMap((p) => p.staleLabels))],
    [summaryPlans],
  );

  /** v1.65.1：分析範圍內、已結束超過一個月仍未封存的區間（尚待確認封存） */
  const unconfirmed = useMemo(() => {
    if (!archiveCtx) return [];
    const monthKeys = new Set(allMonths.map((m) => `${m.year}-${m.month}`));
    if (monthKeys.size === 0) return [];
    return unarchivedOverdue(
      archiveCtx.schedules.filter((s) => indOf.has(s.indicatorId) && (!selIndicator || tab !== "indicator" || s.indicatorId === selIndicator)),
      archiveCtx.archiveIds,
      new Date(),
      archiveCtx.deadlineDay,
    ).filter((e) => e.interval.allMonths.some((m) => monthKeys.has(`${m.year}-${m.month}`)));
  }, [archiveCtx, allMonths, indOf, selIndicator, tab]);

  /** 單格達閾值率（人次＝合併；單位＝達閾值單位數／總審查單位數） */
  function cellValue(
    indicatorId: string,
    col: AnalysisPeriodColumn,
    unitId: string | undefined,
    mode: UnitMode,
  ): CellValue {
    const ind = indOf.get(indicatorId);
    const th = ind?.threshold ?? 0;
    const hcs = cellsOfInd(indicatorId, col.months, unitId);
    if (hcs) {
      if (mode === "unit") {
        const ur = unitPassRateFromCells(hcs, th);
        return { ...ur, title: ur.rate == null ? "無資料" : `達閾值 ${ur.pass}／${ur.total} 單位` };
      }
      const pr = passRateFromCells(hcs);
      return { ...pr, title: pr.total === 0 ? "無資料" : `達閾值 ${pr.pass}／${pr.total} 人次` };
    }
    // A3：查表取該指標該期間欄（可再限單位）的紀錄，不再全量 filter。
    const recs = recordsForIndex(recordIndex, indicatorId, col.months, unitId);
    if (mode === "unit") {
      const ur = unitPassRate(recs, th);
      return {
        ...ur,
        title:
          ur.rate == null
            ? "無資料"
            : `達閾值 ${ur.pass}／${ur.total} 單位`,
      };
    }
    const pr = passRateOf(recs, th);
    return {
      ...pr,
      title: pr.total === 0 ? "無資料" : `達閾值 ${pr.pass}／${pr.total} 人次`,
    };
  }

  function matrixScoringDetails(
    indicator: IndicatorOpt,
    columns: AnalysisPeriodColumn[],
    unitId: string | undefined,
    mode: UnitMode,
  ): { key: string; label: string; cells: Record<string, PassRate> }[] {
    // v1.44.0：指標未啟用分組計分時不顯示任何分組／逐題明細列。
    if (!indicator.groupScoring) return [];
    const details = new Map<string, {
      label: string;
      cells: Record<string, PassRate>;
    }>();
    for (const column of columns) {
      const hcs = cellsOfInd(indicator.id, column.months, unitId);
      const periodRecords = hcs
        ? []
        : recordsForIndex(recordIndex, indicator.id, column.months, unitId);
      const rows = hcs
        ? mode === "unit"
          ? unitScoringRowsFromCells(hcs, indicator.questions, [column], indicator.threshold)
          : personScoringRowsFromCells(hcs, indicator.questions)
        : mode === "unit"
        ? unitScoringBreakdownRows(periodRecords, indicator.questions, [column], indicator.threshold)
        : personScoringBreakdownRows(periodRecords, indicator.questions, indicator.threshold);
      for (const row of rows.slice(1)) {
        const current = details.get(row.key) ?? { label: row.label, cells: {} };
        current.cells[column.key] = {
          pass: row.yes,
          total: row.valid,
          rate: row.rate,
        };
        details.set(row.key, current);
      }
    }
    return [...details].map(([key, value]) => ({ key, ...value }));
  }

  /**
   * 曲線圖數列（v1.88.17 Q6=A：一點一合併格，x 軸標籤為區間，如 9–11月；
   * 只取有資料的格；附 hover 提示文字；v1.59.0 附加審標註）。
   * spans 為該列的合併格（矩陣列的 spans；未傳時以單月格計）。
   */
  function chartSeries(
    indicatorId: string,
    unitId: string | undefined,
    mode: UnitMode,
    spans?: RowSpan[],
  ): { values: number[]; labels: string[]; tips: string[]; cols: AnalysisPeriodColumn[]; notes: (string | null)[]; thresholds: (number | null)[] } {
    const values: number[] = [];
    const labels: string[] = [];
    const tips: string[] = [];
    const cols: AnalysisPeriodColumn[] = [];
    const notes: (string | null)[] = [];
    const thresholds: (number | null)[] = [];
    const curTh = indOf.get(indicatorId)?.threshold ?? 0;
    for (const col of spans ?? appliedColumns) {
      const c = cellValue(indicatorId, col, unitId, mode);
      if (c.rate != null) {
        const hcs = cellsOfInd(indicatorId, col.months, unitId);
        const colRecs = hcs ? [] : recordsForIndex(recordIndex, indicatorId, col.months, unitId);
        const note = columnTempNote(
          hcs ? pseudoRecs(indicatorId, hcs) : colRecs,
          tempTaskKeys,
          col.months.length,
        );
        // v1.64.0：人次模式逐筆用排程快照閾值，曲線逐欄畫當時閾值；
        // 單位模式單位層判定本來就用現行指標閾值，維持單一水平線。
        thresholds.push(
          mode === "person"
            ? hcs
              ? columnThresholdFromCells(hcs, curTh)
              : columnThresholdOf(colRecs, curTh)
            : curTh > 0 ? curTh : null,
        );
        values.push(c.rate);
        labels.push(col.label);
        tips.push(`${col.label}${note ?? ""}：${formatPassRate(c, true)}`);
        cols.push(col);
        notes.push(note);
      }
    }
    return { values, labels, tips, cols, notes, thresholds };
  }

  /**
   * v1.53.0：單一期間欄的分組達閾值率——與 matrixScoringDetails 同一口徑。
   * 人次模式：sectionPassRateOf（每人先算分組 rate 再判達標）；單位模式：
   * unitScoringBreakdownRows 單欄（B 法）。歷史分組以當欄紀錄補齊題目 id。
   */
  function sectionCellValue(
    indicator: IndicatorOpt,
    column: AnalysisPeriodColumn,
    periodRecords: AnalysisRecord[],
    mode: UnitMode,
    sectionKey: string,
  ): PassRate {
    const section = resolveDrillSection(indicator.questions, sectionKey, periodRecords);
    if (!section) return { pass: 0, total: 0, rate: null };
    if (mode === "unit") {
      const row = unitScoringBreakdownRows(periodRecords, indicator.questions, [column], indicator.threshold)
        .find((r) => r.key === sectionKey);
      return row
        ? { pass: row.yes, total: row.valid, rate: row.rate }
        : { pass: 0, total: 0, rate: null };
    }
    return sectionPassRateOf(periodRecords, section.ids, section.kind, indicator.threshold);
  }

  /** v1.53.0：分組曲線圖數列（每組一張單線圖；一點一合併格，見 chartSeries；只取有資料的格；v1.59.0 附加審標註） */
  function sectionChartSeries(
    indicatorId: string,
    unitId: string | undefined,
    mode: UnitMode,
    sectionKey: string,
    spans?: RowSpan[],
  ): { values: number[]; labels: string[]; tips: string[]; cols: AnalysisPeriodColumn[]; notes: (string | null)[]; thresholds: (number | null)[] } {
    const ind = indOf.get(indicatorId);
    const values: number[] = [];
    const labels: string[] = [];
    const tips: string[] = [];
    const cols: AnalysisPeriodColumn[] = [];
    const notes: (string | null)[] = [];
    const thresholds: (number | null)[] = [];
    if (!ind) return { values, labels, tips, cols, notes, thresholds };
    for (const col of spans ?? appliedColumns) {
      const hcs = cellsOfInd(indicatorId, col.months, unitId);
      const recs = hcs ? [] : recordsForIndex(recordIndex, indicatorId, col.months, unitId);
      let pr: PassRate;
      if (hcs) {
        const rows =
          mode === "unit"
            ? unitScoringRowsFromCells(hcs, ind.questions, [col], ind.threshold)
            : personScoringRowsFromCells(hcs, ind.questions);
        const row = rows.find((r) => r.key === sectionKey);
        pr = row ? { pass: row.yes, total: row.valid, rate: row.rate } : { pass: 0, total: 0, rate: null };
      } else pr = sectionCellValue(ind, col, recs, mode, sectionKey);
      if (pr.rate != null) {
        const note = columnTempNote(hcs ? pseudoRecs(indicatorId, hcs) : recs, tempTaskKeys, col.months.length);
        thresholds.push(
          mode === "person"
            ? hcs
              ? columnThresholdFromCells(hcs, ind.threshold)
              : columnThresholdOf(recs, ind.threshold)
            : ind.threshold > 0 ? ind.threshold : null,
        );
        values.push(pr.rate);
        labels.push(col.label);
        tips.push(`${col.label}${note ?? ""}：${formatPassRate(pr, true)}`);
        cols.push(col);
        notes.push(note);
      }
    }
    return { values, labels, tips, cols, notes, thresholds };
  }

  /** v1.53.0：選項明細只留該分組的題目（以題目 id 過濾；歷史分組無現行題目→空列） */
  function sectionOptionRows(
    rows: OptionDetailRow[],
    questions: AuditQuestion[],
    sectionKey: string,
    records: AnalysisRecord[],
  ): OptionDetailRow[] {
    const section = resolveDrillSection(questions, sectionKey, records);
    if (!section) return rows;
    const ids = new Set(section.ids);
    return rows.filter((row) => ids.has(row.questionId));
  }

  return {
    indOf,
    spansForIndicator,
    visibleColumns,
    sectionChartSeries,
    chartSeries,
    periodDesc,
    cellValue,
    recordIndex,
    sectionOptionRows,
    hybridByInd,
    capaSpansForIndicator,
    errorUnitCode,
    staleSummaryLabels,
    unconfirmed,
    scopedGroups,
    scopedUnits,
    hasNaUnit,
    unitIndOptions,
    indTabIndicators,
    causeCountRows,
    ownUnitUngrouped,
    groupIndicators,
    groupNameOf,
    matrixRows,
    rowIndOf,
    hasTempReview,
    rowSpansOf,
    unitIndicators,
    unitNameOf,
    selUnitCode,
    unitCapaCases,
    indCapaCases,
    ensureHistory,
    ensureMonths,
    cellsOfInd,
    historyBusy,
    historyNote,
  };
}
