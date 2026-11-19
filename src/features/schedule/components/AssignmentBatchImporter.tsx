import type { ReviewerLite, UnitLite } from "../model/types";
import { type ParsedAssignmentRow, type ValidatedAssignmentRow, ASSIGNMENT_IMPORT_HEADER, validateAssignmentImportRows, ASSIGNMENT_IMPORT_SAMPLE_ROWS } from "../../../lib/assignmentImport";
import { useRef, useState, useMemo } from "react";
import { readSheetFile, downloadTemplate } from "../../../lib/sheetFile";
import { toErrorMessage } from "../../../lib/errors";
import { Download, Upload } from "lucide-react";
import { SectionTitle } from "../../../components/ui";
import { maskName } from "../../../lib/mask";

/* ================= 審查員／單位設定（v1.18：組別篩選＋搜尋多選） ================= */

/* ================= 分工表批次匯入（v1.88.4；v1.88.13 改為 4 欄） =================
 * 範本欄位：指標代號／審查員職編／負責單位／審查月份（多筆半形逗號分隔）。
 * 指標代號只核對目前頁面指標；姓名欄已移除，預覽依職編帶出遮罩姓名供確認。
 * 驗證走 lib/assignmentImport 純函式；匯入只寫進分工表 state，
 * 須按「儲存分工表」才寫入 Firestore。
 */
export function AssignmentBatchImporter({
  indicatorCode,
  allowedReviewMonths,
  scheduleUnitCodes,
  reviewersByGroup,
  usersMap,
  reviewerRoleIds,
  units,
  restrictedUnitCodes,
  restrictedUnitName,
  onImport,
  onAction,
}: {
  /** v1.88.13：目前頁面指標的代號（匯入只核對，不符整列報錯） */
  indicatorCode: string;
  /**
   * v1.88.13：該期排程的審查曆月（"yyyy/mm" 集合；未設＝尚無排程，
   * 月份無法核對，整列報錯）。
   */
  allowedReviewMonths?: ReadonlySet<string>;
  /**
   * v1.88.13：該期排程的受審單位代碼（未設＝尚無排程或排程不限單位）。
   */
  scheduleUnitCodes?: ReadonlySet<string>;
  reviewersByGroup: Map<string, ReviewerLite[]>;
  usersMap: Map<string, string>;
  reviewerRoleIds: Set<string>;
  units: UnitLite[];
  /**
   * v1.88.5：單位排程者的可匯入單位集合（僅自己單位；未設＝不設限）。
   */
  restrictedUnitCodes?: ReadonlySet<string> | null;
  /** 受限時顯示用（自己單位名稱） */
  restrictedUnitName?: string;
  onImport: (rows: ParsedAssignmentRow[]) => void;
  onAction: (m: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ValidatedAssignmentRow[] | null>(null);
  const [fileError, setFileError] = useState("");
  const [result, setResult] = useState("");
  const [importing, setImporting] = useState(false);
  const [readingFile, setReadingFile] = useState(false);

  const lookup = useMemo(
    () => ({
      userNames: usersMap,
      reviewerIds: new Set(
        [...reviewersByGroup.values()].flat().map((r) => r.personId),
      ),
      reviewerRoleIds,
      units: units.map((u) => ({ code: u.code, name: u.name })),
      // v1.88.5：受限時只允許自己單位的列；「不限單位」列亦不通過。
      allowedUnitCodes: restrictedUnitCodes ?? undefined,
      // v1.88.13：指標代號核對＋該期審查月範圍核對＋受審單位核對。
      expectedIndicatorCode: indicatorCode,
      allowedReviewMonths,
      scheduleUnitCodes,
    }),
    [reviewersByGroup, usersMap, reviewerRoleIds, units, restrictedUnitCodes, indicatorCode, allowedReviewMonths, scheduleUnitCodes],
  );

  function handlePick() {
    setFileError("");
    setResult("");
    fileRef.current?.click();
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setPreview(null);
    setResult("");
    setReadingFile(true);
    try {
      const rows = await readSheetFile(f);
      if (rows.length === 0) {
        setFileError("檔案為空");
        return;
      }
      const head = rows[0].map((c) => c.trim());
      const header = [...ASSIGNMENT_IMPORT_HEADER];
      const matched =
        head.length === header.length &&
        head.every((h, i) => h === header[i]);
      if (!matched) {
        setFileError(
          `標題列不符（應為：${header.join("、")}），請下載範例檔重新填寫`,
        );
        return;
      }
      const data = rows.slice(1);
      if (data.length === 0) {
        setFileError("檔案中沒有資料列");
        return;
      }
      setPreview(validateAssignmentImportRows(data, lookup));
    } catch (error) {
      setFileError(`讀取檔案失敗：${toErrorMessage(error)}`);
    } finally {
      setReadingFile(false);
    }
  }

  function handleConfirm() {
    if (!preview) return;
    const valid = preview.filter((p) => p.ok);
    if (valid.length === 0) {
      setFileError("沒有可匯入的資料列");
      return;
    }
    setImporting(true);
    setFileError("");
    try {
      const parsed = valid.map((p) => p.parsed!);
      onImport(parsed);
      const skipped = preview.length - valid.length;
      const message = `匯入完成：${valid.length} 筆已加入分工表${skipped > 0 ? `，跳過 ${skipped} 筆（資料有誤）` : ""}；尚未儲存，儲存分工表後才寫入`;
      setResult(message);
      onAction(message);
      setPreview(null);
    } catch (error) {
      setFileError(`匯入失敗：${toErrorMessage(error)}`);
    } finally {
      setImporting(false);
    }
  }

  const okCount = preview?.filter((p) => p.ok).length ?? 0;

  return (
    <>
      <div className="form-actions">
        <button
          className="button button-outline"
          onClick={() => {
            void downloadTemplate(ASSIGNMENT_IMPORT_SAMPLE_ROWS, "範本", "分工表匯入範例").then(
              (fmt) => {
                if (fmt === "csv")
                  onAction("Excel 元件載入失敗，已改下載 CSV 範例檔");
              },
            );
          }}
        >
          <Download size={14} />
          下載範例檔
        </button>
        <button
          className="button button-outline"
          onClick={handlePick}
          disabled={readingFile || importing}
        >
          <Upload size={14} />
          批次上傳
        </button>
      </div>
      <p className="settings-note batch-sample-note">
        匯入只寫進分工表畫面，須按「儲存分工表」才寫入；審查件數仍在「排程／單位設定」中設定。
        指標代號須與本指標一致（只核對、不跨指標匯入）；審查月份必填、須在該期審查月範圍內，超出範圍整列不匯入。
        姓名欄已移除，預覽會依職編帶出遮罩姓名供確認。
        {restrictedUnitCodes != null &&
          `僅能匯入自己單位（${restrictedUnitName || "尚未設定所屬單位"}），「不限單位」不開放。`}
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        hidden
        onChange={handleFile}
      />
      {fileError && <div className="login-error">{fileError}</div>}
      {readingFile && (
        <p className="settings-note" role="status">
          讀取檔案中…
        </p>
      )}
      {result && <p className="settings-note">{result}</p>}
      {preview && (
        <section className="panel data-panel import-preview">
          <div className="panel-inset">
            <SectionTitle
              title={`匯入預覽（共 ${preview.length} 筆，可匯入 ${okCount} 筆）`}
              note="僅「通過」的資料列會被匯入"
            />
          </div>
          <div className="table-scroll">
            <table className="permission-table">
              <thead>
                <tr>
                  <th>列</th>
                  {[...ASSIGNMENT_IMPORT_HEADER].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                  <th>姓名（依職編帶出）</th>
                  <th>狀態</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((p) => (
                  <tr key={p.index}>
                    <td>{p.index}</td>
                    {[...ASSIGNMENT_IMPORT_HEADER].map((_, i) => (
                      <td key={i}>{p.values[i] ?? ""}</td>
                    ))}
                    <td>
                      {maskName(usersMap.get(String(p.values[1] ?? "").trim()) ?? "") || "—"}
                    </td>
                    <td>
                      <span
                        className={`status-pill ${p.ok ? "success" : "danger"}`}
                      >
                        {p.ok ? "通過" : "錯誤"}
                      </span>
                    </td>
                    <td>{p.error || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel-inset">
            <div className="form-actions">
              <button
                className="button button-primary"
                disabled={importing || okCount === 0}
                onClick={handleConfirm}
              >
                {importing ? "匯入中…" : `確認匯入（${okCount} 筆）`}
              </button>
              <button
                className="button button-outline"
                onClick={() => setPreview(null)}
              >
                取消
              </button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
