/**
 * 資料庫狀態卡（系統管理 → 流量控管上方）：
 * 目前的主資料庫／備援、運作模式、待同步筆數，以及各自的用量對上限。
 * Firebase 的當日用量條仍由下方「流量控管」區顯示；這裡只放 Supabase 的資料庫大小。
 */
import { useCallback, useEffect, useState } from "react";
import { dualClearEvents, dualDrainNow, dualEvents, dualHealth, dualRequested, dualRetryDeadLetters, fetchSupabaseUsage, watchDualHealth } from "../lib/dual/bootstrap";
import {
  SUPABASE_LIMITS, dbLabel, describeHealth, formatBytes, level, pct, type SupabaseUsage,
} from "../lib/dual/status";
import { fmtIsoDateTime } from "../lib/ym";

const TONE_COLOR = { ok: "#16a34a", warn: "#d97706", bad: "#dc2626" } as const;
const LEVEL_COLOR = { ok: "#16a34a", warn: "#d97706", stop: "#dc2626" } as const;
const BREAKER_TEXT = { closed: "正常", open: "無法連線", "half-open": "重新試連中" } as const;

function Bar({ label, used, quota, text }: { label: string; used: number; quota: number; text: string }) {
  const p = pct(used, quota);
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <b>{label}</b>
        <span>{text}（{p.toFixed(1)}%）</span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label}用量`}
        aria-valuenow={Math.round(Math.min(p, 100))}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{ height: 8, background: "#e5e7eb", borderRadius: 4, overflow: "hidden" }}
      >
        <div style={{ width: `${Math.min(p, 100)}%`, height: "100%", background: LEVEL_COLOR[level(p)] }} />
      </div>
    </div>
  );
}

export function DbStatusSection() {
  const [, tick] = useState(0);
  const [usage, setUsage] = useState<SupabaseUsage | null>(null);
  const [usageError, setUsageError] = useState("");
  const [busy, setBusy] = useState(false);
  const health = dualHealth();

  const loadUsage = useCallback(async () => {
    if (!dualRequested) return;
    try {
      setUsage(await fetchSupabaseUsage());
      setUsageError("");
    } catch (e) {
      setUsageError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadUsage();
    // 狀態是記憶體內讀取，免費；與全站共用同一個輪詢，分頁在背景時不更新
    return watchDualHealth(() => tick((n) => n + 1));
  }, [loadUsage]);

  if (!health) {
    return (
      <section className="panel" id="db-status">
        <h3 style={{ marginTop: 0 }}>資料庫狀態</h3>
        <p className="settings-note">
          目前資料庫：<b>Firebase</b>（單一資料庫，雙寫備援未啟用）。
          {dualRequested ? "雙寫設定已開啟，但尚未完成初始化。" : "要啟用請設定 VITE_DB_MODE=dual 與 Supabase 連線資訊。"}
        </p>
      </section>
    );
  }

  const line = describeHealth(health);
  const events = dualEvents();
  const sync = async (): Promise<void> => {
    setBusy(true);
    try { await dualDrainNow(); } finally { setBusy(false); tick((n) => n + 1); }
  };
  const retryDead = async (): Promise<void> => {
    setBusy(true);
    try { await dualRetryDeadLetters(); } finally { setBusy(false); tick((n) => n + 1); }
  };

  return (
    <section className="panel" id="db-status">
      <h3 style={{ marginTop: 0 }}>資料庫狀態</h3>
      <p style={{ margin: "0 0 8px", color: TONE_COLOR[line.tone], fontWeight: 600 }} role="status">{line.text}</p>
      {health.queueError && <p role="alert" style={{ color: TONE_COLOR.bad }}>同步佇列異常：{health.queueError}；為避免遺失待同步資料，已拒絕新寫入。</p>}
      {health.deadLetters > 0 && <p role="alert" style={{ color: TONE_COLOR.bad }}>有 {health.deadLetters} 筆同步項目已保留待人工重試；先修正資料庫權限／資料錯誤，再按「重試保留項目」。</p>}
      <table className="data-table" style={{ marginBottom: 12 }}>
        <thead>
          <tr><th>角色</th><th>資料庫</th><th>連線狀態</th><th>待同步</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><b>主資料庫</b>{health.mode === "failover" ? "（目前停用）" : "（目前使用中）"}</td>
            <td>{dbLabel(health.primary.name)}</td>
            <td>{BREAKER_TEXT[health.primary.breaker]}</td>
            <td>{health.pendingToPrimary} 筆待補回</td>
          </tr>
          <tr>
            <td><b>備援</b>{health.mode === "failover" ? "（目前使用中）" : ""}</td>
            <td>{dbLabel(health.secondary.name)}</td>
            <td>{BREAKER_TEXT[health.secondary.breaker]}</td>
            <td>{health.pendingToSecondary} 筆待複寫</td>
          </tr>
        </tbody>
      </table>

      <p className="settings-note" style={{ marginBottom: 6 }}>{dbLabel(health.primary.name)} 用量</p>
      {usage ? (
        <>
          <Bar
            label="資料庫大小"
            used={usage.dbBytes}
            quota={SUPABASE_LIMITS.dbBytes}
            text={`${formatBytes(usage.dbBytes)} / ${formatBytes(SUPABASE_LIMITS.dbBytes)}`}
          />
          <p className="settings-note">
            文件數 {usage.docCount.toLocaleString()}
            {Object.keys(usage.byCol).length > 0 &&
              `（最多：${Object.entries(usage.byCol).slice(0, 3).map(([k, n]) => `${k} ${n}`).join("、")}）`}
            ；每月傳輸量（上限 {SUPABASE_LIMITS.egressGb} GB）與閒置暫停狀態需到 Supabase 後台 Reports 查看。
          </p>
        </>
      ) : (
        <p className="settings-note">
          {usageError
            ? `讀取 Supabase 用量失敗：${usageError}（需已執行 supabase/04-status.sql，且為系統管理員）`
            : "讀取中…"}
        </p>
      )}
      <p className="settings-note">
        {dbLabel(health.secondary.name)} 的當日讀／寫／刪用量與上限見下方「流量控管」。
        免費方案上限：Supabase 資料庫 500 MB、每月傳輸 5 GB、閒置一週會被暫停。
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="button button-outline" type="button" onClick={() => void sync()} disabled={busy}>
          {busy ? "同步中…" : "立即同步"}
        </button>
        {health.deadLetters > 0 && <button className="button button-outline" type="button" onClick={() => void retryDead()} disabled={busy}>
          {busy ? "重試中…" : "重試保留項目"}
        </button>}
        <button className="button button-outline" type="button" onClick={() => void loadUsage()}>重新整理用量</button>
      </div>

      <h4 style={{ margin: "16px 0 6px" }}>最近事件</h4>
      {events.length === 0 ? (
        <p className="settings-note">目前沒有事件記錄。</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 220, overflowY: "auto", fontSize: 13 }}>
          {events.map((ev, i) => (
            <li key={`${ev.ts}-${i}`} style={{ padding: "3px 0", borderBottom: "1px solid #eee", color: TONE_COLOR[ev.level === "info" ? "ok" : ev.level] }}>
              <span style={{ color: "#6b7280", marginRight: 8 }}>{fmtIsoDateTime(ev.ts)}</span>
              {ev.text}
            </li>
          ))}
        </ul>
      )}
      <p className="settings-note">只記錄在這台電腦的瀏覽器上，最多 50 筆，不含資料內容。</p>
      {events.length > 0 && (
        <button className="button button-outline" type="button" onClick={() => { dualClearEvents(); tick((n) => n + 1); }}>清除記錄</button>
      )}
    </section>
  );
}
