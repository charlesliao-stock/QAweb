import type { RowSpan } from "../../../lib/analysisSpans";
import type { AuditQuestion } from "../../../lib/indicators";
import type { PassRate, OptionDetailRow } from "../../../lib/analysisRates";
import type { AnalysisPeriodColumn } from "../../../lib/analysisPeriod";

export interface IndicatorOpt {
  id: string;
  code: string;
  name: string;
  groupId: string;
  status: string;
  version: string;
  threshold: number;
  /** 指標設定頁「啟用分組計分」開關；關閉時結果分析不顯示任何分組／逐題明細列 */
  groupScoring: boolean;
  /** 指標設定的審核項目清單（v1.48.0）：非空時匯入範本多一欄「審核項目」 */
  auditItems: string[];
  questions: AuditQuestion[];
}

export interface GroupOpt {
  id: string;
  name: string;
}

export interface UnitOpt {
  code: string;
  name: string;
  groupId: string;
  mergedFromUnitCodes: string[];
}

export type TabId = "group" | "unit" | "indicator" | "import" | "manage";

/**
 * v1.88.33：結果分析頂層只留三部分（Q1）。
 * TabId 的 group／unit／indicator 改為「結果分析」內的查詢模式；
 * import／manage 仍保留在 TabId 供舊參照比對，但頂層切換走 section。
 * 其後再改：模式切換列拿掉，tab 改為內部檢視狀態，由篩選器推導
 * （指標＞單位＞品管組，見 handleQuery），不再由使用者直接切換。
 */
export type ResultsSection = "analysis" | "import" | "manage";

export type UnitMode = "person" | "unit";

export interface CellValue extends PassRate {
  title: string;
}

export interface ChartModalData {
  title: string;
  subtitle: string;
  values: number[];
  labels: string[];
  /** hover 提示（與 values 對齊）：期間＋正確率＋（正確數／審查數） */
  tips: string[];
  /** v1.59.0：x 軸標籤附註（與 values 對齊）：「（加審）」／「（有加審）」／null */
  notes: (string | null)[];
  /** 閾值（紅色虛線）；null 表示不畫 */
  threshold: number | null;
  /** v1.64.0：逐點閾值（與 values 對齊）；有變動時圖上畫階梯式虛線 */
  thresholds?: (number | null)[];
  /** v1.50.0：曲線圖上的點可點下探，須帶回指標／單元／期間欄／單位 */
  indicatorId: string;
  mode: UnitMode;
  cols: AnalysisPeriodColumn[];
  unitId?: string;
  /** v1.53.0：分組曲線（sectionKey：group-…／question-…／historical-…）；無值＝整支指標 */
  sectionKey?: string;
  sectionLabel?: string;
}

/** v1.53.0：分組參照（分組子列／分組明細列的 key＋顯示名稱） */
export interface SectionRef {
  key: string;
  label: string;
}

export interface DocModalData {
  title: string;
  subtitle: string;
  rows: OptionDetailRow[];
  /** v1.50.0：選項明細列可點下探，須帶回指標／單位 */
  indicatorId: string;
  unitId?: string;
  /** 下探單元（組別／單位分析當時的單元） */
  mode: UnitMode;
  /** v1.53.0：分組選項明細（只列該組題目）；無值＝整支指標 */
  sectionKey?: string;
  sectionLabel?: string;
}

/** 下探狀態：L1 單位矩陣（l2UnitId 為 null）；L2 人員各選項結果（l2UnitId 有值） */
export interface DrillState {
  indicatorId: string;
  column: AnalysisPeriodColumn;
  mode: UnitMode;
  /** 單位分析限定該單位；組別／指標分析為 undefined（全部單位） */
  scopeUnitId?: string;
  l2UnitId: string | null;
  /** v1.73.0：「顯示近 N 次」點歷史月份格子下探時，L2 只看該月（未設＝點選的期間欄） */
  l2Months?: { year: number; month: number }[];
  /** v1.50.0：直接開 L2 人員層級（全部單位），不經 L1 單位列表 */
  l2All?: boolean;
  /** 指標分析卡片下探（人次模式）：L2 只看該人員（與 l2UnitId／l2Months 併用） */
  l2PersonEmpNo?: string;
  /** v1.50.0：分組／逐題篩選（section key：group-…／question-…／historical-…），只顯示該分組／該題的個人結果 */
  sectionKey?: string;
  /** v1.50.0：單題篩選（選項明細／錯題排行用） */
  questionId?: string;
  /** v1.50.0：只顯示答此選項的人員（與 questionId 併用） */
  optionLabel?: string;
  /**
   * v1.88.17 Q5=C：點多月合併格時先展開區間內各月明細（SpanMonthPicker），
   * 再由使用者選單月進入 L1／L2；true 時不渲染 DrillModal，改渲染選月彈窗。
   */
  pickMonths?: boolean;
}

/**
 * v1.88.33 Q8：矩陣列點開的展開面板（組別／單位模式共用）。
 * 點指標列即展開，下方同時呈現該指標曲線圖＋細項結果（不再分曲線／文件兩種面板，
 * 也不再用彈窗）。scope 區分面板屬於哪個模式；unitId 有值時只看該單位。
 */
export interface RowPanel {
  scope: "group" | "unit";
  indicatorId: string;
  /** v1.88.17：開啟面板的那一列 id（同一指標分列時，用來取該列的 spans 畫曲線） */
  rowId?: string;
  /** 限看單位（單位模式＝該單位；組別模式＝複合篩選選的單位，無則全部） */
  unitId?: string;
  /** v1.53.0：分組版（只看該組）；無值＝整支指標 */
  sectionKey?: string;
  sectionLabel?: string;
}

/**
 * v1.88.17：每列合併格（RowSpan）建構。
 * 表頭固定一月一格；每列的資料格按該指標自己的排程區間 colspan 合併。
 * 加審月份不併入合併格：有加審紀錄的月份從區間中切出、獨立成一格
 * （temp: true，格面顯示該月全部紀錄並標「加審」），區間其餘月份仍合併。
 */
export interface MatrixRow {
  id: string;
  indicatorId: string;
  label: string;
  spans: RowSpan[];
  details: { key: string; label: string; cells: Record<string, PassRate> }[];
}
