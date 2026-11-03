import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  Database,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { doc, getDoc } from "../lib/db";
import { EmptyState, PageHeading, SectionTitle } from "../components/ui";
import { getFirebaseDb } from "../lib/firebase";
import { isDemoMode } from "../lib/demoMode";
import { useAuth } from "../lib/auth";
import {
  SYSTEM_PARAM_LABELS,
  runSystemSeed,
  type SystemParams,
} from "../lib/seed";

function formatParamValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return "—";
}

function SystemInitSection({ onAction }: { onAction: (message: string) => void }) {
  const { user } = useAuth();
  const [params, setParams] = useState<SystemParams | null | undefined>(undefined);
  const [seeding, setSeeding] = useState(false);
  const isAdmin = user?.roles.includes("系統管理員") ?? false;

  useEffect(() => {
    let cancelled = false;
    getDoc(doc(getFirebaseDb(), "systemParams", "config"))
      .then((snap) => {
        if (!cancelled) setParams(snap.exists() ? (snap.data() as SystemParams) : null);
      })
      .catch(() => {
        if (!cancelled) setParams(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSeed() {
    if (!user || seeding) return;
    setSeeding(true);
    try {
      await runSystemSeed(getFirebaseDb(), user.staffId);
      const snap = await getDoc(doc(getFirebaseDb(), "systemParams", "config"));
      setParams(snap.exists() ? (snap.data() as SystemParams) : null);
      onAction("系統初始化完成：已寫入預設參數與 7 個角色");
    } catch {
      onAction("初始化失敗：權限不足或網路異常，請稍後再試");
    } finally {
      setSeeding(false);
    }
  }

  return (
    <section className="panel data-panel">
      <SectionTitle
        title="系統初始化"
        note={
          isDemoMode()
            ? "展示模式：系統參數、角色、職稱與展示資料已預載"
            : "首次啟用時寫入預設參數與角色"
        }
      />
      {params === undefined ? (
        <p className="settings-note">讀取中…</p>
      ) : params === null ? (
        isAdmin ? (
          <div>
            <p className="settings-note">
              尚未初始化。將寫入 systemParams/config 預設參數（RAG
              黃燈區間、補審期限、草稿保留天數等）與 7 個預設角色定義。
            </p>
            <button
              className="button button-primary"
              disabled={seeding}
              onClick={handleSeed}
            >
              <Database size={15} />
              {seeding ? "寫入中…" : "一鍵初始化系統參數與角色"}
            </button>
          </div>
        ) : (
          <p className="settings-note">
            系統尚未初始化，請聯絡系統管理員執行初始化。
          </p>
        )
      ) : (
        <dl className="param-list">
          {(Object.keys(SYSTEM_PARAM_LABELS) as (keyof SystemParams)[]).map(
            (key) => (
              <div key={key} className="param-row">
                <dt>{SYSTEM_PARAM_LABELS[key]}</dt>
                <dd>{formatParamValue(params[key])}</dd>
              </div>
            ),
          )}
        </dl>
      )}
    </section>
  );
}

export function AdminPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  const permissions = [
    ["結果查詢", "本人", "本人", "所屬單位", "全院", "全院", "依設定"],
    ["檢視審查照片", "—", "本人經手", "所屬單位", "全院", "全院", "—"],
    ["排程建立／改派", "—", "—", "—", "—", "全院", "—"],
    ["修改已提交審查", "—", "本人", "—", "—", "離職代改", "—"],
    ["管理角色與權限", "—", "—", "—", "—", "全院", "—"],
  ];
  return (
    <>
      <PageHeading
        page="admin"
        action={
          <button
            className="button button-outline"
            onClick={() => onAction("資料串接完成後才能調整系統參數")}
          >
            <SlidersHorizontal size={15} />
            系統參數
          </button>
        }
      />
      <div className="admin-alert">
        <ShieldCheck size={17} />
        <span>
          <b>權限矩陣</b> ·
          角色可由系統管理員動態建立，不需修改程式；正式授權以系統管理員設定為準。
        </span>
      </div>
      <SystemInitSection onAction={onAction} />
      <section className="panel data-panel permission-panel">
        <SectionTitle
          title="功能 × 資料範圍"
          note="依需求規格整理的授權基線"
          action={
            <button
              className="text-button"
              onClick={() => onAction("正式上線前需由院方核定權限矩陣")}
            >
              權限原則 <ArrowRight size={14} />
            </button>
          }
        />
        <div className="table-scroll">
          <table className="permission-table">
            <thead>
              <tr>
                <th>功能</th>
                {[
                  "一般人員",
                  "審查員",
                  "護理長",
                  "督導以上",
                  "品管幹事",
                  "系統管理員",
                  "指標負責人",
                ].map((name) => (
                  <th key={name}>{name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {permissions.map((row) => (
                <tr key={row[0]}>
                  <td>
                    <b>{row[0]}</b>
                  </td>
                  {row.slice(1).map((cell, index) => (
                    <td key={`${row[0]}-${index}`}>
                      {cell === "—" ? (
                        <span className="permission-none">—</span>
                      ) : (
                        <span
                          className={
                            cell === "全院"
                              ? "permission-all"
                              : "permission-cell"
                          }
                        >
                          {cell}
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <EmptyState
        title="系統參數尚未串接"
        description="參數值、稽核軌跡與人員主檔將在 Firestore 串接完成後顯示與管理。"
      />
      <div className="admin-settings-grid">
        <section className="panel settings-panel">
          <SectionTitle title="稽核軌跡" note="不可關閉的必要紀錄" />
          <div className="audit-logs">
            {[
              "登入、登出與失敗",
              "角色與權限變更",
              "資料修改前後內容",
              "結果、照片與匯出查閱",
            ].map((line) => (
              <div key={line}>
                <span className="log-check">
                  <Check size={13} />
                </span>
                <span>{line}</span>
                <span className="log-required">必開</span>
              </div>
            ))}
          </div>
          <p className="settings-note">
            審查資料與稽核紀錄保存 3 年（可於系統參數調整）。
          </p>
        </section>
      </div>
    </>
  );
}
