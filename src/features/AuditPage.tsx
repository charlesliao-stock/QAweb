import { ShieldCheck } from "lucide-react";
import { EmptyState, PageHeading } from "../components/ui";

export function AuditPage({
  onAction,
}: {
  onAction: (message: string) => void;
}) {
  void onAction;
  return (
    <>
      <PageHeading page="audit" />
      <div className="privacy-note">
        <ShieldCheck size={16} />
        <span>
          <b>隱私提醒</b>
          ：稽核時請勿拍攝病人臉部或可辨識身分之資訊。
        </span>
      </div>
      <EmptyState
        title="目前沒有指派給你的審查任務"
        description="審查題目、版本快照與作答將在排程資料串接完成後顯示。"
      />
    </>
  );
}
