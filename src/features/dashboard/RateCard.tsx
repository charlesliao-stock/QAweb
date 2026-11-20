/**
 * 儀表板比率卡（v1.88.35 四群共用）：大字百分比＋（分子／分母）。
 */
import { SectionTitle } from "../../components/ui";
import type { RateResult } from "../../lib/dashboardGroups";

export function RateCard({
  title,
  note,
  result,
}: {
  title: string;
  note?: string;
  result: RateResult;
}) {
  return (
    <section className="panel">
      <SectionTitle title={title} note={note} />
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <strong style={{ fontSize: 32 }}>
          {result.rate != null ? `${result.rate}%` : "—"}
        </strong>
        <span className="muted-text">
          （{result.done}/{result.total}）
        </span>
      </div>
    </section>
  );
}
