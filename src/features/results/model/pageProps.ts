export interface ResultsPageProps {
  onAction: (message: string) => void;
  /**
   * 指標總覽帶入：切到「指標分析」頁籤、預選該指標、查詢該年 1～12 月。
   * 查詢仍走現行 handleQuery 與 dataScope 過濾，不繞過權限；
   * 無此參數時與現行行為完全相同。
   */
  initial?: { indicatorId: string; year: number } | null;
}
