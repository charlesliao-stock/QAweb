# 三大頁面拆分說明（Groups／Results／Schedule）

基準：`main` @ `21c76bb`（v1.88.24）。拆分在整合分支 `refactor/split-pages` 完成，尚未合併到 `main`。

## 規模

| 入口 | 拆分前 | 拆分後（入口檔） |
|---|---:|---:|
| `src/features/GroupsPage.tsx` | 6,612 | 238 |
| `src/features/ResultsPage.tsx` | 5,660 | 197 |
| `src/features/SchedulePage.tsx` | 4,991 | 128 |

三個入口檔路徑、匯出名稱與 props 不變（`GroupsTab`／`OrgMemberTarget`、Schedule 的八個純函式與 `PickerOption` 皆保留相容 re-export）；`App` 的 lazy import 不需修改。

## 結構

```text
src/features/
  GroupsPage.tsx  ResultsPage.tsx  SchedulePage.tsx      # 薄入口（組裝）
  groups/   model/（型別、表單預設、批次寫入小工具、pageProps）
            importers/（匯入範例常數）
            components/（BatchImporter、MemberChecklist）
            hooks/（useGroupsState → Derived → Loaders → OrgActions → UserActions
                    → MemberActions → Importers → Panels，最後由 useGroupsCtx 串起）
            tabs/（各頁籤與表單區塊元件）
  results/  model/  components/  hooks/（State → Scope → Query → Compute → Actions，
            useResultsCtx；早退之後的 useResultsAnalysis）  tabs/
  schedule/ model/（types、pure）  components/  hooks/（State → Scope → Data → Rows，
            useScheduleCtx）  views/（ScheduleListView）
```

## 分層 hook 的規則（維護時請遵守）

1. **順序即原始順序**：每個 `useXxx` 是元件本體一段連續陳述；頁面依同順序無條件呼叫。新增 state／effect 請放進語意最接近的層，不要調換層順序。
2. **層間只往前依賴**：後一層以參數取得前面各層的回傳物件；前層不得引用後層宣告的名稱（型別由 `ReturnType<typeof useXxx>` 自動推導，無手寫型別）。
3. **Results 的早退**：`if (!can("resultQuery") && !isAdmin) return …` 之後的 hook（`useResultsAnalysis`）必須仍在早退之後呼叫（沿用既有條件式 hook 行為，未修改）。
4. **頁籤切換的 DOM 重用**：Groups 的頁籤內容是同一位置的三元分支鏈，必須維持在同一元件（`GroupsTabSwitch`）內；拆成不同元件型別會改變切換時的節點重用行為（渲染等價比對曾因此失敗）。
5. 三個 feature 之間不得互相 import（`pnpm check:boundaries` 強制）。

## 驗證機制

- `pnpm build`（tsc -b＋vite build）。
- `pnpm check:boundaries`：模組邊界。
- `scripts/run-tests.mjs`＋`tests/test-baseline.json`：舊測試逐支基準，只擋新增失敗。
- **渲染等價**（`.github/workflows/render-equivalence.yml`）：以 demo 帳號＋記憶體資料、固定時間與亂數，把拆分前（`21c76bb`）與拆分後的三頁各渲染一次（含種入的審查紀錄），逐步比對 DOM：Groups 五頁籤與新增表單、成員管理頁；Results 三分析頁籤（含矩陣、下探彈窗）、管理頁；Schedule 清單、排程編輯、加審對話框等；目前 38 個步驟全部相同、console.error 0 筆。

## 未納入（沿用計畫書排除項）

Modal 無障礙統一（E1）、排序統一（E2）、migration 時機（E3）、reducer 重寫（E4）、Results 摘要／原始統一（E5）、tab lazy／分頁（E6）、讀取最佳化（E7），以及 Results 計算函式的閉包顯式化（R2：函式本體仍在 `useResultsCompute` 內，未改為純函式）。共用元件（Modal、MonthPicker 等）的跨頁整併盤點見計畫書 PR1，結論為不在本輪抽取。

## 已知既有問題（拆分前就存在，未改動）

- `ResultsPage` 在權限早退之後仍有 hook（條件式 hook）；正式流程因權限載入完成後才掛載頁面而不會觸發。
