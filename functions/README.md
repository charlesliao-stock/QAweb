# Cloud Functions（第二階段，待升級 Blaze 後啟用）

本目錄為 9 支 Functions 的程式骨架，對應 `firebase_plan.md` §4。
第一階段（Spark 方案）不部署；各功能以儀表板警示／前端計算替代。

啟用步驟：
1. Firebase console 升級 Blaze
2. `cd functions && npm install`
3. `firebase deploy --only functions`
4. 將 `src/lib/features.ts` 對應旗標改為 `true`

| Function | 觸發 | 用途 |
|---|---|---|
| sendVerifyCode / verifyCode | HTTPS | Email 驗證碼 |
| notifyReviewStart | Scheduler（每月 1 日） | 審查任務開始通知 |
| notifyOverdue | Scheduler（月底前 10/5/1 天） | 未完成階梯催辦 |
| notifyDeadline | Scheduler（次月 9 日） | 補審截止急催 |
| notifyDraftExpiry | Scheduler（每日） | 草稿清除前 5 天提醒 |
| onReviewSubmitted | Firestore trigger | 通知護理長、CAPA 自動啟動判斷 |
| cleanupDrafts | Scheduler（每日） | 清除逾期 30 天草稿 |
| retentionCleanup | Scheduler（每月） | 3 年到期資料清除 |
| exportReport | HTTPS | Excel/PDF 報表產生 |
