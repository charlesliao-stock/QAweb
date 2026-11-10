#!/usr/bin/env node
/**
 * Google Sheet 定時同步 — 執行檔（v1.42.0；v1.42.1 加確認關卡＋手動測試）。
 *
 * GitHub Actions 每日 07:00 台北時間執行（.github/workflows/sheet-sync.yml），
 * 另可 workflow_dispatch 手動觸發（可指定單一 mappingId）。
 *
 * 手動同步（v1.42.2）：前端 [手動同步一次] 寫入 sheetSyncRequests（pending），
 * 另一個 workflow（sheet-sync-poll.yml）每 5 分鐘以 SYNC_REQUESTS_ONLY=1
 * 執行本檔的請求模式：只取 pending 請求，逐一標記 running 後執行
 * syncMapping（草稿亦可跑，與手動觸發同規則），完成標記 done＋runId，
 * 失敗標記 failed＋error；run 紀錄 trigger 記 manual。請求模式不跑定時排程。
 *
 * 標題讀取（v1.42.3）：前端 [連線確認]／[重新讀取欄位] 設 headerFetchRequestedAt，
 * 請求模式每 5 分鐘一併處理待讀取標題的對照（fetchHeadersOnly：只讀標題列＋
 * 前 3 列預覽，不寫入審查紀錄），讀到後寫回 detectedHeaders 與對應建議；
 * 讀取失敗時把原因寫回 headerFetchError（前端步驟 1 顯示），不發 LINE、不讓
 * 整輪失敗（常見失敗是 Sheet 尚未分享給 service account，屬使用者待辦）。
 * 完整同步（syncMapping）讀到標題時同樣會清掉 headerFetchRequestedAt。
 * 對應合併後與原本不同時，兩處皆寫 fieldMappingUpdatedAt（步驟 3 的手動同步
 * 成功紀錄須在此時間之後才算數，對應改過就要重跑手動同步）。
 *
 * 確認關卡（v1.42.1）：定時排程只跑 status == "confirmed" 且啟用的對照；
 * 草稿跳過並寫 run 紀錄記下跳過原因，不寫入審查紀錄。手動觸發指定單一對照時
 * 草稿亦可跑（測試連結用）；手動同步為選用步驟，不強制成功才能確認排程。
 * 讀標題列時一併讀前 3 列資料列、用目前對應解析後寫回對照 preview 供核對。
 *
 * 流程（每份啟用的 sheetSyncMappings）：
 * 1. 讀試算表 metadata 找分頁（依 sheetName 或 sheetGid），讀全部值。
 * 2. 標題列 → 自動欄位對應（與前端同規則）；對應缺必要欄 → 只更新對照、
 *    寫 run 紀錄 status "mapping-incomplete"，不寫入紀錄。
 * 3. 逐列檢核（重用 sheet-sync-lib.mjs，與前端 validateResultSheet 同規則）：
 *    受審單位／人員須存在、月份合法、答案須為 是／否／不適用。
 * 4. 去重（內容雜湊 → import_＋雜湊前綴文件 ID）：
 *    同一列重複同步即 upsert；內容不變跳過；內容變了 → 刪舊雜湊文件、
 *    寫新文件並寫 auditLogs；列被刪除 → 保留系統內紀錄（只在 run 紀錄標註）。
 * 5. 快照欄位：優先抄同一指標＋單位＋月份的 reviewTasks，否則用指標當下
 *    版本與閾值並標註 snapshotSource。
 * 6. 每次執行寫 sheetSyncRuns 紀錄；任一對照失敗 → LINE 推播、exit 1，
 *    單一對照失敗不影響其他對照。
 *
 * 寫入方式：Firestore REST documents.patch（逐筆 upsert；batchWrite 的
 * update 在文件不存在時會失敗，不可用於 upsert），併發 8。
 * 讀取惰性驗證：單位／人員／指標全量各讀 1 次；reviewTasks 依 (指標,單位,
 * 年,月) 查詢並快取（4 個等值條件，zigzag merge join，不需複合索引）。
 *
 * 環境變數（只從 GitHub Secrets 注入，絕不寫進檔案）：
 * - GCP_SERVICE_ACCOUNT_JSON（必填）：service account JSON
 *   （角色：Datastore User；須在 GCP 啟用 Sheets API；Sheet 須分享給該
 *   service account email、檢視者即可）
 * - LINE_CHANNEL_ACCESS_TOKEN（選填，未設則只記錄、不發 LINE）
 * - LINE_USER_ID（選填，未設則不發 LINE）
 * - GCP_PROJECT_ID（選填，預設 nurseboard-492316）
 * - MAPPING_ID（選填，workflow_dispatch 指定單一對照時用）
 * - SYNC_REQUESTS_ONLY（選填，設為 "1" 時只處理手動同步請求，不跑定時排程；
 *   供 sheet-sync-poll.yml 每 5 分鐘輪詢用）
 *
 * 本檔只用 Node 內建模組（node:crypto＋fetch），不需 npm install。
 */
import { createSign } from "node:crypto";
import {
  autoFieldMapping,
  buildMappingPreview,
  buildSyncRecord,
  cellToString,
  decodeFirestoreDoc,
  encodeFirestoreFields,
  isMappingConfirmed,
  mappingMissingRequired,
  sameFieldMapping,
  selectHeaderFetchTargets,
  selectPendingRequests,
  selectSyncTargets,
  syncStateDocId,
} from "./sheet-sync-lib.mjs";

const PROJECT = process.env.GCP_PROJECT_ID ?? "nurseboard-492316";
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const WRITE_CONCURRENCY = 8;

function log(msg) {
  console.log(`[sheet-sync] ${msg}`);
}

async function fetchJson(url, token, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${url.split("?")[0]}：${body.slice(0, 300)}`);
  }
  return res.json();
}

/** service account JWT → OAuth2 access token（sheets.readonly＋datastore）。 */
async function getAccessToken(sa) {
  const nowSec = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", typ: "JWT", kid: sa.private_key_id })}.${enc({
    iss: sa.client_email,
    scope:
      "https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    exp: nowSec + 3600,
    iat: nowSec,
  })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${sig}`,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`取 OAuth token 失敗：HTTP ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error("取 OAuth token 失敗：無 access_token");
  return data.access_token;
}

/** LINE 推播（失敗只記錄、不讓整輪同步失敗）。 */
async function sendLine(text, token, to) {
  if (!token || !to) {
    log("LINE secret 未設定，跳過推播。");
    return false;
  }
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      log(`LINE 推播失敗：HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    log(`LINE 推播失敗：${err.message}`);
    return false;
  }
}

/* ================= Firestore REST ================= */

function docIdFromName(name) {
  return String(name ?? "").split("/").pop();
}

async function fsGetDoc(path, token) {
  const res = await fetch(`${FS_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore 讀取失敗 ${path}：HTTP ${res.status}`);
  return decodeFirestoreDoc(await res.json());
}

async function fsListCollection(collection, token) {
  const out = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ pageSize: "1000" });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetchJson(`${FS_BASE}/${collection}?${params}`, token);
    for (const d of res.documents ?? []) {
      const decoded = decodeFirestoreDoc(d);
      if (decoded) out.push({ id: docIdFromName(d.name), ...decoded });
    }
    pageToken = res.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

/**
 * documents.patch：不存在即建立（upsert）。
 * 無 updateMask＝整份覆寫（reviewRecords／sheetSyncState／sheetSyncRuns 用）；
 * 傳 maskFields＝只更新列出的欄位（sheetSyncMappings 部分更新用，避免洗掉其他欄位）。
 */
async function fsPatchDoc(path, values, token, maskFields) {
  let url = `${FS_BASE}/${path}`;
  if (maskFields && maskFields.length > 0) {
    const mask = maskFields
      .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
      .join("&");
    url += `?${mask}`;
  }
  await fetchJson(url, token, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(encodeFirestoreFields(values)),
  });
}

async function fsDeleteDoc(path, token) {
  const res = await fetch(`${FS_BASE}/${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status !== 404 && !res.ok) {
    throw new Error(`Firestore 刪除失敗 ${path}：HTTP ${res.status}`);
  }
}

/** documents.create：自動 ID（auditLogs 用）。 */
async function fsCreateDoc(collection, values, token) {
  await fetchJson(`${FS_BASE}/${collection}`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(encodeFirestoreFields(values)),
  });
}

async function fsBatchGet(paths, token) {
  const out = new Map();
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const res = await fetchJson(`${FS_BASE}:batchGet`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documents: chunk.map((p) => `${FS_BASE}/${p}`),
      }),
    });
    for (const item of res ?? []) {
      if (item.found) {
        out.set(docIdFromName(item.found.name), decodeFirestoreDoc(item.found));
      }
    }
  }
  return out;
}

async function fsRunQuery(structuredQuery, token) {
  const res = await fetchJson(`${FS_BASE}:runQuery`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery }),
  });
  const out = [];
  for (const item of res ?? []) {
    if (item.document) {
      const decoded = decodeFirestoreDoc(item.document);
      if (decoded) out.push({ id: docIdFromName(item.document.name), ...decoded });
    }
  }
  return out;
}

/* ================= Sheets API ================= */

async function sheetsMetadata(spreadsheetId, token) {
  return fetchJson(`${SHEETS_BASE}/${spreadsheetId}`, token);
}

async function sheetsValues(spreadsheetId, range, token) {
  const data = await fetchJson(
    `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`,
    token,
  );
  return data.values ?? [];
}

/* ================= 併發池 ================= */

async function runPool(tasks, limit) {
  const results = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/* ================= 單一對照同步 ================= */

async function syncMapping(mapping, ctx) {
  const { token, indicators, unitHas, staffHas, staffName, taskCache, trigger } = ctx;
  const now = new Date();
  const runId = `run_${mapping.id}_${now.toISOString().replace(/[-:.]/g, "").slice(0, 15)}`;
  const run = {
    mappingId: mapping.id,
    trigger,
    startedAt: now,
    finishedAt: null,
    rowsRead: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errorRows: [],
    status: "ok",
    error: "",
  };
  const writeRun = async () => {
    await fsPatchDoc(`sheetSyncRuns/${runId}`, run, token);
  };

  const indicator = indicators.get(mapping.indicatorId);
  if (!indicator) {
    run.status = "failed";
    run.error = `指標不存在：${mapping.indicatorId}`;
    await writeRun();
    const err = new Error(run.error);
    err.runId = runId;
    throw err;
  }
  const questions = (indicator.questions ?? []).map((q) => q.itemText ?? "");

  // 1. 找分頁、讀值
  const meta = await sheetsMetadata(mapping.spreadsheetId, token);
  const sheets = meta.sheets ?? [];
  let sheetTitle = mapping.sheetName;
  if (mapping.sheetGid) {
    const byGid = sheets.find(
      (s) => String(s.properties?.sheetId) === String(mapping.sheetGid),
    );
    if (byGid) sheetTitle = byGid.properties.title;
  }
  const found = sheets.some((s) => s.properties?.title === sheetTitle);
  if (!found) {
    run.status = "failed";
    run.error = `試算表內找不到分頁「${sheetTitle}」`;
    await writeRun();
    const err = new Error(run.error);
    err.runId = runId;
    throw err;
  }
  const range = `'${sheetTitle.replace(/'/g, "''")}'!A1:ZZ10000`;
  const values = await sheetsValues(mapping.spreadsheetId, range, token);
  if (values.length === 0) {
    run.status = "ok";
    run.rowsRead = 0;
    run.finishedAt = new Date();
    await writeRun();
    await fsPatchDoc(
      `sheetSyncMappings/${mapping.id}`,
      { lastSyncAt: now, updatedAt: now },
      token,
      ["lastSyncAt", "updatedAt"],
    );
    log(`對照 ${mapping.sheetName}：試算表無資料。`);
    return { run, runId };
  }
  const headers = values[0].map((h) => cellToString(h));
  const dataRows = values.slice(1);
  run.rowsRead = dataRows.filter((r) => r.some((c) => cellToString(c) !== "")).length;

  // 2. 欄位對應（自動＋既有手動對應；既有非空值優先）
  const auto = autoFieldMapping(headers, questions);
  const merged = { ...auto };
  for (const [h, v] of Object.entries(mapping.fieldMapping ?? {})) {
    if (v) merged[h] = v;
  }
  const missing = mappingMissingRequired(merged, questions);
  // 對應預覽（v1.42.1）：前 3 列資料列用目前對應解析，供使用者核對對應正確；
  // 對應未完成時也寫回，讓使用者看到哪幾列、哪個欄位有問題。
  const preview = buildMappingPreview({
    headers,
    rows: dataRows,
    fieldMapping: merged,
    indicator,
    unitHas,
    staffHas,
    staffName,
  });
  const mappingPatch = {
    detectedHeaders: headers,
    fieldMapping: merged,
    readiness: missing.length > 0 ? "mapping-incomplete" : "ready",
    preview,
    previewAt: now,
    lastHeaderFetchAt: now,
    headerFetchRequestedAt: null,
    updatedAt: now,
  };
  const mappingMask = [
    "detectedHeaders",
    "fieldMapping",
    "readiness",
    "preview",
    "previewAt",
    "lastHeaderFetchAt",
    "headerFetchRequestedAt",
    "updatedAt",
  ];
  // 對應合併後與原本不同（新標題自動對上）：寫 fieldMappingUpdatedAt，
  // 步驟 3 的手動同步成功紀錄須在此時間之後才算數（對應改過要重跑手動同步）。
  if (!sameFieldMapping(merged, mapping.fieldMapping ?? {})) {
    mappingPatch.fieldMappingUpdatedAt = now;
    mappingMask.push("fieldMappingUpdatedAt");
  }
  await fsPatchDoc(`sheetSyncMappings/${mapping.id}`, mappingPatch, token, mappingMask);
  if (missing.length > 0) {
    run.status = "mapping-incomplete";
    run.error = `對應缺必要欄位：${missing.join("、")}`;
    run.finishedAt = new Date();
    await writeRun();
    log(`對照 ${mapping.sheetName}：對應未完成（${run.error}），跳過寫入。`);
    return { run, runId };
  }

  // 3. 逐列檢核＋去重分類
  const valid = [];
  const errorRows = [];
  for (let i = 0; i < dataRows.length; i++) {
    const cells = dataRows[i];
    if (cells.every((c) => cellToString(c) === "")) continue;
    const lineNo = i + 2;
    // 任務快照：同一指標＋單位＋月份（需先有年月才查得到；無年月時先用月份欄／時間戳記試算）
    const tmp = buildSyncRecord({
      mapping: { ...mapping, fieldMapping: merged },
      headers,
      rowCells: cells,
      indicator,
      unitHas,
      staffHas,
      staffName,
      taskSnapshot: null,
    });
    if (!tmp.ok) {
      errorRows.push({ lineNo, errors: tmp.errors.join("；") });
      continue;
    }
    const snapKey = `${indicator.id}|${tmp.record.unitId}|${tmp.record.year}|${tmp.record.month}`;
    if (!taskCache.has(snapKey)) {
      const tasks = await fsRunQuery(
        {
          from: [{ collectionId: "reviewTasks" }],
          where: {
            compositeFilter: {
              op: "AND",
              filters: [
                { fieldFilter: { field: { fieldPath: "indicatorId" }, op: "EQUAL", value: { stringValue: indicator.id } } },
                { fieldFilter: { field: { fieldPath: "unitId" }, op: "EQUAL", value: { stringValue: tmp.record.unitId } } },
                { fieldFilter: { field: { fieldPath: "year" }, op: "EQUAL", value: { integerValue: String(tmp.record.year) } } },
                { fieldFilter: { field: { fieldPath: "month" }, op: "EQUAL", value: { integerValue: String(tmp.record.month) } } },
              ],
            },
          },
          limit: 1,
        },
        token,
      );
      taskCache.set(snapKey, tasks[0] ?? null);
    }
    const task = taskCache.get(snapKey);
    const built = task
      ? buildSyncRecord({
          mapping: { ...mapping, fieldMapping: merged },
          headers,
          rowCells: cells,
          indicator,
          unitHas,
          staffHas,
          staffName,
          taskSnapshot: task,
        })
      : tmp;
    valid.push({ lineNo, ...built });
  }

  // 4. 讀既有 state（batchGet，一次取回）
  const stateIds = valid.map((v) => syncStateDocId(v.rowKey));
  const states = await fsBatchGet(
    stateIds.map((id) => `sheetSyncState/${id}`),
    token,
  );

  const toWrite = [];
  const toDelete = [];
  const stateWrites = [];
  const auditWrites = [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (const v of valid) {
    const stateId = syncStateDocId(v.rowKey);
    const prev = states.get(stateId);
    if (prev && prev.hash === v.hash) {
      skipped++;
      continue;
    }
    if (prev && prev.docId && prev.docId !== v.docId) {
      // 列被修改：舊內容雜湊文件刪除，避免重複計算
      toDelete.push(prev.docId);
      updated++;
      auditWrites.push({
        actor: "sheet-sync",
        actorName: "sheet-sync",
        action: "同步更新審查紀錄",
        targetType: "reviewRecord",
        targetId: v.docId,
        detail: `${indicator.code} ${v.record.unitId} ${v.record.year}/${v.record.month}：表單列內容變更，覆寫更新（舊文件 ${prev.docId} 已刪除）`,
        createdAt: now,
      });
    } else if (prev && prev.docId === v.docId) {
      updated++;
    } else {
      inserted++;
    }
    toWrite.push(v);
    stateWrites.push({
      path: `sheetSyncState/${stateId}`,
      values: {
        mappingId: mapping.id,
        rowKey: v.rowKey,
        docId: v.docId,
        hash: v.hash,
        updatedAt: now,
      },
    });
  }

  // 5. 寫入（PATCH upsert，併發 8；舊文件刪除；state 更新；auditLogs）
  await runPool(
    toWrite.map((v) => async () => {
      await fsPatchDoc(
        `reviewRecords/${v.docId}`,
        { ...v.record, submittedAt: now },
        token,
      );
    }),
    WRITE_CONCURRENCY,
  );
  await runPool(
    toDelete.map((docId) => async () => fsDeleteDoc(`reviewRecords/${docId}`, token)),
    WRITE_CONCURRENCY,
  );
  await runPool(
    stateWrites.map((s) => async () => fsPatchDoc(s.path, s.values, token)),
    WRITE_CONCURRENCY,
  );
  await runPool(
    auditWrites.map((a) => async () => fsCreateDoc("auditLogs", a, token)),
    WRITE_CONCURRENCY,
  );

  run.inserted = inserted;
  run.updated = updated;
  run.skipped = skipped;
  run.errorRows = errorRows.slice(0, 50);
  run.status = errorRows.length > 0 ? "partial" : "ok";
  run.finishedAt = new Date();
  await writeRun();
  await fsPatchDoc(
    `sheetSyncMappings/${mapping.id}`,
    { lastSyncAt: run.finishedAt, updatedAt: run.finishedAt },
    token,
    ["lastSyncAt", "updatedAt"],
  );
  log(
    `對照 ${mapping.sheetName}：讀 ${run.rowsRead} 列，新增 ${inserted}、更新 ${updated}、跳過 ${skipped}、錯誤 ${errorRows.length} 列。`,
  );
  return { run, runId };
}

/* ================= 標題讀取（v1.42.3） ================= */

/**
 * 只讀標題列＋前 3 列預覽（不寫入審查紀錄），供步驟 1 連線確認用。
 * 成功：寫回 detectedHeaders、合併後的 fieldMapping、readiness、preview、
 * lastHeaderFetchAt，並清掉 headerFetchRequestedAt／headerFetchError；
 * 對應合併後與原本不同時一併寫 fieldMappingUpdatedAt（步驟 3 須重跑手動同步）。
 * 失敗：清掉 headerFetchRequestedAt、把原因寫回 headerFetchError（前端顯示），
 * 不拋錯、不發 LINE（常見失敗是 Sheet 尚未分享，屬使用者待辦）。
 * @returns {{ ok: boolean, error?: string }}
 */
async function fetchHeadersOnly(mapping, ctx) {
  const { token, indicators, unitHas, staffHas, staffName } = ctx;
  const now = new Date();
  const patchMapping = async (values, mask) =>
    fsPatchDoc(`sheetSyncMappings/${mapping.id}`, values, token, mask);
  try {
    const indicator = indicators.get(mapping.indicatorId);
    if (!indicator) throw new Error(`指標不存在：${mapping.indicatorId}`);
    const questions = (indicator.questions ?? []).map((q) => q.itemText ?? "");
    const meta = await sheetsMetadata(mapping.spreadsheetId, token);
    const sheets = meta.sheets ?? [];
    let sheetTitle = mapping.sheetName;
    if (mapping.sheetGid) {
      const byGid = sheets.find(
        (s) => String(s.properties?.sheetId) === String(mapping.sheetGid),
      );
      if (byGid) sheetTitle = byGid.properties.title;
    }
    if (!sheets.some((s) => s.properties?.title === sheetTitle)) {
      throw new Error(`試算表內找不到分頁「${sheetTitle}」`);
    }
    const values = await sheetsValues(
      mapping.spreadsheetId,
      `'${sheetTitle.replace(/'/g, "''")}'!A1:ZZ5`,
      token,
    );
    if (values.length === 0) throw new Error("試算表無資料（標題列為空）");
    const headers = values[0].map((h) => cellToString(h));
    const dataRows = values.slice(1);
    const auto = autoFieldMapping(headers, questions);
    const merged = { ...auto };
    for (const [h, v] of Object.entries(mapping.fieldMapping ?? {})) {
      if (v) merged[h] = v;
    }
    const missing = mappingMissingRequired(merged, questions);
    const preview = buildMappingPreview({
      headers,
      rows: dataRows,
      fieldMapping: merged,
      indicator,
      unitHas,
      staffHas,
      staffName,
    });
    const values2 = {
      detectedHeaders: headers,
      fieldMapping: merged,
      readiness: missing.length > 0 ? "mapping-incomplete" : "ready",
      preview,
      previewAt: now,
      lastHeaderFetchAt: now,
      headerFetchRequestedAt: null,
      headerFetchError: "",
      updatedAt: now,
    };
    const mask = [
      "detectedHeaders",
      "fieldMapping",
      "readiness",
      "preview",
      "previewAt",
      "lastHeaderFetchAt",
      "headerFetchRequestedAt",
      "headerFetchError",
      "updatedAt",
    ];
    if (!sameFieldMapping(merged, mapping.fieldMapping ?? {})) {
      values2.fieldMappingUpdatedAt = now;
      mask.push("fieldMappingUpdatedAt");
    }
    await patchMapping(values2, mask);
    log(`對照 ${mapping.sheetName}：標題列已讀取（${headers.length} 欄）。`);
    return { ok: true };
  } catch (err) {
    const msg = (err?.message ?? String(err)).slice(0, 500);
    await patchMapping(
      {
        headerFetchRequestedAt: null,
        headerFetchError: msg,
        updatedAt: now,
      },
      ["headerFetchRequestedAt", "headerFetchError", "updatedAt"],
    );
    log(`對照 ${mapping.sheetName}：讀取標題列失敗：${msg}`);
    return { ok: false, error: msg };
  }
}

/* ================= 手動同步請求模式（v1.42.2） ================= */

/**
 * 請求模式（SYNC_REQUESTS_ONLY=1）：先處理待讀取標題的對照（v1.42.3，
 * fetchHeadersOnly，只讀標題＋預覽、不寫入紀錄），再處理 status == "pending"
 * 的手動同步請求。請求逐一先以 updateMask 標記 running（避免重複執行），
 * 再執行 syncMapping（草稿亦可跑，與手動觸發同規則；run 紀錄 trigger 記
 * manual），完成標記 done＋runId，失敗標記 failed＋error。定時排程不受影響
 * （本模式不跑）。
 * @returns {number} 處理的項目數（標題讀取＋手動同步請求；0＝無事可做）
 */
async function runRequestMode(token, lineToken, lineTo) {
  const mappings = await fsListCollection("sheetSyncMappings", token);
  const headerTargets = selectHeaderFetchTargets(mappings);
  const requests = await fsListCollection("sheetSyncRequests", token);
  const pending = selectPendingRequests(requests);
  if (headerTargets.length === 0 && pending.length === 0) {
    log("沒有待讀取標題的對照與待執行的手動同步請求，本輪無事可做。");
    return 0;
  }
  // 參考資料全量各讀 1 次（與定時流程相同，惰性驗證）
  const [units, users, indicatorsList] = await Promise.all([
    fsListCollection("units", token),
    fsListCollection("users", token),
    fsListCollection("indicators", token),
  ]);
  const unitHas = (code) => units.some((u) => u.id === code || u.code === code);
  const staffById = new Map();
  for (const u of users) {
    staffById.set(u.id, u);
    if (u.staffId) staffById.set(u.staffId, u);
  }
  const staffHas = (id) => staffById.has(id);
  const staffName = (id) => staffById.get(id)?.name ?? id;
  const indicators = new Map(indicatorsList.map((ind) => [ind.id, ind]));
  const ctx = { token, indicators, unitHas, staffHas, staffName, taskCache: new Map(), trigger: "manual" };

  // 步驟 1 連線確認（v1.42.3）：先處理待讀取標題的對照（只讀標題＋預覽，
  // 不寫入審查紀錄），讓 [連線確認] 後 5 分鐘內讀到欄位名稱；讀取失敗只寫
  // 回 headerFetchError（前端步驟 1 顯示），不發 LINE、不讓整輪失敗。
  for (const mapping of headerTargets) {
    await fetchHeadersOnly(mapping, ctx);
  }

  const failures = [];
  for (const req of pending) {
    const reqPath = `sheetSyncRequests/${req.id}`;
    // 先標記 running（updateMask 只改 status／updatedAt，避免洗掉其他欄位）
    await fsPatchDoc(reqPath, { status: "running", updatedAt: new Date() }, token, [
      "status",
      "updatedAt",
    ]);
    const mapping = await fsGetDoc(`sheetSyncMappings/${req.mappingId}`, token);
    if (!mapping) {
      const msg = `找不到對照：${req.mappingId}`;
      await fsPatchDoc(
        reqPath,
        { status: "failed", error: msg, updatedAt: new Date() },
        token,
        ["status", "error", "updatedAt"],
      );
      log(`請求 ${req.id}：${msg}`);
      failures.push(msg);
      continue;
    }
    if (mapping.enabled === false) {
      const msg = `對照已停用：${mapping.sheetName}`;
      await fsPatchDoc(
        reqPath,
        { status: "failed", error: msg, updatedAt: new Date() },
        token,
        ["status", "error", "updatedAt"],
      );
      log(`請求 ${req.id}：${msg}`);
      failures.push(msg);
      continue;
    }
    try {
      const { run, runId } = await syncMapping({ id: req.mappingId, ...mapping }, ctx);
      await fsPatchDoc(
        reqPath,
        { status: "done", runId, updatedAt: new Date() },
        token,
        ["status", "runId", "updatedAt"],
      );
      log(`請求 ${req.id}：對照 ${mapping.sheetName} 同步完成（run ${runId}，${run.status}）。`);
    } catch (err) {
      const msg = err?.message ?? String(err);
      const failedValues = {
        status: "failed",
        error: msg.slice(0, 500),
        updatedAt: new Date(),
      };
      const failedMask = ["status", "error", "updatedAt"];
      if (err?.runId) {
        failedValues.runId = err.runId;
        failedMask.push("runId");
      }
      await fsPatchDoc(reqPath, failedValues, token, failedMask);
      const line = `對照 ${mapping.sheetName} 手動同步失敗：${msg}`;
      log(`請求 ${req.id}：${line}`);
      failures.push(line);
    }
  }

  if (failures.length > 0) {
    await sendLine(
      `Google Sheet 手動同步有 ${failures.length} 筆請求失敗：\n${failures.join("\n")}`,
      lineToken,
      lineTo,
    );
    console.error(`[sheet-sync] ${failures.length} 筆手動同步請求失敗`);
    process.exit(1);
  }
  log(`標題讀取 ${headerTargets.length} 份、手動同步請求全部完成（${pending.length} 筆）。`);
  return headerTargets.length + pending.length;
}

/* ================= 主流程 ================= */

async function main() {
  const saJson = process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (!saJson) {
    console.error(
      "缺少 GCP_SERVICE_ACCOUNT_JSON：請在 GitHub Secrets 加入 service account JSON（見回報的 Secret 清單）。",
    );
    process.exit(1);
  }
  let sa;
  try {
    sa = JSON.parse(saJson);
  } catch {
    console.error("GCP_SERVICE_ACCOUNT_JSON 不是合法 JSON。");
    process.exit(1);
  }
  if (!sa.client_email || !sa.private_key) {
    console.error("service account JSON 缺少 client_email 或 private_key。");
    process.exit(1);
  }
  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "";
  const lineTo = process.env.LINE_USER_ID ?? "";
  const onlyMappingId = (process.env.MAPPING_ID ?? "").trim();
  // 觸發來源（v1.42.1）：workflow_dispatch＝手動測試，schedule＝定時排程；
  // 本機執行時無此變數，視為定時排程（安全預設，只跑已確認者）。
  const isManual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const trigger = isManual ? "manual" : "schedule";

  const token = await getAccessToken(sa);

  // 手動同步請求模式（v1.42.2）：SYNC_REQUESTS_ONLY=1 時只處理 pending 請求，
  // 不跑定時排程；無待執行請求時靜默結束（供每 5 分鐘輪詢）。
  if (process.env.SYNC_REQUESTS_ONLY === "1") {
    await runRequestMode(token, lineToken, lineTo);
    return;
  }

  const mappings = await fsListCollection("sheetSyncMappings", token);
  if (onlyMappingId) {
    const found = mappings.find((m) => m.id === onlyMappingId);
    if (!found) {
      console.error(`找不到對照：${onlyMappingId}`);
      process.exit(1);
    }
    if (found.enabled === false) {
      console.error(`對照已停用：${onlyMappingId}`);
      process.exit(1);
    }
  }
  // 確認關卡（v1.42.1）：定時排程只跑已確認且啟用的對照；草稿跳過並寫 run
  // 紀錄記下跳過原因，不寫入審查紀錄。手動觸發指定單一對照時草稿亦可跑。
  const { targets, skipped } = selectSyncTargets(mappings, {
    manual: isManual,
    mappingId: onlyMappingId,
  });
  const now0 = new Date();
  for (const { mapping, reason } of skipped) {
    const skipRunId = `run_${mapping.id}_${now0.toISOString().replace(/[-:.]/g, "").slice(0, 15)}_skipped`;
    await fsPatchDoc(
      `sheetSyncRuns/${skipRunId}`,
      {
        mappingId: mapping.id,
        trigger,
        startedAt: now0,
        finishedAt: now0,
        rowsRead: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
        errorRows: [],
        status: "skipped",
        error: reason,
      },
      token,
    );
    log(`對照 ${mapping.sheetName}：${reason}`);
  }
  if (targets.length === 0) {
    log("沒有可同步的對照，本輪無事可做。");
    return;
  }

  // 參考資料全量各讀 1 次（惰性驗證）
  const [units, users, indicatorsList] = await Promise.all([
    fsListCollection("units", token),
    fsListCollection("users", token),
    fsListCollection("indicators", token),
  ]);
  const unitHas = (code) => units.some((u) => u.id === code || u.code === code);
  const staffById = new Map();
  for (const u of users) {
    staffById.set(u.id, u);
    if (u.staffId) staffById.set(u.staffId, u);
  }
  const staffHas = (id) => staffById.has(id);
  const staffName = (id) => staffById.get(id)?.name ?? id;
  const indicators = new Map(indicatorsList.map((ind) => [ind.id, ind]));

  const ctx = { token, indicators, unitHas, staffHas, staffName, taskCache: new Map(), trigger };
  const failures = [];
  for (const mapping of targets) {
    try {
      await syncMapping(mapping, ctx);
    } catch (err) {
      const msg = `對照 ${mapping.sheetName}（${mapping.spreadsheetId.slice(0, 12)}…）同步失敗：${err.message}`;
      log(msg);
      failures.push(msg);
    }
  }

  if (failures.length > 0) {
    await sendLine(
      `Google Sheet 定時同步有 ${failures.length} 份對照失敗：\n${failures.join("\n")}`,
      lineToken,
      lineTo,
    );
    console.error(`[sheet-sync] ${failures.length} 份對照失敗`);
    process.exit(1);
  }
  log("全部對照同步完成。");
}

main().catch((err) => {
  console.error(`[sheet-sync] 同步失敗：${err.message}`);
  process.exit(1);
});
