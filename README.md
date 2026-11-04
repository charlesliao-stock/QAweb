# 護理品質指標管理系統（展示版）

本 repository 提供護理品質管理系統原型。預設是本地展示模式；啟用 Firebase Auth 模式後，可用既有帳號登入，唯讀查詢測試用指標與審查紀錄，並依年度排程的起始月份及審核月數彙整季度趨勢。

> **開發／測試用途**：Firebase 模式使用 Firebase Authentication 與 Firestore Security Rules；審查結果查詢不會新增、修改或刪除 `reviewRecords`。排程月份儲存會寫入 `indicatorYearSchedules`。不可使用真實病人資料或未核准的生產資料；前端角色範圍不是 Firestore Rules 的替代品。

結果分析頁可依指標與年度查詢已送出的 `reviewRecords`，切換審查人員／單位視角，呈現每一期平均符合率折線及明細。月份依 `indicatorYearSchedules.months`（期別起始月）與 `monthsPerAudit`（每期涵蓋月數）歸屬；例如 `[1,4,7,10]` 且 `monthsPerAudit=3` 對應 1–3、4–6、7–9、10–12 月。人員視角依審查紀錄的 `reviewerId`／`reviewerName` 彙整，並非受審病人或受審員工。

## 本機啟動

需要 Node.js 22 或相容版本與 pnpm 11。

```bash
pnpm install
pnpm dev
```

正式靜態檔案由 `pnpm build` 產生於 `dist/`。Vite production base path 已依 GitHub repository 名稱設為 `/QAweb/`。

## GitHub Pages 自動部署

`.github/workflows/deploy.yml` 對 `main` 的 pull request 執行建置檢查；push 到 `main` 或在 `main` 手動執行 workflow 時，會建置 `dist/` 並部署到 GitHub Pages。GitHub repository 的 **Settings → Pages → Build and deployment → Source** 必須設定為 **GitHub Actions**。

Workflow 固定將 `VITE_FIREBASE_DEMO_READS` 設為 `false`，並啟用 Firebase Auth 模式。建置使用已公開於 nurseboard 前端的 Firebase Web SDK client config；這不是服務端憑證，也不能代替 Security Rules。禁止提交服務帳戶憑證或啟用匿名結果讀取。

## Firebase Authentication 與審查結果

在 Firebase 模式下，使用職編與密碼登入（登入帳號格式為 `{職編}@nurseboard.internal`），並讀取 `users/{職編}` 的姓名、角色、單位及群組欄位。結果分析僅查詢 `reviewRecords` 中指定指標、目前登入角色允許範圍與年度的已送出紀錄；需要相應 Firestore Rules 授權。年度排程設定儲存至 `indicatorYearSchedules`，欄位為 `indicatorId`、`year`、`months`、`monthsPerAudit` 及多選的 `unitIds`；舊文件未有 `unitIds` 時，畫面預選目前帳號可管理的單位。此區只負責「指標 × 年度 × 排程單位 × 月份」，不處理審查員與單位的指派；指派流程應維持獨立，且此次修改不會寫入或覆蓋該對應資料。審查結果 adapter 不提供寫入審查紀錄的函式。

```bash
cp .env.example .env.local
```

`.env.example` 已含公開的 Firebase Web SDK client config；本機如需測試 Auth 模式，將 `VITE_FIREBASE_AUDIT_READS` 設為 `true`。`.env.local` 不應提交到 GitHub。網站端不含管理員憑證；Firebase Web 設定不是資料保護機制。Security Rules 必須依已驗證使用者角色及查詢條件限制各集合，不可因前端隱藏或篩選而視為已完成授權。

Firebase Auth 模式下，`系統管理員` 會優先取得完整前端導覽與全院結果查詢視角。系統管理頁目前僅為權限矩陣展示，未寫入角色/權限或查詢稽核事件；群組／審查員管理及 CAPA、任務清單亦尚未連接 Firestore。前端完整導覽不代表伺服器端已授予權限，真實角色管理需先完成受控後端與 Firestore Rules。

## 正式使用前仍需完成

正式版本仍須由 Firestore Security Rules（或受控後端）強制執行完整角色範圍：主任／副主任／督導全院；各組召集人／執行幹事僅所屬組別；護理長僅所屬單位。群組角色先使用 `users.groupId`／`groupIds`，若未填則嘗試用 `users.unitCode` 對應 `units.groupId`；單位角色需提供與審查紀錄 `unitId` 對應的 `unitCode`。目前 UI 查詢範圍是額外的最小化篩選，不可單獨視為安全邊界。正式使用前仍須進行資安與流程驗收。
