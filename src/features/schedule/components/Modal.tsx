import type { ReactNode } from "react";
import { X } from "lucide-react";

/* ================= 共用小元件 ================= */

export function Modal({
  title,
  note,
  onClose,
  wide,
  medium,
  layer,
  children,
}: {
  title: string;
  note?: string;
  onClose: () => void;
  /** v1.20：寬版（查閱視窗 2 倍寬） */
  wide?: boolean;
  /** v1.60.0：中寬（約 960px），加審對話框用 */
  medium?: boolean;
  /** v1.60.0：巢狀彈窗層級（2＝第二層） */
  layer?: 1 | 2 | 3;
  children: ReactNode;
}) {
  return (
    <div
      className={`reviewer-modal-backdrop${layer != null && layer > 1 ? ` reviewer-modal-layer-${layer}` : ""}`}
      onClick={onClose}
    >
      <div
        className={`reviewer-modal panel${wide ? " wide" : ""}${medium ? " medium" : ""}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="reviewer-modal-head">
          <div>
            <h2>{title}</h2>
            {note && <p>{note}</p>}
          </div>
          <button
            className="button button-ghost"
            onClick={onClose}
            aria-label="關閉"
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
