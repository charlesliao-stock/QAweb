# 測試清單與基準（PR0）

目的：拆分 GroupsPage／ResultsPage／SchedulePage 期間，用「每支腳本相對基準有無新增失敗」判斷是否退化。
舊測試不是全綠（版本號斷言已過期、部分斷言已與現況脫節），因此**不以全數通過為門檻**。

## 指令
- `pnpm check:boundaries`：模組邊界檢查（阻擋式）。
- `pnpm test:static`：僅跑靜態（讀原始碼）測試，本機即可。
- `pnpm test`：全部（bundle／dom 需 esbuild／jsdom，本機無則略過；CI 會暫時安裝）。
- 基準檔：`tests/test-baseline.json`；更新：`node scripts/run-tests.mjs --update-baseline`。

## 分類（共 64 支）
| 類別 | 數量 | 說明 |
|---|---|---|
| static | 23 | 讀原始碼字串比對 |
| bundle | 35 | 用 esbuild 打包後執行 |
| dom | 6 | 需 jsdom |

## static 基準（本機實測，Node 22）
- 通過：test-v1.39.4
- 僅版本號斷言過期而失敗：v1.40.1、1.40.3、1.40.5、1.40.7、1.53.0、1.83.0、1.84.1、1.84.2、1.85.0
- 含實質斷言已脫節（歷史既有，非本次造成）：v1.32.1-rwd（35）、v1.40.6（8）、v1.41.0（4）、v1.54.0（15）、v1.56.0（4）、v1.57.0（2）、v1.84.0（2）
- 缺套件而略過：v1.40.2、1.40.4、1.43.0、1.43.1、1.55.0、1.69-dashboard-visibility

## 基準來源
以 CI（ubuntu、Node 22、已安裝 esbuild／jsdom）首次完整執行結果為準：64 支中 通過 18、失敗 46（多為版本號斷言過期）。本機缺套件時 static 內有 6 支會略過，CI 上那 6 支為：v1.40.2／1.40.4／1.43.0／1.43.1／1.55.0 失敗、v1.69-dashboard-visibility 通過。

## 注意
- 28 支測試直接讀三個大頁面的原始碼；拆分後這些斷言會因檔案移動而失敗，屬預期，須在對應 PR 中同步更新斷言（僅調整讀取路徑，不放寬檢查內容）。
- 本 PR 不含 fixtures／golden helper，將隨 S1／R2／G4 提供。

## 拆分期間新增的驗證
- `scripts/check-boundaries.mjs`：模組邊界。
- `scripts/render-snapshots.mjs`＋`scripts/compare-snapshots.mjs`：拆分前後渲染等價比對（CI，見 `docs/page-split.md`）。
