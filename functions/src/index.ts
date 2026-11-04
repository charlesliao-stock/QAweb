// 第二階段 stub：待升級 Blaze 後實作。對應 firebase_plan.md §4。
// 啟用前本檔不部署；第一階段通知改由儀表板警示呈現。

export const FUNCTIONS_TODO = [
  "sendVerifyCode / verifyCode（HTTPS：Email 驗證碼）",
  "notifyReviewStart（Scheduler 每月 1 日：任務開始通知）",
  "notifyOverdue（Scheduler 月底前 10/5/1 天：階梯催辦）",
  "notifyDeadline（Scheduler 次月 9 日：補審截止急催）",
  "notifyDraftExpiry（Scheduler 每日：草稿清除前 5 天提醒）",
  "onReviewSubmitted（Firestore trigger：通知護理長、CAPA 自動啟動）",
  "cleanupDrafts（Scheduler 每日：清除逾期 30 天草稿）",
  "retentionCleanup（Scheduler 每月：3 年到期資料清除）",
  "exportReport（HTTPS：Excel/PDF 報表產生）",
] as const;
