import { BatchImporter } from "../../components/BatchImporter";
import { USER_SAMPLE, USER_HEADER } from "../../importers/samples";
import type { GroupsCtx } from "../../hooks/useGroupsCtx";

export function UserImportBar({ ctx }: { ctx: GroupsCtx }) {
  const { tab, userView, isAdmin, validateUserRows, importUserRows, loadUsers, onAction } = ctx;

  return <>{tab === "users" && userView.kind !== "edit" && isAdmin && (
        <div className="batch-toolbar">
          <BatchImporter
            sampleBaseName="人員範例"
            sampleRows={USER_SAMPLE}
            header={USER_HEADER}
            validateRows={validateUserRows}
            importRows={importUserRows}
            sampleNote="範例：單位代號填入單位主檔的代號；職稱填現有職稱名稱；品管組與角色須按欄位成對填寫，可填兩組。"
            postImportNote="提醒：登入帳號由「Provision auth accounts」每小時自動對帳建立（也可到 GitHub Actions 手動執行）；人員從名單刪除或停用時，帳號也會一併刪除或停用。人員再於登入頁按「開通帳號」，到院內信箱（職編去掉開頭的 0＋@kmuh.org.tw）收認證連結設定密碼。"
            onDone={loadUsers}
            onAction={onAction}
          />
        </div>
      )}</>;
}
