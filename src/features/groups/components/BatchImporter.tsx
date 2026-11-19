import type { PreviewRow } from "../model/types";
import { useRef, useState } from "react";
import { readSheetFile, downloadTemplate } from "../../../lib/sheetFile";
import { toErrorMessage } from "../../../lib/errors";
import { Download, Upload } from "lucide-react";
import { SectionTitle } from "../../../components/ui";
import { maskName } from "../../../lib/mask";

// ================= 批次上傳共用元件 =================

export function BatchImporter({
  sampleBaseName,
  sampleRows,
  header,
  validateRows,
  importRows,
  sampleNote,
  postImportNote,
  onDone,
  onAction,
}: {
  sampleBaseName: string;
  sampleRows: string[][];
  header: string[];
  validateRows: (rows: string[][]) => Promise<PreviewRow[]>;
  /** 回傳摘要字串時以該字串為匯入結果訊息（新增／更新筆數） */
  importRows: (rows: PreviewRow[]) => Promise<string | void>;
  sampleNote?: string;
  postImportNote?: string;
  onDone: () => void | Promise<void>;
  onAction: (message: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [fileError, setFileError] = useState("");
  const [result, setResult] = useState("");
  const [importing, setImporting] = useState(false);
  // v1.28 階段 5（A2）：xlsx 動態載入，首次讀 .xlsx 檔要多等一次 chunk 下載，顯示讀取中
  const [readingFile, setReadingFile] = useState(false);

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
      // v1.21：Excel／CSV 皆可（.xlsx 走 SheetJS，.csv 走自寫解析）
      const rows = await readSheetFile(f);
      if (rows.length === 0) {
        setFileError("檔案為空");
        return;
      }
      const head = rows[0].map((c) => c.trim());
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
      setPreview(await validateRows(data));
    } catch (error) {
      setFileError(`讀取檔案失敗：${toErrorMessage(error)}`);
    } finally {
      setReadingFile(false);
    }
  }

  async function handleConfirm() {
    if (!preview) return;
    const valid = preview.filter((p) => p.ok);
    if (valid.length === 0) {
      setFileError("沒有可匯入的資料列");
      return;
    }
    setImporting(true);
    setFileError("");
    try {
      const summary = await importRows(valid);
      const skipped = preview.length - valid.length;
      const message =
        summary ||
        `匯入完成：成功 ${valid.length} 筆${skipped > 0 ? `，跳過 ${skipped} 筆（資料有誤）` : ""}`;
      setResult(message);
      onAction(message);
      setPreview(null);
      await onDone();
    } catch (error) {
      setFileError(`匯入失敗：${toErrorMessage(error)}`);
    } finally {
      setImporting(false);
    }
  }

  const okCount = preview?.filter((p) => p.ok).length ?? 0;

  return (
    <>
      <button
        className="button button-outline"
        onClick={() => {
          // v1.28 階段 5：downloadTemplate 為 async；xlsx 元件載入失敗時退回 CSV，提示使用者
          void downloadTemplate(sampleRows, "範本", sampleBaseName).then(
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
      {sampleNote && <p className="settings-note batch-sample-note">{sampleNote}</p>}
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
      {postImportNote && result && (
        <p className="settings-note">{postImportNote}</p>
      )}
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
                  {header.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                  <th>狀態</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((p) => (
                  <tr key={p.index}>
                    <td>{p.index}</td>
                    {header.map((h, i) => (
                      <td key={i}>
                        {h === "姓名"
                          ? maskName(String(p.values[i] ?? ""))
                          : (p.values[i] ?? "")}
                      </td>
                    ))}
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
