/**
 * 預存摘要的 Firestore 存取（v1.64.0）：封存（產生／重新產生）與載入。
 * 純計算在 reviewSummary.ts；此檔只負責讀原始紀錄、寫入 reviewArchives、稽核。
 */
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
} from "./db";
import { dbIndexedQueryApi, fetchIndicatorMonths } from "./indexedRecords";
import { writeAuditLog } from "./audit";
import { effectiveThreshold, normalizeQuestions } from "./indicators";
import type { AnalysisRecord } from "./analysisRates";
import {
  buildReviewSummary,
  summaryDocId,
  type ReviewSummary,
} from "./reviewSummary";
/* eslint-disable @typescript-eslint/no-explicit-any */

export const SUMMARY_COLLECTION = "reviewArchives";

export interface StoredSummary extends ReviewSummary {
  id: string;
  generatedBy: string;
  generatedByName: string;
  generatedAtMs: number | null;
}

/** reviewRecords 文件 → 分析用紀錄（與結果分析頁同一欄位對應） */
export function recordDocToAnalysis(
  id: string,
  v: Record<string, unknown>,
): AnalysisRecord {
  const answers = Array.isArray(v.answers)
    ? (v.answers as unknown[]).map((raw) => {
        const r = (raw ?? {}) as Record<string, unknown>;
        return {
          questionId: typeof r.questionId === "string" ? r.questionId : "",
          itemText: typeof r.itemText === "string" ? r.itemText : "",
          optionLabel: typeof r.optionLabel === "string" ? r.optionLabel : "",
          score: typeof r.score === "number" ? r.score : 0,
          excluded: r.excluded === true,
          commonErrors: Array.isArray(r.commonErrors)
            ? r.commonErrors.filter((w): w is string => typeof w === "string")
            : [],
          note: typeof r.note === "string" ? r.note : "",
        };
      })
    : [];
  return {
    indicatorId: String(v.indicatorId ?? ""),
    taskId: typeof v.taskId === "string" ? v.taskId : id,
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
  };
}

function storedFromDoc(id: string, d: Record<string, unknown>): StoredSummary | null {
  if (typeof d.indicatorId !== "string" || !Array.isArray(d.cells)) return null;
  const ts = d.generatedAt as { toMillis?: () => number } | undefined;
  return {
    id,
    indicatorId: d.indicatorId,
    scheduleCategory: String(d.scheduleCategory ?? ""),
    schedulePeriod: String(d.schedulePeriod ?? ""),
    start: d.start as ReviewSummary["start"],
    end: d.end as ReviewSummary["end"],
    schemaVersion: Number(d.schemaVersion ?? 0),
    status: d.status === "pending_review" ? "pending_review" : "valid",
    thresholdUsed: Number(d.thresholdUsed ?? 0),
    noSnapshotCount: Number(d.noSnapshotCount ?? 0),
    recordCount: Number(d.recordCount ?? 0),
    hasGroups: d.hasGroups === true,
    cells: d.cells as ReviewSummary["cells"],
    generatedBy: String(d.generatedBy ?? ""),
    generatedByName: String(d.generatedByName ?? ""),
    generatedAtMs: typeof ts?.toMillis === "function" ? ts.toMillis() : null,
  };
}

/** 載入全部摘要（以文件 ID 為鍵）。摘要文件數＝指標×區間，量小。 */
export async function loadAllSummaries(db: any): Promise<Map<string, StoredSummary>> {
  const snap = await getDocs(query(collection(db, SUMMARY_COLLECTION), limit(2000)));
  const out = new Map<string, StoredSummary>();
  snap.docs.forEach((d: any) => {
    const s = storedFromDoc(d.id, d.data() as Record<string, unknown>);
    if (s) out.set(d.id, s);
  });
  return out;
}

export interface ArchiveTarget {
  indicatorId: string;
  category: "year" | "academic" | "temp";
  period: string;
  start: { year: number; month: number };
  end: { year: number; month: number };
  /** 區間內曆年月 key（"年-月"） */
  monthKeys: Set<string>;
  /** 排程單位（週期排程用來過濾；空＝不限） */
  unitIds: string[];
}

/**
 * 封存（產生／重新產生）一個區間的摘要：讀該指標全部原始紀錄 → 篩區間 →
 * 計算 → 寫入 reviewArchives（覆寫同 ID）＋稽核。分頁被截斷時拒絕寫入，
 * 避免存下不完整的摘要。回傳寫入的摘要。
 */
export async function archiveInterval(
  db: any,
  target: ArchiveTarget,
  actor: { id: string; name: string },
): Promise<StoredSummary> {
  const indSnap = await getDoc(doc(db, "indicators", target.indicatorId));
  if (!indSnap.exists()) throw new Error("找不到該指標，無法封存");
  const indData = indSnap.data() as Record<string, unknown>;
  const questions = normalizeQuestions(indData.questions).questions;
  const threshold = effectiveThreshold(indData);

  // 讀量優化：只讀該區間月份的紀錄（依年份分組 month in），不再整個指標全部年度重讀。
  // 任何一年讀取失敗即丟錯中止，不寫入不完整的摘要。
  const monthsByYear = new Map<number, number[]>();
  for (const key of target.monthKeys) {
    const [y, m] = key.split("-").map(Number);
    monthsByYear.set(y, [...(monthsByYear.get(y) ?? []), m]);
  }
  const fetched = await Promise.all(
    [...monthsByYear].map(([year, months]) =>
      fetchIndicatorMonths(dbIndexedQueryApi, collection(db, "reviewRecords"), {
        indicatorId: target.indicatorId,
        year,
        months,
      }),
    ),
  );

  // 摘要存「該指標、該區間月份的全部紀錄」（含匯入、非排程單位），與結果分析
  // 口徑一致；品管審查進度在讀取端依排程單位過濾格子，不另存。
  // 注意：年度與加審區間月份重疊時，兩份摘要內容重複，讀取端同一指標同一月份
  // 只能採用其中一份，不可相加。
  const records: AnalysisRecord[] = [];
  for (const snap of fetched) {
    snap.docs.forEach((d: any) => {
      const rec = recordDocToAnalysis(d.id, d.data() as Record<string, unknown>);
      if (target.monthKeys.has(`${rec.year}-${rec.month}`)) records.push(rec);
    });
  }
  const summary = buildReviewSummary({
    indicatorId: target.indicatorId,
    scheduleCategory: target.category,
    schedulePeriod: target.period,
    start: target.start,
    end: target.end,
    records,
    questions,
    threshold,
  });
  const id = summaryDocId(target.indicatorId, target.category, target.period, target.start);
  await setDoc(doc(db, SUMMARY_COLLECTION, id), {
    ...summary,
    generatedBy: actor.id,
    generatedByName: actor.name,
    generatedAt: serverTimestamp(),
  });
  await writeAuditLog(db, {
    actor: actor.id,
    actorName: actor.name,
    action: "封存摘要",
    targetType: "reviewSummary",
    targetId: id,
    detail: `${target.indicatorId}・${target.start.year}/${target.start.month}～${target.end.year}/${target.end.month}：${records.length} 筆紀錄`,
  }).catch(() => undefined);
  return {
    ...summary,
    id,
    generatedBy: actor.id,
    generatedByName: actor.name,
    generatedAtMs: Date.now(),
  };
}
