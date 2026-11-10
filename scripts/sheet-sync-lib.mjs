/**
 * Google Sheet 定時同步 — 純邏輯（v1.42.0）。
 *
 * 被 `scripts/sheet-sync.mjs`（GitHub Actions 每日 07:00）與
 * `scripts/test-v1.42.0.mjs` 共用。本檔不碰網路、不讀環境變數，方便測試。
 *
 * 注意：sha1Hex／importRecordHash／importRecordDocId／parseReviewMonth／
 * normalizeResultAnswer／欄位對應（sheetHeaderKey／autoFieldMapping／
 * mappingMissingRequired）與前端 `src/lib/import.ts`、`src/lib/sheetSync.ts`
 * 是同一規則的兩份實作（前端 TS、同步端 Node ESM 無法共用檔案），
 * 改規則時兩邊要同步，並以相同 fixture 測試守住一致。
 */

/* ================= SHA-1（純函式，零依賴；與 src/lib/import.ts 同演算法） ================= */

export function sha1Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const ml = bytes.length;
  const paddedLen = (((ml + 9 + 63) >> 6) << 6);
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[ml] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(paddedLen - 4, (ml * 8) >>> 0);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++)
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f;
      let k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const tmp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = tmp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const hex = (x) => x.toString(16).padStart(8, "0");
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4);
}

/* ================= 匯入去重：內容雜湊 → 決定性文件 ID ================= */

/**
 * 匯入紀錄內容雜湊（與 src/lib/import.ts importRecordHash 同一固定順序 JSON）。
 * reviewDate 不在內（手動匯入的 reviewDate 是匯入當天）；指標與床號在內。
 */
export function importRecordHash(input) {
  const canon = {
    v: 1,
    s: (input.spreadsheetId ?? "").trim(),
    t: (input.sheetName ?? "").trim(),
    ts: (input.timestamp ?? "").trim(),
    ind: input.indicatorId.trim(),
    unit: input.unitCode.trim(),
    y: input.year,
    m: input.month,
    r: (input.reviewerId ?? "").trim(),
    p: (input.personEmpNo ?? "").trim(),
    b: (input.bedNo ?? "").trim(),
    a: (input.answers ?? []).map((x) => (x ?? "").trim()),
    n: (input.notes ?? []).map((x) => (x ?? "").trim()),
  };
  return sha1Hex(JSON.stringify(canon));
}

/** 匯入紀錄文件 ID：import_＋雜湊前 24 字元（96 位元）。 */
export function importRecordDocId(input) {
  return `import_${importRecordHash(input).slice(0, 24)}`;
}

/**
 * 同步列的穩定身份（sheetSyncState 文件 ID 的雜湊來源）。
 * 以表單時間戳記為主（同一筆回覆被編輯時時間戳記不變），無時間戳記時
 * 退回自然鍵（指標＋單位＋年月＋審查員＋受審人員＋床號）。
 * 用途：列被修改時由 state 找到舊內容雜湊的文件 ID 並刪除，避免重複計算。
 */
export function syncRowKey(input) {
  const ts = (input.timestamp ?? "").trim();
  if (ts) {
    return JSON.stringify({
      v: 1,
      s: (input.spreadsheetId ?? "").trim(),
      t: (input.sheetName ?? "").trim(),
      ts,
    });
  }
  return JSON.stringify({
    v: 1,
    ind: input.indicatorId.trim(),
    unit: input.unitCode.trim(),
    y: input.year,
    m: input.month,
    r: (input.reviewerId ?? "").trim(),
    p: (input.personEmpNo ?? "").trim(),
    b: (input.bedNo ?? "").trim(),
  });
}

export function syncStateDocId(rowKey) {
  return `row_${sha1Hex(rowKey).slice(0, 24)}`;
}

/* ================= 審查月份／答案正規化（與 src/lib/import.ts 同規則） ================= */

export function parseReviewMonth(raw) {
  const m = /^\s*(\d{4})[./-](\d{1,2})(?:[./-](\d{1,2}))?\s*$/.exec(raw ?? "");
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  if (m[3] !== undefined) {
    const day = Number(m[3]);
    const d = new Date(Date.UTC(year, month - 1, day));
    if (
      d.getUTCFullYear() !== year ||
      d.getUTCMonth() !== month - 1 ||
      d.getUTCDate() !== day
    )
      return null;
  }
  return { year, month };
}

export function normalizeResultAnswer(raw) {
  if (raw == null) return null;
  const t = String(raw).replace(/[　\s]+/g, " ").trim();
  if (t === "") return null;
  const mapping = {
    是: "是",
    正確: "是",
    對: "是",
    yes: "是",
    Y: "是",
    否: "否",
    不正確: "否",
    錯: "否",
    no: "否",
    N: "否",
    不適用: "不適用",
    "N/A": "不適用",
    NA: "不適用",
    "n/a": "不適用",
  };
  if (t in mapping) return mapping[t];
  const lower = t.toLowerCase();
  if (lower in mapping) return mapping[lower];
  return null;
}

/* ================= 欄位對應（與 src/lib/sheetSync.ts 同規則） ================= */

export function sheetHeaderKey(h) {
  return String(h ?? "")
    .trim()
    .replace(/[\s（）()%％]/g, "")
    .toLowerCase();
}

export function parseSheetUrl(url) {
  const t = String(url ?? "").trim();
  const m = /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(t);
  if (!m) return { error: "網址須為 Google 試算表連結（含 /spreadsheets/d/試算表 ID/）" };
  const out = { spreadsheetId: m[1] };
  const gid = /[#&]gid=(\d+)/.exec(t);
  if (gid) out.gid = gid[1];
  return out;
}

export function sheetSystemFieldOptions(questions) {
  const opts = [
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

export function autoFieldMapping(headers, questions) {
  const map = {};
  const qKey = questions.map((q) => sheetHeaderKey(q));
  for (const h of headers) {
    const k = sheetHeaderKey(h);
    if (k === "") continue;
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

export function mappingMissingRequired(fieldMapping, questions) {
  const used = new Set(Object.values(fieldMapping));
  const missing = [];
  if (!used.has("unitCode")) missing.push("受審單位");
  if (!used.has("personEmpNo")) missing.push("受審人員職編");
  if (!used.has("monthRaw") && !used.has("timestamp"))
    missing.push("審查月份（或時間戳記）");
  questions.forEach((q, i) => {
    if (!used.has(`answer:${i}`)) missing.push(`第 ${i + 1} 題結果：${q}`);
  });
  return missing;
}

/* ================= Sheet 儲存格／時間戳記 ================= */

/** Sheets API 儲存格值 → 字串（數字轉字串、null／undefined → ""）。 */
export function cellToString(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

/**
 * 從表單時間戳記取出日期 YYYY-MM-DD。
 * 接受 "2026/11/10 上午 11:23:45"、"2026-11-10 11:23"、ISO 等；
 * 先抓 YYYY/MM/DD 或 YYYY-MM-DD，抓不到再試 Date 解析（以台北時區取日期）。
 * 回傳 null＝無法解析（該列視為錯誤列）。
 */
export function parseTimestampDate(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const m = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (
      dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === mo - 1 &&
      dt.getUTCDate() === d
    ) {
      return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    return null;
  }
  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

/* ================= 同步列 → 審查紀錄 ================= */

/**
 * 依欄位對應把一列 Sheet 資料建成審查紀錄（與前端 validateResultSheet＋
 * ResultImportPanel 寫入形狀一致，另補排程快照欄位）。
 *
 * @param {object} args
 * @param {object} args.mapping sheetSyncMapping（spreadsheetId／sheetName／indicatorId）
 * @param {string[]} args.headers Sheet 標題列
 * @param {unknown[]} args.rowCells 該列儲存格（與標題列等長，不足補 ""）
 * @param {object} args.indicator 指標（id／code／questions[{id,itemText}]／version／basicThreshold／tenSteps）
 * @param {(code: string) => boolean} args.unitHas 受審單位存在
 * @param {(id: string) => boolean} args.staffHas 職編存在
 * @param {(id: string) => string} args.staffName 職編→姓名（不存在回傳職編）
 * @param {object|null} args.taskSnapshot 同指標＋單位＋月份的 reviewTask 快照（無則 null）
 * @returns {{ok: boolean, errors: string[], docId: string|null, hash: string|null,
 *   rowKey: string|null, record: object|null, reviewDate: string|null}}
 */
export function buildSyncRecord(args) {
  const { mapping, headers, rowCells, indicator, unitHas, staffHas, staffName, taskSnapshot } = args;
  const byKey = {};
  headers.forEach((h, i) => {
    const key = mapping.fieldMapping?.[h];
    if (key) byKey[key] = cellToString(rowCells[i]);
  });
  const get = (k) => byKey[k] ?? "";
  const errors = [];

  // 指標代號（若有對應才檢查；mapping 已綁指標，無對應時不擋）
  if (byKey.code !== undefined && byKey.code !== "" && byKey.code !== indicator.code) {
    errors.push(`指標代號 ${byKey.code} 與連結指標 ${indicator.code} 不符`);
  }
  const unitCode = get("unitCode").trim();
  if (!unitCode) errors.push("受審單位未填");
  else if (!unitHas(unitCode)) errors.push(`受審單位 ${unitCode} 不存在`);

  // 審查年月：月份欄優先，否則由時間戳記推導
  let ym = null;
  let reviewDate = null;
  const monthRaw = get("monthRaw");
  if (monthRaw) {
    ym = parseReviewMonth(monthRaw);
    if (!ym) errors.push(`審查月份格式錯誤：${monthRaw}`);
    else reviewDate = `${ym.year}-${String(ym.month).padStart(2, "0")}-01`;
  }
  const timestamp = get("timestamp");
  if (!ym && timestamp) {
    const d = parseTimestampDate(timestamp);
    if (!d) errors.push(`時間戳記無法解析日期：${timestamp}`);
    else {
      ym = { year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)) };
      reviewDate = d;
    }
  }
  if (!ym && !monthRaw && !timestamp) errors.push("審查月份與時間戳記皆未填");
  if (monthRaw && ym && timestamp) {
    const d = parseTimestampDate(timestamp);
    if (d) reviewDate = d;
  }

  const reviewerId = get("reviewerId").trim();
  if (reviewerId && !staffHas(reviewerId)) errors.push(`審查員職編 ${reviewerId} 不存在`);
  const personEmpNo = get("personEmpNo").trim();
  if (!personEmpNo) errors.push("受審人員職編未填");
  else if (!staffHas(personEmpNo)) errors.push(`受審人員職編 ${personEmpNo} 不存在`);
  const bedNo = get("bedNo").trim();

  const answers = [];
  const notes = [];
  indicator.questions.forEach((q, i) => {
    const raw = get(`answer:${i}`);
    const normalized = raw === "" ? "" : normalizeResultAnswer(raw);
    if (raw !== "" && normalized === null) {
      errors.push(`第 ${i + 1} 題答案無效：${raw}`);
    }
    answers.push(normalized ?? "");
    notes.push(get(`note:${i}`).trim());
  });

  if (errors.length > 0) {
    return { ok: false, errors, docId: null, hash: null, rowKey: null, record: null, reviewDate };
  }

  const answerObjs = indicator.questions.map((q, i) => {
    const label = answers[i];
    const excluded = label === "不適用" || label === "";
    const note = notes[i];
    return {
      questionId: q.id,
      itemText: q.itemText,
      optionLabel: label,
      score: label === "是" ? 1 : 0,
      excluded,
      ...(note ? { note } : {}),
    };
  });
  let totalScore = 0;
  let maxScore = 0;
  for (const a of answerObjs) {
    if (!a.excluded) {
      maxScore += 1;
      totalScore += a.score;
    }
  }
  const rate = maxScore > 0 ? Math.round((totalScore / maxScore) * 1000) / 10 : null;

  const hashInput = {
    spreadsheetId: mapping.spreadsheetId,
    sheetName: mapping.sheetName,
    timestamp,
    indicatorId: indicator.id,
    unitCode,
    year: ym.year,
    month: ym.month,
    reviewerId,
    personEmpNo,
    bedNo,
    answers,
    notes,
  };
  const hash = importRecordHash(hashInput);
  const docId = importRecordDocId(hashInput);
  const rowKey = syncRowKey(hashInput);

  const snapshot = taskSnapshot
    ? {
        indicatorVersionAtSchedule: taskSnapshot.indicatorVersionAtSchedule ?? null,
        thresholdAtSchedule:
          typeof taskSnapshot.thresholdAtSchedule === "number"
            ? taskSnapshot.thresholdAtSchedule
            : null,
        thresholdRuleAtSchedule: taskSnapshot.thresholdRuleAtSchedule ?? ">=",
        scheduleStartYear: taskSnapshot.scheduleStartYear ?? ym.year,
        scheduleStartMonth: taskSnapshot.scheduleStartMonth ?? ym.month,
        scheduleEndYear: taskSnapshot.scheduleEndYear ?? ym.year,
        scheduleEndMonth: taskSnapshot.scheduleEndMonth ?? ym.month,
        snapshotSource: "reviewTask",
      }
    : {
        indicatorVersionAtSchedule: indicator.version ?? null,
        thresholdAtSchedule: effectiveThreshold(indicator),
        thresholdRuleAtSchedule: ">=",
        scheduleStartYear: ym.year,
        scheduleStartMonth: ym.month,
        scheduleEndYear: ym.year,
        scheduleEndMonth: ym.month,
        snapshotSource: "indicator-current",
      };

  const record = {
    taskId: taskSnapshot?.id ?? "",
    indicatorId: indicator.id,
    unitId: unitCode,
    reviewerId,
    year: ym.year,
    month: ym.month,
    caseSeq: null,
    reviewDate: reviewDate ?? `${ym.year}-${String(ym.month).padStart(2, "0")}-01`,
    reviewerEmpNo: reviewerId,
    reviewerName: reviewerId ? staffName(reviewerId) : "",
    reviewedPersonEmpNo: personEmpNo,
    reviewedPersonName: staffName(personEmpNo),
    bedNo,
    answers: answerObjs,
    totalScore,
    maxScore,
    rate,
    submittedBy: "sheet-sync",
    source: "sheet-sync",
    ...snapshot,
  };
  return { ok: true, errors: [], docId, hash, rowKey, record, reviewDate: record.reviewDate };
}

/** 指標閾值（與 src/lib/indicators.ts effectiveThreshold 同規則）。 */
export function effectiveThreshold(ind) {
  const b = ind?.basicThreshold;
  if (typeof b === "number" && Number.isFinite(b)) return b;
  const steps = ind?.tenSteps;
  const thresholds =
    steps && typeof steps === "object" && Array.isArray(steps.step5) ? steps.step5 : null;
  const t0 = thresholds?.[0];
  if (t0 && typeof t0 === "object" && typeof t0.value === "number" && Number.isFinite(t0.value))
    return t0.value;
  if (typeof t0 === "number" && Number.isFinite(t0)) return t0;
  return 0;
}

/* ================= Firestore REST 值編碼（遞迴，支援陣列／map／時間戳） ================= */

export function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    if (Number.isInteger(v)) return { integerValue: String(v) };
    return { doubleValue: v };
  }
  if (typeof v === "string") return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === "object") {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = encodeValue(val);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

export function encodeFirestoreFields(values) {
  const fields = {};
  for (const [k, v] of Object.entries(values)) fields[k] = encodeValue(v);
  return { fields };
}

export function decodeValue(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v)
    return (v.arrayValue.values ?? []).map(decodeValue);
  if ("mapValue" in v) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields ?? {})) out[k] = decodeValue(val);
    return out;
  }
  return null;
}

/** Firestore REST 文件 JSON → 平面物件（遞迴解碼，含陣列／map）。 */
export function decodeFirestoreDoc(json) {
  if (!json || typeof json !== "object" || !json.fields || typeof json.fields !== "object") {
    return null;
  }
  const out = {};
  for (const [k, v] of Object.entries(json.fields)) out[k] = decodeValue(v);
  return out;
}
