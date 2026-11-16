/**
 * 寄信記錄（v1.84.0，系統管理 → 寄信記錄，僅系統管理員）：
 * 顯示登入頁「開通帳號／忘記密碼」最近的寄信嘗試。
 * 這是前端回報（寄信時尚未登入、Spark 無後端），僅供參考，任何人都可能偽造或灌入；
 * 「已受理」代表 Firebase 接受了寄信請求，不保證信件已送達或未被郵件閘道攔截。
 * 為節省 Spark 讀取額度，只在按「載入」時讀最近 50 筆。直接讀 Firestore，不走雙寫層。
 */
import { useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import {
  collection, doc, getDocs, limit, orderBy, query, writeBatch, type Timestamp,
} from "firebase/firestore";
import { SectionTitle } from "../components/ui";
import { getFirebaseDb } from "../lib/firebase";
import { toErrorMessage } from "../lib/errors";

interface MailLogRow { id: string; staffId: string; result: string; at: Date | null }

const RESULT_TEXT: Record<string, { text: string; tone: "ok" | "warn" | "bad" }> = {
  accepted: { text: "已受理（Firebase 已送出）", tone: "ok" },
  "user-not-found": { text: "帳號不存在（尚未建立或職編錯誤）", tone: "warn" },
  "quota-exceeded": { text: "超過每日寄信額度", tone: "bad" },
  "too-many-requests": { text: "請求過於頻繁，被暫時限制", tone: "bad" },
  "invalid-email": { text: "職編格式不正確", tone: "warn" },
  "network-request-failed": { text: "網路連線失敗", tone: "bad" },
};
const TONE_COLOR = { ok: "#16a34a", warn: "#d97706", bad: "#dc2626" } as const;

function fmt(d: Date | null): string {
  if (!d) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function MailLogSection({ onAction }: { onAction: (m: string) => void }) {
  const [rows, setRows] = useState<MailLogRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setBusy(true);
    setError("");
    try {
      const snap = await getDocs(
        query(collection(getFirebaseDb(), "mailLogs"), orderBy("at", "desc"), limit(50)),
      );
      setRows(
        snap.docs.map((d) => {
          const v = d.data();
          const at = v.at as Timestamp | null | undefined;
          return {
            id: d.id,
            staffId: typeof v.staffId === "string" ? v.staffId : "",
            result: typeof v.result === "string" ? v.result : "",
            at: at && typeof at.toDate === "function" ? at.toDate() : null,
          };
        }),
      );
    } catch (err) {
      setError(toErrorMessage(err, "載入失敗"));
    } finally {
      setBusy(false);
    }
  }

  async function clearShown() {
    if (!rows || rows.length === 0) return;
    if (!window.confirm(`確定清除目前顯示的 ${rows.length} 筆寄信記錄？（無法復原）`)) return;
    setBusy(true);
    setError("");
    try {
      const db = getFirebaseDb();
      const batch = writeBatch(db);
      for (const r of rows) batch.delete(doc(db, "mailLogs", r.id));
      await batch.commit();
      onAction(`已清除 ${rows.length} 筆寄信記錄`);
      setRows([]);
    } catch (err) {
      setError(toErrorMessage(err, "清除失敗"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel settings-panel">
      <SectionTitle
        title="寄信記錄"
        note="登入頁「開通帳號／忘記密碼」最近 50 筆寄信嘗試。前端回報，僅供參考（可能被偽造）；「已受理」不保證信件已送達，仍須確認信箱與垃圾信。"
      />
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button className="button button-outline" onClick={() => void load()} disabled={busy}>
          <RefreshCw size={15} /> {busy ? "處理中…" : rows ? "重新載入" : "載入最近 50 筆"}
        </button>
        {rows && rows.length > 0 && (
          <button className="button button-danger" onClick={() => void clearShown()} disabled={busy}>
            <Trash2 size={15} /> 清除目前顯示的記錄
          </button>
        )}
      </div>
      <p className="settings-note">每次載入約讀取 50 筆（計入 Firestore 每日讀取額度）。</p>
      {error && <div className="login-error">{error}</div>}
      {rows && rows.length === 0 && <p className="settings-note">目前沒有記錄。</p>}
      {rows && rows.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr><th>時間</th><th>職編</th><th>結果</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const info = RESULT_TEXT[r.result] ?? { text: `其他（${r.result || "未知"}）`, tone: "warn" as const };
                return (
                  <tr key={r.id}>
                    <td data-label="時間">{fmt(r.at)}</td>
                    <td data-label="職編">{r.staffId}</td>
                    <td data-label="結果" style={{ color: TONE_COLOR[info.tone] }}>{info.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
