# Cloud Functions：品質審查摘要預計算

此功能使用 Firebase Functions v2、Node.js 20 與 Admin SDK。**目前 Firebase 專案為 Spark；本次僅修改程式庫，未部署 Functions、Firestore Rules 或索引，也未設定 SMTP secrets 或寄送測試信。**正式啟用前須確認 Blaze 計費方案、Cloud Scheduler／必要 Google APIs、服務權限、Firestore Rules 與複合索引均已設定，並完成 staging 驗證。

## 摘要文件

`reviewSummaries/{id}` 的穩定 ID 由指標、排程初始年月、排程時指標版本與 scope（`unit`／`all`）組成。文件保存 `indicatorId`、`scheduleStartYear/month`、`scheduleStartKey`（數值 `YYYYMM`，供前端查詢）、`scheduleEndYear/month`、`indicatorVersion`、`scope`、`unitId`（全院 scope 為 null）、排程快照 `threshold`／`thresholdRule`、`passedCount`、`totalCount`、`questionOptions`、`precomputedAt` 與 `refreshStatus`。每題保存 `questionId`、`itemText`、`yes`、`no`、`notApplicable` 及保留空間 `reasonCounts: {}`（尚未啟用）。

有效資料須包含數值 `rate`、指標及版本、`unitId`、數值 `thresholdAtSchedule`、`thresholdRuleAtSchedule: ">="`，以及排程起訖年月快照。`passedCount` 使用每筆審查排程當時的閾值計算，不讀現行指標閾值。紀錄以 Firestore 文件 ID 去重，同一紀錄同一題只計最後一筆答案；零分率有效，null／非有限率不計。若同一摘要 bucket 的閾值或結束年月不一致，拒絕彙總並進入重試／告警，不靜默混算。版本不同仍各自保存摘要；結果分析的錯題排行可依完全相同題目文字跨版本彙總，但該排行不代表版本等價或趨勢可合併。

## 計算與更新時點

每日台灣時間 08:00 執行排程函數；只有每月 11 日建立上個日曆月結束的摘要，以符合 10 日補登、隔日計算的作業規則。月彙總直接以 `reviewRecords.scheduleEndYear/month` 查詢上月結束的紀錄，並清除該結束月份已無來源資料的舊摘要；不掃描整個 `reviewRecords` 集合。任務 builder 會把排程區間起訖年月寫入新任務，新建審查紀錄沿用相同快照。

審查紀錄新增、修改或刪除時，若受影響 bucket 已有預存摘要，立即依 `indicatorId + scheduleStartYear + scheduleStartMonth + indicatorVersionAtSchedule` 限定查詢並重算；**尚未到首次月計算、且尚無摘要的 bucket，不因每筆新增而提前建立摘要。**修正只改變答案／結果時，摘要仍沿用原排程版本及閾值。重算採現況完整彙總而非增量累加，具冪等性。

任一重算失敗會記錄工作並排在隔日 08:00 重試；隔日再失敗即標記 failed，為每位 `users` 中 `roles` 含「系統管理員」的人員建立應用程式內持久通知，並在 SMTP 已設定且啟用時寄送電子郵件。應用程式側欄已提供通知清單及標記已讀功能。郵件預設關閉；啟用須設定 `REVIEW_SUMMARY_EMAIL_ENABLED=true`、`SMTP_HOST`、`SMTP_PORT`、`SMTP_FROM`，以及 Secret Manager secrets `SMTP_USER`、`SMTP_PASSWORD`。不可將憑證提交至 repository。

## 舊資料與資料安全

上線前既有 `reviewRecords` 若缺少 `indicatorVersionAtSchedule`、`thresholdAtSchedule`、`thresholdRuleAtSchedule`、`scheduleStartYear/month` 或 `scheduleEndYear/month`，不會推測現行版本或閾值，也不會納入摘要。須先由管理者依核定版本、舊任務及稽核資料完成一次受控回填；不可直接以目前指標資料覆寫歷史快照。Firestore Rules 限制摘要僅登入者唯讀、僅 Admin SDK 可寫，並禁止一般任務／紀錄更新改寫版本、閾值及排程區間快照。

## 本地檢查與部署

```sh
cd functions
npm ci
npm run typecheck
npm run build
```

Blaze 與上述 prerequisites 完成後，具權限人員才可執行 `firebase deploy --only functions,firestore:rules,firestore:indexes`。先在 staging 驗證摘要讀取、unit/all 權限範圍、跨版本題目排行、11 日補算、校正即時更新、重試與告警收件人／SMTP；本次工作不會觸發部署。

| Function | 觸發 | 用途 |
|---|---|---|
| `refreshReviewSummaryOnRecordWrite` | `reviewRecords` create/update/delete | 若摘要已存在，重算受影響的指標／排程月份／版本 bucket |
| `precomputeMonthlyReviewSummaries` | 每日 08:00 `Asia/Taipei` | 11 日計算上個月月底結束的摘要；每日檢查隔日重試工作 |
