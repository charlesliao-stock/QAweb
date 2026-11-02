# 護理品質指標管理系統（展示版）

本 repository 目前提供流程展示用的前端原型，使用虛構人員、單位、指標、排程與改善案件。畫面可切換角色，瀏覽儀表板、指標管理、審查排程、一題一卡審查、結果分析、群組權限、CAPA 與系統管理介面。

> **僅供展示**：不具備正式身分驗證或正式授權；不要輸入真實職編、密碼、Email、病人資料、床號、審查結果或其他院內資料。展示操作不會寫入 Firebase。

## 本機啟動

需要 Node.js 22 或相容版本與 pnpm 11。

```bash
pnpm install
pnpm dev
```

正式靜態檔案可用 `pnpm build` 產生於 `dist/`。Vite 的 production base path 已依 GitHub repository 名稱設為 `/QAweb/`；本次只放入網站原始碼，沒有自動啟用 GitHub Pages 部署。

## Firebase 展示唯讀連線

預設使用 `src/data/demo.ts` 的本地虛構資料。Firebase 讀取旗標預設為 `false`；只有先確認 Firestore Security Rules 僅允許品管 demo 文件讀取後，才可設定 Firebase Web SDK 環境變數並明確設為 `VITE_FIREBASE_DEMO_READS=true`，嘗試唯讀讀取 `qms_demo/indicators/records`。Firestore 查詢只取 `demoOnly: true` 文件，畫面只顯示程式允許的展示欄位。Firebase 無設定、規則拒絕讀取或沒有展示文件時，改用本地展示資料。

```bash
cp .env.example .env.local
```

把 Firebase Web SDK 設定填入 `.env.local`。`.env.local` 不應提交到 GitHub。此展示 adapter 不會讀取 Firebase 專案中的其他資料集合，也沒有 Firestore 新增、修改或刪除操作。Firebase Web 設定不是資料保護機制；Firestore Security Rules 必須另外限制 `qms_demo` 路徑，並避免公開讀取其他資料。

## 正式使用前仍需完成

正式版本須使用院方核准的專用 Firebase 專案，完成 Firebase Authentication、人員與群組權限、Firestore Security Rules、Email 驗證碼後端（例如受控 Cloud Functions 加上核准的郵件服務）、稽核軌跡、資料保存與備份規則。不得直接將此展示專案視為正式醫療或院內系統；必須先經院方資安與流程驗收。
