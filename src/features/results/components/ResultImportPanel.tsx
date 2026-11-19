import { type ResultImportRowResult, filterImportIndicators, importIndicatorEmptyHint, resultTemplateRows, parseResultSheet, validateResultSheet, importIdentityDocId } from "../../../lib/import";
import type { IndicatorOpt } from "../model/types";
import { useState, useRef, useEffect, useMemo } from "react";
import { loadRefCollection } from "../../../lib/refLoad";
import { downloadTemplate, readSheetFile } from "../../../lib/sheetFile";
import { getFirebaseDb } from "../../../lib/firebase";
import { getDoc, doc, writeBatch, collection, serverTimestamp } from "../../../lib/db";
import { toErrorMessage } from "../../../lib/errors";
import { computeOptionSetScore } from "../../../lib/reviewRecords";
import { logAudit } from "../../../lib/audit";
import { SectionTitle, FormSelect } from "../../../components/ui";
import { ChevronDown, Download, Upload } from "lucide-react";
import { staffLabel } from "../../../lib/mask";

/* ================= 品管審查結果匯入（v1.21.0 邏輯原樣搬入頁籤） ================= */

/**
 * 匯入預覽列（v1.47.0）：選檔後先預覽、不直接寫入；硬錯誤列不能匯入，
 * 軟錯誤列由匯入者逐列勾選「仍要匯入」才寫入。
 */
export interface ImportPreviewRow {
  lineNo: number;
  unitCode: string;
  monthRaw: string;
  reviewerId: string;
  personEmpNo: string;
  /** 審核項目（v1.48.0）：該列的值，無此欄為 "" */
  auditItem: string;
  errors: string[];
  softErrors: string[];
  /** 該列將覆寫既有同一身分紀錄（指標＋單位＋年＋月＋受審人職編＋審核項目） */
  willOverwrite: boolean;
  /** 軟錯誤列是否仍要匯入（預設不勾） */
  forceImport: boolean;
  values: NonNullable<ResultImportRowResult["values"]> | null;
}

/**
 * 各指標審查結果匯入：選組別→選指標（只列啟用）→選檔匯入。
 * 範本依所選指標審查表題目即時產生（前 6 欄固定＋每題一欄）。
 * 預檢：指標代號與題數不符即整檔中止；逐列未填忽略、非法值該列跳過。
 * 每列寫一筆 reviewRecord（source="import"，不自動建 reviewTasks），
 * 計入審核進度（unitId／year／month 參與進度計算）。
 * v1.47.0：選檔後先顯示預覽／錯誤清單，按「確認匯入」才寫入；去重鍵
 * 改為身分鍵（指標＋單位＋年＋月＋受審人職編），重複即覆寫。
 * v1.48.0：指標有設審核項目時，範本與檔案多一欄「審核項目」（床號之後、
 * 第 7 欄），必填且須為清單內的值；去重身分鍵納入審核項目。
 */
export function ResultImportPanel({
  indicators,
  indicatorsLoaded,
  user,
  onAction,
  onDone,
}: {
  indicators: IndicatorOpt[];
  /** 指標參考資料是否已載入完成（v1.43.1：未完成前不顯示下拉為空的診斷提示）。 */
  indicatorsLoaded: boolean;
  user: { staffId: string; name: string } | null;
  onAction: (m: string) => void;
  onDone: (years: number[]) => void;
}) {
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [unitCodes, setUnitCodes] = useState<Set<string>>(new Set());
  const [staffMap, setStaffMap] = useState<Map<string, string>>(new Map());
  const [staffLoaded, setStaffLoaded] = useState(false);
  const [selGroup, setSelGroup] = useState("");
  const [selIndicatorId, setSelIndicatorId] = useState("");
  const [summary, setSummary] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  /** 匯入預覽（v1.47.0）：選檔後先預覽，按「確認匯入」才寫入 */
  const [preview, setPreview] = useState<ImportPreviewRow[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const [gSnap, uSnap, sSnap] = await Promise.all([
          loadRefCollection("groups"),
          loadRefCollection("units"),
          loadRefCollection("users"),
        ]);
        setGroups(
          gSnap.docs
            .map((d) => ({
              id: d.id,
              name:
                typeof d.data().name === "string" ? d.data().name : d.id,
            }))
            .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")),
        );
        setUnitCodes(new Set(uSnap.docs.map((d) => d.id)));
        const sm = new Map<string, string>();
        sSnap.docs.forEach((d) => {
          const name = d.data().name;
          sm.set(d.id, typeof name === "string" ? name : d.id);
        });
        setStaffMap(sm);
        setStaffLoaded(true);
      } catch {
        setStaffLoaded(false);
      }
    })();
  }, []);

  // v1.43.1：指標下拉只列啟用指標、依所選組別過濾（純函式在 lib/import，
  // 單測覆蓋）。為空時顯示診斷提示而非靜默空白——原因只可能是資料面。
  const enabledByGroup = useMemo(
    () => filterImportIndicators(indicators, selGroup),
    [indicators, selGroup],
  );
  const indicatorHint = indicatorsLoaded
    ? importIndicatorEmptyHint(indicators, selGroup)
    : null;
  const selInd = indicators.find((i) => i.id === selIndicatorId) ?? null;

  function handleGroupChange(groupId: string) {
    setSelGroup(groupId);
    setSelIndicatorId("");
    setSummary(null);
    setErrors([]);
    setPreview(null);
  }

  function handleIndicatorChange(id: string) {
    setSelIndicatorId(id);
    setSummary(null);
    setErrors([]);
    setPreview(null);
  }

  function downloadCurrentTemplate() {
    if (!selInd) return;
    // v1.28 階段 5：downloadTemplate 為 async；xlsx 元件載入失敗時退回 CSV，提示使用者
    void downloadTemplate(
      resultTemplateRows(
        selInd.code,
        selInd.questions.map((q) => q.itemText),
        selInd.auditItems,
      ),
      "審查結果",
      `${selInd.code}_審查結果範本`,
    ).then((fmt) => {
      if (fmt === "csv") onAction("Excel 元件載入失敗，已改下載 CSV 範本");
    });
  }

  /** v1.47.0 預覽階段：選檔後先驗證、顯示預覽／錯誤清單，不直接寫入。 */
  async function handleImport(file: File) {
    if (!selInd || !user) return;
    setSummary(null);
    setErrors([]);
    setPreview(null);
    setBusy(true);
    try {
      const sheet = await readSheetFile(file);
      const { headerErrors, hasAuditItemColumn, data } = parseResultSheet(
        sheet,
        {
          questionTitles: selInd.questions.map((q) => q.itemText),
          auditItems: selInd.auditItems,
        },
      );
      if (headerErrors.length > 0) {
        setErrors(headerErrors);
        onAction("審查結果匯入失敗：標題列不符，請下載範本對照");
        return;
      }
      if (data.length === 0) {
        setErrors(["檔案內無資料列"]);
        return;
      }
      const { fileErrors, rows } = validateResultSheet(data, {
        code: selInd.code,
        questionCount: selInd.questions.length,
        unitHas: (c) => unitCodes.has(c),
        staffHas: (id) => staffMap.has(id),
        staffLoaded,
        auditItems: selInd.auditItems,
        hasAuditItemColumn,
      });
      if (fileErrors.length > 0) {
        setErrors(fileErrors);
        onAction("審查結果匯入中止：預檢不符（指標代號或題數）");
        return;
      }
      // 覆寫預查：身分鍵（指標＋單位＋年＋月＋受審人職編＋審核項目，
      // v1.48.0 納入審核項目；空值時與 v1.47.0 相同）已存在即覆寫；
      // 同一檔案內重複身分者，後者亦覆寫前者。
      const db = getFirebaseDb();
      const seenIds = new Set<string>();
      const previewRows: ImportPreviewRow[] = await Promise.all(
        rows.map(async (r) => {
          let willOverwrite = false;
          if (r.values) {
            const docId = importIdentityDocId({
              indicatorId: selInd.id,
              unitCode: r.values.unitCode,
              year: r.values.year,
              month: r.values.month,
              personEmpNo: r.values.personEmpNo,
              auditItem: r.values.auditItem,
            });
            if (seenIds.has(docId)) {
              willOverwrite = true;
            } else {
              seenIds.add(docId);
              try {
                const snap = await getDoc(doc(db, "reviewRecords", docId));
                willOverwrite = snap.exists();
              } catch {
                willOverwrite = false;
              }
            }
          }
          return {
            lineNo: r.lineNo,
            unitCode: r.unitCode,
            monthRaw: r.monthRaw,
            reviewerId: r.reviewerId,
            personEmpNo: r.personEmpNo,
            auditItem: r.auditItem,
            errors: r.errors,
            softErrors: r.softErrors,
            willOverwrite,
            forceImport: false,
            values: r.values,
          };
        }),
      );
      setPreview(previewRows);
      const writable = previewRows.filter(
        (r) => r.values && r.errors.length === 0,
      ).length;
      const badCount = previewRows.filter(
        (r) => r.errors.length > 0,
      ).length;
      const overwriteCount = previewRows.filter(
        (r) => r.values && r.errors.length === 0 && r.willOverwrite,
      ).length;
      setSummary(
        `預覽：共 ${previewRows.length} 列，可匯入 ${writable} 列、錯誤 ${badCount} 列` +
          (overwriteCount > 0
            ? `、其中 ${overwriteCount} 列將覆蓋既有資料`
            : "") +
          "。請確認後按「確認匯入」寫入；軟錯誤列須逐列勾選「仍要匯入」才會寫入。",
      );
    } catch (error) {
      setErrors([
        `讀取檔案失敗：${toErrorMessage(error, "讀寫失敗")}`,
      ]);
    } finally {
      setBusy(false);
    }
  }

  /** v1.47.0 確認匯入：只寫入無硬錯誤的列；軟錯誤列須逐列勾選才寫入。 */
  async function confirmImport() {
    if (!selInd || !user || !preview) return;
    const toWrite = preview.filter(
      (r) =>
        r.values &&
        r.errors.length === 0 &&
        (r.softErrors.length === 0 || r.forceImport),
    );
    if (toWrite.length === 0) return;
    const skipped = preview.length - toWrite.length;
    const hardErrorRows = preview.filter((r) => r.errors.length > 0);
    setBusy(true);
    try {
      const db = getFirebaseDb();
      // v1.47.0 去重：身分鍵（指標＋單位＋年＋月＋受審人職編）決定文件 ID，
      // 同一身分再匯即覆寫，不重複建檔；每 500 筆分段提交（batch 上限）。
      // v1.48.0：身分鍵納入審核項目（空值時與 v1.47.0 相同）。
      const today = new Date().toISOString().slice(0, 10);
      let batch = writeBatch(db);
      let pending = 0;
      const flush = async () => {
        if (pending > 0) {
          await batch.commit();
          batch = writeBatch(db);
          pending = 0;
        }
      };
      let overwritten = 0;
      for (const r of toWrite) {
        const v = r.values!;
        if (r.willOverwrite) overwritten += 1;
        const answers = selInd.questions.map((q, i) => {
          const label = v.answers[i] ?? "";
          const excluded = label === "不適用" || label === "";
          const note = (v.notes[i] ?? "").trim();
          return {
            questionId: q.id,
            itemText: q.itemText,
            optionLabel: label,
            score: label === "是" ? 1 : 0,
            excluded,
            ...(note ? { note } : {}),
          };
        });
        const { totalScore, maxScore, rate } = computeOptionSetScore(
          answers.map((a) => ({ score: a.score, excluded: a.excluded })),
        );
        const ref = doc(
          collection(db, "reviewRecords"),
          importIdentityDocId({
            indicatorId: selInd.id,
            unitCode: v.unitCode,
            year: v.year,
            month: v.month,
            personEmpNo: v.personEmpNo,
            auditItem: v.auditItem,
          }),
        );
        batch.set(ref, {
          taskId: "",
          indicatorId: selInd.id,
          unitId: v.unitCode,
          reviewerId: v.reviewerId,
          year: v.year,
          month: v.month,
          caseSeq: null,
          reviewDate: today,
          reviewerEmpNo: v.reviewerId,
          reviewerName: v.reviewerId
            ? (staffMap.get(v.reviewerId) ?? v.reviewerId)
            : "",
          reviewedPersonEmpNo: v.personEmpNo,
          reviewedPersonName: v.personEmpNo
            ? (staffMap.get(v.personEmpNo) ?? v.personEmpNo)
            : "",
          bedNo: v.bedNo,
          // v1.48.0：審核項目有值才寫、無值不寫欄位（維持 auditItem? 選填語義）
          ...(v.auditItem ? { auditItem: v.auditItem } : {}),
          answers,
          totalScore,
          maxScore,
          rate,
          submittedAt: serverTimestamp(),
          submittedBy: user.staffId,
          source: "import",
        });
        pending++;
        if (pending >= 500) await flush();
      }
      await flush();
      // 覆寫不留痕（v1.47.0 拍板）；稽核只記總數與覆寫筆數。
      logAudit(db, {
        actor: user.staffId,
        actorName: user.name,
        action: "匯入品管審查結果",
        targetType: "indicator",
        targetId: selInd.id,
        detail: `${selInd.code}：匯入 ${toWrite.length} 筆（其中資料重複已覆蓋 ${overwritten} 筆）、跳過 ${skipped} 列`,
      });
      const msg =
        `審查結果匯入：成功 ${toWrite.length} 筆` +
        (overwritten > 0 ? `（其中資料重複已覆蓋 ${overwritten} 筆）` : "") +
        `、跳過 ${skipped} 列`;
      setPreview(null);
      setErrors(
        hardErrorRows.map(
          (r) => `第 ${r.lineNo} 列：${r.errors.join("；")}`,
        ),
      );
      setSummary(msg);
      onAction(msg);
      onDone([...new Set(toWrite.map((r) => r.values!.year))]);
    } catch (error) {
      setErrors([
        `匯入失敗：${toErrorMessage(error, "讀寫失敗")}`,
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <SectionTitle
        title="匯入品管審查結果"
        note="先選組別與指標（只列啟用），再選 Excel／CSV 檔匯入。預檢不符（指標代號或題數）即整檔中止；選檔後先顯示預覽／錯誤清單，按「確認匯入」才寫入。匯入的紀錄計入審核進度，不自動建立審查任務。指標有設審核項目時，範本多一欄「審核項目」（必填，須為指標清單內的值）。同一指標、單位、月份、受審人員、審核項目重複匯入以後者覆蓋前者，不會重複建檔。"
      />
      <div className="form-stack results-import-filters">
        <FormSelect label="組別" value={selGroup}
              onChange={(e) => handleGroupChange(e.target.value)}>
              <option value="">全部組別</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </FormSelect>
        <div className="form-field">
          <label className="field-label">指標（只列啟用）</label>
          <div className="select-wrap">
            <select
              value={selIndicatorId}
              onChange={(e) => handleIndicatorChange(e.target.value)}
            >
              <option value="">請選擇指標</option>
              {enabledByGroup.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.code}・{i.name}（{i.questions.length} 題）
                </option>
              ))}
            </select>
            <ChevronDown size={15} />
          </div>
          {indicatorHint ? (
            <p className="field-hint">{indicatorHint}</p>
          ) : null}
        </div>
      </div>
      <div className="batch-toolbar">
        <button
          className="button button-outline button-sm"
          disabled={!selInd}
          onClick={downloadCurrentTemplate}
        >
          <Download size={14} /> 下載範本（依該指標題目產生）
        </button>
        <button
          className="button button-outline button-sm"
          disabled={!selInd || busy}
          onClick={() => fileRef.current?.click()}
        >
          <Upload size={14} /> 選擇檔案匯入
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          style={{ display: "none" }}
          aria-label="匯入審查結果檔案"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void handleImport(f);
          }}
        />
      </div>
      {preview && (
        <div style={{ marginTop: 12 }}>
          <div className="batch-toolbar" style={{ marginBottom: 8 }}>
            <button
              className="button button-primary button-sm"
              disabled={
                busy ||
                preview.filter(
                  (r) =>
                    r.values &&
                    r.errors.length === 0 &&
                    (r.softErrors.length === 0 || r.forceImport),
                ).length === 0
              }
              onClick={() => void confirmImport()}
            >
              確認匯入（
              {preview.filter(
                (r) =>
                  r.values &&
                  r.errors.length === 0 &&
                  (r.softErrors.length === 0 || r.forceImport),
              ).length}{" "}
              筆）
            </button>
            <button
              className="button button-outline button-sm"
              disabled={busy}
              onClick={() => {
                setPreview(null);
                setSummary(null);
              }}
            >
              取消
            </button>
            {preview.some(
              (r) => r.softErrors.length > 0 && r.errors.length === 0,
            ) && (
              <label
                style={{ display: "flex", alignItems: "center", gap: 4 }}
              >
                <input
                  type="checkbox"
                  checked={preview
                    .filter(
                      (r) =>
                        r.softErrors.length > 0 && r.errors.length === 0,
                    )
                    .every((r) => r.forceImport)}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setPreview((prev) =>
                      prev
                        ? prev.map((r) =>
                            r.softErrors.length > 0 && r.errors.length === 0
                              ? { ...r, forceImport: checked }
                              : r,
                          )
                        : prev,
                    );
                  }}
                />
                軟錯誤列全部仍要匯入
              </label>
            )}
          </div>
          <div style={{ maxHeight: 320, overflow: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>列</th>
                  <th>受審單位</th>
                  <th>審查月份</th>
                  <th>審查員</th>
                  <th>受審人員</th>
                  <th>審核項目</th>
                  <th>狀態</th>
                  <th>原因</th>
                  <th>仍要匯入</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((r) => {
                  const status =
                    r.errors.length > 0
                      ? "錯誤，不匯入"
                      : r.willOverwrite
                        ? "可匯入（將覆蓋既有資料）"
                        : "可匯入";
                  const reasons = [...r.errors, ...r.softErrors].join("；");
                  const canForce =
                    r.errors.length === 0 && r.softErrors.length > 0;
                  return (
                    <tr key={r.lineNo}>
                      <td>{r.lineNo}</td>
                      <td>{r.unitCode || "—"}</td>
                      <td>{r.monthRaw || "—"}</td>
                      <td>{staffLabel(r.reviewerId, staffMap.get(r.reviewerId) ?? "")}</td>
                      <td>{staffLabel(r.personEmpNo, staffMap.get(r.personEmpNo) ?? "")}</td>
                      <td>{r.auditItem || "—"}</td>
                      <td>{status}</td>
                      <td>{reasons || "—"}</td>
                      <td>
                        {canForce ? (
                          <input
                            type="checkbox"
                            aria-label={`第 ${r.lineNo} 列仍要匯入`}
                            checked={r.forceImport}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setPreview((prev) =>
                                prev
                                  ? prev.map((x) =>
                                      x.lineNo === r.lineNo
                                        ? { ...x, forceImport: checked }
                                        : x,
                                    )
                                  : prev,
                              );
                            }}
                          />
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {summary && (
        <p className="settings-note" role="status">
          {summary}
        </p>
      )}
      {errors.length > 0 && (
        <div style={{ maxHeight: 160, overflow: "auto", marginBottom: 8 }}>
          {errors.map((msg, i) => (
            <div key={i} className="field-error">
              {msg}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
