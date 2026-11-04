import {
  ArrowRight,
  ChevronRight,
  GitBranch,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  ShieldCheck,
  Users,
} from "lucide-react";
import { PageHeading, SectionTitle } from "../components/ui";

export function GroupsPage({
  firebaseMode,
  onAction,
}: {
  firebaseMode: boolean;
  onAction: (message: string) => void;
}) {
  if (firebaseMode) {
    return (
      <>
        <PageHeading page="groups" />
        <section className="panel not-connected-state" role="status">
          <h2>群組與審查員管理尚未串接</h2>
          <p>
            目前沒有 Firestore
            人員清單、審查員新增／指派或群組權限寫入功能；不會把展示資料當成真實帳號，也不會修改
            users 權限。
          </p>
        </section>
      </>
    );
  }
  return (
    <>
      <PageHeading
        page="groups"
        action={
          <button
            className="button button-primary"
            onClick={() => onAction("展示版不會建立真實群組或授權")}
          >
            <Plus size={16} />
            新增群組
          </button>
        }
      />
      <div className="group-layout">
        <section className="panel group-tree-panel">
          <SectionTitle
            title="組織群組階層"
            note="群組可逐層建立次群組"
            action={
              <button
                className="icon-button"
                aria-label="群組更多操作"
                onClick={() => onAction("群組操作僅供展示")}
              >
                <MoreHorizontal size={17} />
              </button>
            }
          />
          <div className="tree-root">
            <div className="tree-node root">
              <span className="tree-symbol">
                <Users size={17} />
              </span>
              <div>
                <b>示範醫療機構</b>
                <small>全院 · 1,500 位成員（展示）</small>
              </div>
              <span className="tree-role">全院負責人</span>
            </div>
            <div className="tree-children">
              {[
                {
                  name: "病房組",
                  count: "680 位成員",
                  heads: "組長 2 · 執行幹事 3",
                  children: ["示範內科病房", "示範外科病房"],
                },
                {
                  name: "加護組",
                  count: "210 位成員",
                  heads: "組長 1 · 執行幹事 2",
                  children: ["示範加護病房"],
                },
                {
                  name: "急診組",
                  count: "145 位成員",
                  heads: "組長 1 · 執行幹事 1",
                  children: ["示範急診單位"],
                },
              ].map((group) => (
                <div className="tree-branch" key={group.name}>
                  <div className="tree-node">
                    <span className="tree-symbol">
                      <GitBranch size={16} />
                    </span>
                    <div>
                      <b>{group.name}</b>
                      <small>
                        {group.count} · {group.heads}
                      </small>
                    </div>
                    <button
                      className="icon-button"
                      onClick={() =>
                        onAction(`${group.name} 成員只顯示虛構資料`)
                      }
                      aria-label="查看群組"
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                  <div className="tree-leaves">
                    {group.children.map((child) => (
                      <div className="tree-leaf" key={child}>
                        <span className="leaf-line" />
                        <span>{child}</span>
                        <small>單位次群組</small>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
        <section className="panel group-side-panel">
          <SectionTitle title="群組授權原則" note="目前展示設定" />
          <div className="rule-card">
            <span className="rule-icon">
              <ShieldCheck size={18} />
            </span>
            <b>範圍沿群組繼承</b>
            <p>
              組長可管理所屬群組成員與下層群組；不得授予超出自己資料範圍的權限。
            </p>
          </div>
          <div className="rule-card">
            <span className="rule-icon blue">
              <Users size={18} />
            </span>
            <b>多位負責人協作</b>
            <p>每個群組可設多位組長及協同負責人（執行幹事）。</p>
          </div>
          <div className="rule-card">
            <span className="rule-icon amber">
              <LockKeyhole size={18} />
            </span>
            <b>管理員授權全院</b>
            <p>系統管理員可設定全院資料範圍；正式環境須保留完整稽核軌跡。</p>
          </div>
          <button
            className="button button-outline full-width"
            onClick={() => onAction("已開啟展示角色權限")}
          >
            檢視角色權限 <ArrowRight size={15} />
          </button>
        </section>
      </div>
    </>
  );
}
