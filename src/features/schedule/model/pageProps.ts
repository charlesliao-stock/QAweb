export interface SchedulePageProps {
  onAction: (message: string) => void;
  /**
   * 指標總覽帶入：預選該指標與年份（清單篩選，不直接跳進編輯器；
   * 無此參數時與現行行為完全相同）。
   */
  initial?: { indicatorId: string; year: number } | null;
}
