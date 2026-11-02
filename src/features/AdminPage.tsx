import {
  ArrowRight,
  Check,
  ChevronRight,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { PageHeading, SectionTitle } from "../components/ui";

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
            onClick={() => onAction("展示版設定不會存入 Firebase")}
          >
            <SlidersHorizontal size={15} />
            系統參數
          </button>
        }
      />
      <div className="admin-alert">
        <ShieldCheck size={17} />
        <span>
          <b>展示權限矩陣</b> ·
          組長只管理所屬群組與下層次群組；管理員可授予全院範圍。此表不代表正式授權。
        </span>
      </div>
      <section className="panel data-panel permission-panel">
        <SectionTitle
          title="功能 × 資料範圍"
          note="依需求規格整理的展示基線"
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
      <div className="admin-settings-grid">
        <section className="panel settings-panel">
          <SectionTitle title="系統參數" note="展示項目" />
          <SettingRow title="補審截止日" value="次月 10 日" />
          <SettingRow title="伺服器草稿保留" value="30 天" />
          <SettingRow title="草稿到期提醒" value="到期前 5 天" />
          <SettingRow title="資料保存政策" value="原則上不刪除" />
        </section>
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
            資料原則上不刪除；實際保存年限依院方政策設定。
          </p>
        </section>
      </div>
    </>
  );
}

function SettingRow({ title, value }: { title: string; value: string }) {
  return (
    <div className="setting-row">
      <span>{title}</span>
      <b>{value}</b>
      <ChevronRight size={15} />
    </div>
  );
}
