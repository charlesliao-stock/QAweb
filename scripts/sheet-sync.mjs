#!/usr/bin/env node
/**
 * Google Sheet 定時同步 — 執行檔（v1.42.0）。
 *
 * GitHub Actions 每日 07:00 台北時間執行（.github/workflows/sheet-sync.yml），
 * 另可 workflow_dispatch 手動觸發（可指定單一 mappingId）。
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
 *
 * 本檔只用 Node 內建模組（node:crypto＋fetch），不需 npm install。
 */
import { createSign } from "node:crypto";
import {
  autoFieldMapping,
  buildSyncRecord,
  cellToString,
  decodeFirestoreDoc,
  encodeFirestoreFields,
  mappingMissingRequired,
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
  const { token, indicators, unitHas, staffHas, staffName, taskCache } = ctx;
  const now = new Date();
  const runId = `run_${mapping.id}_${now.toISOString().replace(/[-:.]/g, "").slice(0, 15)}`;
  const run = {
    mappingId: mapping.id,
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
    throw new Error(run.error);
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
    throw new Error(run.error);
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
    return run;
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
  const mappingPatch = {
    detectedHeaders: headers,
    fieldMapping: merged,
    status: missing.length > 0 ? "mapping-incomplete" : "ready",
    lastHeaderFetchAt: now,
    headerFetchRequestedAt: null,
    updatedAt: now,
  };
  await fsPatchDoc(`sheetSyncMappings/${mapping.id}`, mappingPatch, token, [
    "detectedHeaders",
    "fieldMapping",
    "status",
    "lastHeaderFetchAt",
    "headerFetchRequestedAt",
    "updatedAt",
  ]);
  if (missing.length > 0) {
    run.status = "mapping-incomplete";
    run.error = `對應缺必要欄位：${missing.join("、")}`;
    run.finishedAt = new Date();
    await writeRun();
    log(`對照 ${mapping.sheetName}：對應未完成（${run.error}），跳過寫入。`);
    return run;
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
  return run;
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

  const token = await getAccessToken(sa);

  const mappings = await fsListCollection("sheetSyncMappings", token);
  let targets = mappings.filter((m) => m.enabled !== false);
  if (onlyMappingId) {
    targets = targets.filter((m) => m.id === onlyMappingId);
    if (targets.length === 0) {
      console.error(`找不到對照：${onlyMappingId}（或該對照已停用）`);
      process.exit(1);
    }
  }
  if (targets.length === 0) {
    log("沒有啟用的同步對照，本輪無事可做。");
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

  const ctx = { token, indicators, unitHas, staffHas, staffName, taskCache: new Map() };
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
