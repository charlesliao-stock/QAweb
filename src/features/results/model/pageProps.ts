export interface ResultsPageProps {
  onAction: (message: string) => void;
  /**
   * 指標總覽帶入：切到「指標分析」模式、預選該指標，起迄用結果分析預設
   * （Q5 系統設定：學年度 8 月～本月，年度 1 月～本月；不再帶入該年全年）。
   * 查詢仍走現行 handleQuery 與 dataScope 過濾，不繞過權限；
   * 無此參數時與現行行為完全相同。
   */
  initial?: { indicatorId: string } | null;
}
