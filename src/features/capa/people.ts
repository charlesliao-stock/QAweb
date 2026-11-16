import { collection, getDocs, query, where } from "../../lib/db";
import { getFirebaseDb } from "../../lib/firebase";

export interface CapaPerson {
  id: string;
  name: string;
}

interface UserRow {
  id: string;
  name: string;
  roles: string[];
  status: string;
}

/** 角色名稱比對：完全相同優先；其次包含（排除「副」開頭，避免副護理長被當成護理長） */
function pickByRole(rows: UserRow[], role: string): CapaPerson | undefined {
  const wanted = role.trim();
  if (!wanted) return undefined;
  const active = rows.filter((row) => row.status !== "停用" && row.status !== "離職");
  const exact = active.find((row) => row.roles.includes(wanted));
  const hit =
    exact ??
    active.find((row) => row.roles.some((r) => r.includes(wanted) && !r.startsWith("副")));
  return hit ? { id: hit.id, name: hit.name } : undefined;
}

function toRows(snapshot: { docs: Array<{ id: string; data: () => unknown }> }): UserRow[] {
  return snapshot.docs.map((d) => {
    const v = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      name: typeof v.name === "string" ? v.name : d.id,
      roles: Array.isArray(v.roles) ? v.roles.map(String) : [],
      status: typeof v.status === "string" ? v.status : "",
    };
  });
}

/**
 * 依單位找預設人員：負責人＝該單位內具 ownerRole（預設護理長）角色者；
 * 核准者＝督導（督導以 titleUnitCodes 管轄多單位，故以管轄單位查）。
 * 使用者清單僅管理員／幹事可讀；讀取失敗時回傳空物件，由呼叫端退回預設。
 */
export async function findUnitPeople(
  unitCode: string,
  ownerRole: string,
  approverRole: string,
): Promise<{ owner?: CapaPerson; approver?: CapaPerson }> {
  if (!unitCode) return {};
  const db = getFirebaseDb();
  const [inUnit, supervised] = await Promise.all([
    getDocs(query(collection(db, "users"), where("unitCode", "==", unitCode))).catch(() => null),
    getDocs(query(collection(db, "users"), where("titleUnitCodes", "array-contains", unitCode))).catch(() => null),
  ]);
  return {
    owner: inUnit ? pickByRole(toRows(inUnit), ownerRole) : undefined,
    approver: supervised
      ? pickByRole(toRows(supervised), approverRole) ?? (inUnit ? pickByRole(toRows(inUnit), approverRole) : undefined)
      : inUnit
        ? pickByRole(toRows(inUnit), approverRole)
        : undefined,
  };
}
