/**
 * Google Sheet 定時同步對照（v1.42.0）。
 *
 * 本檔零依賴、不碰 DOM、不碰 Firestore，可在 node 直接單元測試。
 * 對照設定存在 Firestore `sheetSyncMappings` 集合（一份文件＝一個連結），
 * 由結果匯入頁「連結 Google Sheet」區維護、定時同步 workflow 照此讀取。
 * scripts/sheet-sync-lib.mjs 有同一份欄位對應邏輯（Node 版），兩邊以相同
 * fixture 測試守住一致。
 */

/** 系統欄位鍵：6 欄固定＋時間戳記＋每題結果／備註（answer:{i}／note:{i}，i 為題目序號 0 起） */
export type SheetSystemFieldKey =
  | "code"
  | "unitCode"
  | "monthRaw"
  | "reviewerId"
  | "personEmpNo"
  | "bedNo"
  | "timestamp"
  | `answer:${number}`
  | `note:${number}`;

/** 預覽一列：前 3 列資料列用目前對應解析的結果（workflow 讀標題時一併寫回）。 */
export interface SheetPreviewRow {
  /** Sheet 列號（標題列為第 1 列，資料列自第 2 列起） */
  lineNo: number;
  /** 該列檢核是否通過 */
  ok: boolean;
  /** 檢核錯誤（以；連接，空字串＝無錯誤） */
  errors: string;
  /** 已對應的系統欄位鍵 → 原始儲存格字串 */
  values: Record<string, string>;
}

/** 一份對照文件（Firestore sheetSyncMappings） */
export interface SheetSyncMapping {
  id: string;
  spreadsheetId: string;
  /** 分頁名（例如「表單回覆 1」） */
  sheetName: string;
  /** 網址 #gid= 的分頁 id（若有；workflow 可藉此解析分頁名） */
  sheetGid?: string;
  groupId: string;
  indicatorId: string;
  enabled: boolean;
  /** Sheet 標題列（workflow 讀回後寫入；未讀取前為 []） */
  detectedHeaders: string[];
  /** 欄位對應：Sheet 標題 → 系統欄位鍵 */
  fieldMapping: Record<string, string>;
  /**
   * 確認狀態（v1.42.1 確認關卡）：
   * draft＝草稿（未列入排程，定時同步跳過）、confirmed＝已確認列入排程。
   * v1.42.0 舊文件此欄是就緒值（pending／mapping-incomplete／ready），
   * 讀取時一律視為草稿（isMappingConfirmed 只認 "confirmed"）。
   */
  status: "draft" | "confirmed";
  /** 就緒狀態（v1.42.1 起獨立欄位；舊文件以 status 舊值推導，見 mappingReadiness） */
  readiness?: "pending" | "mapping-incomplete" | "ready";
  /** 確認時間／確認者職編（確認後寫入；編輯對應後清空） */
  confirmedAt?: unknown;
  confirmedBy?: string;
  /** 對應預覽（前 3 列，workflow 讀標題時寫回） */
  preview?: SheetPreviewRow[];
  previewAt?: unknown;
  /** 前端要求讀取標題的時間（workflow 下次執行時處理） */
  headerFetchRequestedAt?: unknown;
  /** 最近一次讀取標題失敗的原因（成功時清空；步驟 1 顯示用） */
  headerFetchError?: string;
  /** 欄位對應最後修改時間（前端儲存對應時寫入；同步端合併自動對應改變對應時亦寫入。
   * 步驟 3 的手動同步成功紀錄須在此時間之後才算數，對應改過就要重跑手動同步） */
  fieldMappingUpdatedAt?: unknown;
  lastHeaderFetchAt?: unknown;
  lastSyncAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

/** 一筆同步執行紀錄（Firestore sheetSyncRuns，僅管理員可讀） */
export interface SheetSyncRun {
  id?: string;
  mappingId: string;
  startedAt?: unknown;
  finishedAt?: unknown;
  rowsRead: number;
  inserted: number;
  updated: number;
  skipped: number;
  errorRows: { lineNo: number; errors: string }[];
  /** ok／partial／failed／mapping-incomplete／skipped */
  status: string;
  error?: string;
  /** manual＝手動觸發、schedule＝定時排程 */
  trigger?: string;
  /** 執行來源（v1.42.4）：browser＝瀏覽器直接讀 Sheet（手動同步）、actions＝GitHub Actions（定時排程／手動觸發） */
  source?: string;
}

/** 對照是否已確認列入排程（只認 "confirmed"；舊版就緒值一律視為草稿）。 */
export function isMappingConfirmed(m: { status?: unknown }): boolean {
  return m.status === "confirmed";
}

/** 就緒狀態（含 v1.42.0 舊文件相容：舊 status 值即就緒值）。 */
export function mappingReadiness(
  m: SheetSyncMapping,
): "pending" | "mapping-incomplete" | "ready" {
  if (
    m.readiness === "ready" ||
    m.readiness === "mapping-incomplete" ||
    m.readiness === "pending"
  )
    return m.readiness;
  const legacy = m.status as unknown as string;
  if (
    legacy === "ready" ||
    legacy === "mapping-incomplete" ||
    legacy === "pending"
  )
    return legacy;
  return "pending";
}

/** 不同標題是否對到同一系統欄位（儲存／確認時皆須擋下）。 */
export function hasDuplicateMapping(
  fieldMapping: Record<string, string>,
): boolean {
  const used = Object.values(fieldMapping).filter((v) => v !== "");
  return new Set(used).size !== used.length;
}

/**
 * 確認列入排程的條件（純函式）：標題已讀取（連線成功）且對應完整、
 * 無重複對應。手動同步是否成功不列入條件（選用步驟）。
 * v1.42.3 起列入排程改用 canEnrollMapping（手動同步成功為必要條件），
 * 本函式保留為步驟 1＋2 的 gate（與舊測試相容）。
 */
export function canConfirmMapping(input: {
  headersRead: boolean;
  missing: string[];
  hasDuplicate: boolean;
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.headersRead) reasons.push("尚未讀取標題列，無法確認連線成功");
  if (input.missing.length > 0)
    reasons.push(`對應缺必要欄位：${input.missing.join("、")}`);
  if (input.hasDuplicate) reasons.push("不同標題不可對到同一系統欄位");
  return { ok: reasons.length === 0, reasons };
}

/** 時間值 → 毫秒時間戳（Firestore Timestamp／{seconds}／ISO 字串／Date／數字皆可；缺失為 null）。 */
export function tsMillis(v: unknown): number | null {
  if (!v) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  if (v instanceof Date) return v.getTime();
  const t = v as {
    toMillis?: () => number;
    toDate?: () => Date;
    seconds?: number;
    nanoseconds?: number;
  };
  if (typeof t.toMillis === "function") return t.toMillis();
  if (typeof t.toDate === "function") return t.toDate().getTime();
  if (typeof t.seconds === "number")
    return t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6);
  return null;
}

/** 兩份欄位對應是否相同（鍵與值皆等；空字串視為未對應，與缺鍵同義）。 */
export function sameFieldMapping(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const norm = (m: Record<string, string>) =>
    Object.keys(m ?? {})
      .filter((k) => m[k])
      .sort()
      .map((k) => `${k}=${m[k]}`)
      .join("&");
  return norm(a) === norm(b);
}

/**
 * 步驟 3 的合格手動同步紀錄（純函式）：最近一次 trigger=manual、status 為
 * ok 或 partial、且 inserted＋updated ≥ 1 的紀錄；對應改過後（editTimeMs
 * 有值）只取該時間之後的紀錄。editTimeMs 為 null＝無對應修改紀錄（舊對照相容）。
 */
export function findQualifyingManualRun(
  runs: SheetSyncRun[],
  editTimeMs: number | null,
): SheetSyncRun | null {
  const ok = (runs ?? [])
    .filter(
      (r) =>
        r.trigger === "manual" &&
        (r.status === "ok" || r.status === "partial") &&
        (r.inserted ?? 0) + (r.updated ?? 0) >= 1,
    )
    .filter((r) => {
      if (editTimeMs === null) return true;
      const t = tsMillis(r.finishedAt ?? r.startedAt);
      return t !== null && t > editTimeMs;
    })
    .sort(
      (a, b) =>
        (tsMillis(b.finishedAt ?? b.startedAt) ?? 0) -
        (tsMillis(a.finishedAt ?? a.startedAt) ?? 0),
    );
  return ok[0] ?? null;
}

/** 四步驟狀態：done＝已完成、active＝進行中（第一個未完成的步驟）、todo＝未完成。 */
export type SyncStepState = "done" | "active" | "todo";

/** 四步驟狀態推導（純函式）：四步須依序完成；第一個未完成的步驟為進行中，其後為未完成。 */
export function deriveSyncSteps(input: {
  step1Done: boolean;
  step2Done: boolean;
  step3Done: boolean;
  step4Done: boolean;
}): {
  step1: SyncStepState;
  step2: SyncStepState;
  step3: SyncStepState;
  step4: SyncStepState;
  /** 目前步驟（1–4；0＝四步皆完成） */
  current: 0 | 1 | 2 | 3 | 4;
} {
  const dones = [input.step1Done, input.step2Done, input.step3Done, input.step4Done];
  const firstOpen = dones.findIndex((d) => !d);
  const states: SyncStepState[] = dones.map((d, i) => {
    if (d) return "done";
    return i === firstOpen ? "active" : "todo";
  });
  return {
    step1: states[0],
    step2: states[1],
    step3: states[2],
    step4: states[3],
    current: (firstOpen === -1 ? 0 : firstOpen + 1) as 0 | 1 | 2 | 3 | 4,
  };
}

/** 四步驟狀態中文（步驟條顯示用）。 */
export function syncStepStateLabel(state: SyncStepState): string {
  switch (state) {
    case "done":
      return "已完成";
    case "active":
      return "進行中";
    case "todo":
      return "未完成";
    default:
      return state || "—";
  }
}

/**
 * 列入排程的條件（純函式，v1.42.3 四步驟 gate）：第 1–3 步皆完成才可列入。
 * 第 3 步＝手動同步成功（至少匯入 1 筆），0 筆匯入不算成功。
 */
export function canEnrollMapping(input: {
  headersRead: boolean;
  missing: string[];
  hasDuplicate: boolean;
  manualSyncOk: boolean;
}): { ok: boolean; reasons: string[] } {
  const reasons = [...canConfirmMapping(input).reasons];
  if (!input.manualSyncOk)
    reasons.push("尚未完成手動同步（須有一次手動同步成功匯入至少 1 筆資料）");
  return { ok: reasons.length === 0, reasons };
}

/** 同步執行紀錄狀態中文（驗證區顯示用）。 */
export function runStatusLabel(status: string): string {
  switch (status) {
    case "ok":
      return "成功";
    case "partial":
      return "部分成功";
    case "failed":
      return "失敗";
    case "mapping-incomplete":
      return "對應未完成";
    case "skipped":
      return "已跳過（草稿未確認）";
    default:
      return status || "—";
  }
}

/** 標題列正規化：去空白與括號、％，供欄位比對（與 import.ts headerKey 同規則）。 */
export function sheetHeaderKey(h: string): string {
  return h
    .trim()
    .replace(/[\s（）()%％]/g, "")
    .toLowerCase();
}

/**
 * 解析 Google Sheet 網址，取出 spreadsheetId 與 gid。
 * 接受格式：https://docs.google.com/spreadsheets/d/{id}/...（#gid= 選填）。
 * 其餘回傳 { error }。
 */
export function parseSheetUrl(
  url: string,
): { spreadsheetId: string; gid?: string } | { error: string } {
  const t = url.trim();
  const m = /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(t);
  if (!m) return { error: "網址須為 Google 試算表連結（含 /spreadsheets/d/試算表 ID/）" };
  const out: { spreadsheetId: string; gid?: string } = {
    spreadsheetId: m[1],
  };
  const gid = /[#&]gid=(\d+)/.exec(t);
  if (gid) out.gid = gid[1];
  return out;
}

/** 系統欄位選項（欄位對應編輯器下拉用）：6 欄固定＋時間戳記＋每題結果／備註 */
export function sheetSystemFieldOptions(questions: string[]): {
  key: string;
  label: string;
}[] {
  const opts: { key: string; label: string }[] = [
    { key: "timestamp", label: "時間戳記（表單回覆時間）" },
    { key: "code", label: "指標代號" },
    { key: "unitCode", label: "受審單位" },
    { key: "monthRaw", label: "審查月份" },
    { key: "reviewerId", label: "審查員職編" },
    { key: "personEmpNo", label: "受審人員職編" },
    { key: "bedNo", label: "床號" },
  ];
  questions.forEach((q, i) => {
    opts.push({ key: `answer:${i}`, label: `第 ${i + 1} 題結果：${q}` });
    opts.push({ key: `note:${i}`, label: `第 ${i + 1} 題備註：${q}備註` });
  });
  return opts;
}

/**
 * 依標題文字自動對應欄位（Sheet 標題 → 系統欄位鍵）。
 * 規則：時間戳記／固定欄以常見標題比對；每題結果欄須與題目文字完全相符、
 * 備註欄為「題目＋備註」。對不上的標題不寫入（留空待手動選）。
 */
export function autoFieldMapping(
  headers: string[],
  questions: string[],
): Record<string, string> {
  const map: Record<string, string> = {};
  const qKey = questions.map((q) => sheetHeaderKey(q));
  for (const h of headers) {
    const k = sheetHeaderKey(h);
    if (k === "" ) continue;
    if (k.includes("時間戳記") || k === "timestamp") {
      map[h] = "timestamp";
      continue;
    }
    if (k === "指標代號" || k === "編號") {
      map[h] = "code";
      continue;
    }
    if (k === "受審單位" || k === "單位") {
      map[h] = "unitCode";
      continue;
    }
    if (k === "審查月份" || k === "月份") {
      map[h] = "monthRaw";
      continue;
    }
    if (k === "審查員職編" || k === "審查員") {
      map[h] = "reviewerId";
      continue;
    }
    if (k === "受審人員職編" || k === "受審人員") {
      map[h] = "personEmpNo";
      continue;
    }
    if (k === "床號") {
      map[h] = "bedNo";
      continue;
    }
    const qi = qKey.indexOf(k);
    if (qi >= 0) {
      map[h] = `answer:${qi}`;
      continue;
    }
    const ni = qKey.findIndex((qk) => k === `${qk}備註`);
    if (ni >= 0) {
      map[h] = `note:${ni}`;
      continue;
    }
  }
  return map;
}

/** 同步必要的系統欄位鍵：受審單位、受審人員、（審查月份或時間戳記其一）、每題結果 */
export function requiredMappingKeys(questionCount: number): string[] {
  const keys = ["unitCode", "personEmpNo"];
  for (let i = 0; i < questionCount; i++) keys.push(`answer:${i}`);
  return keys;
}

/**
 * 檢查對應是否缺必要欄（供儲存對應時顯示錯誤、不建立同步）。
 * 回傳缺的欄位中文名（空陣列＝齊全）。審查月份與時間戳記有其一即可
 * （缺月份時由時間戳記推導年月）。
 */
export function mappingMissingRequired(
  fieldMapping: Record<string, string>,
  questions: string[],
): string[] {
  const used = new Set(Object.values(fieldMapping));
  const missing: string[] = [];
  if (!used.has("unitCode")) missing.push("受審單位");
  if (!used.has("personEmpNo")) missing.push("受審人員職編");
  if (!used.has("monthRaw") && !used.has("timestamp"))
    missing.push("審查月份（或時間戳記）");
  questions.forEach((q, i) => {
    if (!used.has(`answer:${i}`)) missing.push(`第 ${i + 1} 題結果：${q}`);
  });
  return missing;
}
