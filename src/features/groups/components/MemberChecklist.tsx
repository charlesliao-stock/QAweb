import { SectionTitle } from "../../../components/ui";

// ================= 成員勾選清單共用（v1.21：全選＋批次移除） =================

export function MemberChecklist({
  title,
  note,
  emptyText = "尚無成員。",
  idLabel = "職編／代號",
  nameLabel = "姓名／名稱",
  columns = [],
  /** v1.88.19：置於職編／姓名之前的欄位（角色成員表照「品管組、角色、單位、職編、姓名」順序用） */
  leadingColumns = [],
  // v1.88.16：可選的操作欄（職稱成員管理合併表用；未傳 onRowAction 時該格顯示「—」）
  actionLabel,
  rowActionLabel,
  onRowAction,
  items,
  checked,
  onToggle,
  onToggleAll,
  onRemoveSelected,
  removeLabel,
  busy,
}: {
  title: string;
  note?: string;
  emptyText?: string;
  idLabel?: string;
  nameLabel?: string;
  columns?: { key: string; label: string }[];
  leadingColumns?: { key: string; label: string }[];
  actionLabel?: string;
  rowActionLabel?: string;
  onRowAction?: (id: string) => void;
  items: { id: string; label: string; sub?: string; fields?: Record<string, string> }[];
  checked: string[];
  onToggle: (id: string, next: boolean) => void;
  onToggleAll: (next: boolean) => void;
  onRemoveSelected: () => void;
  removeLabel: string;
  busy: boolean;
}) {
  const allChecked =
    items.length > 0 && items.every((i) => checked.includes(i.id));
  return (
    <div>
      <SectionTitle title={title} note={note} />
      {items.length === 0 ? (
        <p className="settings-note">{emptyText}</p>
      ) : (
        <>
          <div className="table-scroll">
            <table className="permission-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={(e) => onToggleAll(e.target.checked)}
                      aria-label="全選"
                    />
                  </th>
                  {leadingColumns.map((column) => <th key={column.key}>{column.label}</th>)}
                  <th>{idLabel}</th>
                  <th>{nameLabel}</th>
                  {columns.map((column) => <th key={column.key}>{column.label}</th>)}
                  {actionLabel != null && <th>{actionLabel}</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={checked.includes(it.id)}
                        onChange={(e) => onToggle(it.id, e.target.checked)}
                        aria-label={`選擇 ${it.id}`}
                      />
                    </td>
                    {leadingColumns.map((column) => (
                      <td key={column.key}>{it.fields?.[column.key] || "—"}</td>
                    ))}
                    <td>
                      <b>{it.id}</b>
                    </td>
                    <td>{it.label}{it.sub ? `（${it.sub}）` : ""}</td>
                    {columns.map((column) => (
                      <td key={column.key}>{it.fields?.[column.key] || "—"}</td>
                    ))}
                    {actionLabel != null && (
                      <td>
                        {onRowAction ? (
                          <button
                            className="text-button"
                            onClick={() => onRowAction(it.id)}
                          >
                            {rowActionLabel ?? "管理"}
                          </button>
                        ) : (
                          "—"
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-actions">
            <button
              className="button button-outline"
              disabled={checked.length === 0 || busy}
              onClick={onRemoveSelected}
            >
              {removeLabel}（{checked.length}）
            </button>
          </div>
        </>
      )}
    </div>
  );
}
