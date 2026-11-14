import { collection, doc, getDoc, getDocs, serverTimestamp, setDoc } from "../../lib/db";
import { getFirebaseDb } from "../../lib/firebase";
import { isDemoMode } from "../../lib/demoMode";
import { logAudit } from "../../lib/audit";
import type { CapaCase, CapaSettings, CapaTemplate } from "./model";
import { DEFAULT_CAPA_SETTINGS, DEMO_CAPA_CASES, DEMO_CAPA_TEMPLATES } from "./model";

const db = () => getFirebaseDb();
const CASES = "capa";
let demoInitialized = false;

async function seedDemoIfNeeded(): Promise<void> {
  if (!isDemoMode() || demoInitialized) return;
  demoInitialized = true;
  const [cases, settings] = await Promise.all([
    getDocs(collection(db(), CASES)),
    getDoc(doc(db(), "systemParams", "capaSettings")),
  ]);
  if (cases.empty) {
    await Promise.all(DEMO_CAPA_CASES.map((item) => setDoc(doc(db(), CASES, item.id), item)));
  }
  if (!settings.exists()) {
    await setDoc(doc(db(), "systemParams", "capaSettings"), { ...DEFAULT_CAPA_SETTINGS, templates: DEMO_CAPA_TEMPLATES });
  } else if (!Array.isArray((settings.data() as { templates?: unknown }).templates)) {
    await setDoc(doc(db(), "systemParams", "capaSettings"), { templates: DEMO_CAPA_TEMPLATES }, { merge: true });
  }
}

function dataRows<T extends { id: string }>(snapshot: { docs: Array<{ id: string; data: () => unknown }> }): T[] {
  return snapshot.docs.map((item) => ({ ...(item.data() as Omit<T, "id">), id: item.id }) as T);
}

export async function loadCapaCases(): Promise<CapaCase[]> {
  await seedDemoIfNeeded();
  const snapshot = await getDocs(collection(db(), CASES));
  return dataRows<CapaCase>(snapshot).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadCapaSettings(): Promise<CapaSettings> {
  await seedDemoIfNeeded();
  const snapshot = await getDoc(doc(db(), "systemParams", "capaSettings"));
  if (!snapshot.exists()) return DEFAULT_CAPA_SETTINGS;
  const documentData = snapshot.data() as Record<string, unknown>;
  const raw = Object.fromEntries(Object.entries(documentData).filter(([key]) => key !== "templates")) as Partial<CapaSettings>;
  return {
    ...DEFAULT_CAPA_SETTINGS,
    ...raw,
    indicatorOverrides: raw.indicatorOverrides ?? {},
    approvalRoles: raw.approvalRoles?.length ? raw.approvalRoles : DEFAULT_CAPA_SETTINGS.approvalRoles,
  };
}

export async function loadCapaTemplates(): Promise<CapaTemplate[]> {
  await seedDemoIfNeeded();
  const snapshot = await getDoc(doc(db(), "systemParams", "capaSettings"));
  if (!snapshot.exists()) return [];
  const templates = (snapshot.data() as { templates?: CapaTemplate[] }).templates ?? [];
  return templates.slice().sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

export async function saveCapaCase(item: CapaCase, actor: { id: string; name: string }, action: string, detail = ""): Promise<void> {
  const { id, ...value } = item;
  await setDoc(doc(db(), CASES, id), { ...value, updatedAt: new Date().toISOString() }, { merge: true });
  logAudit(db(), { actor: actor.id, actorName: actor.name, action, targetType: "capa", targetId: id, detail: detail || `${item.caseNumber}｜${item.stage}` });
}

export async function saveCapaSettings(value: CapaSettings, actor: { id: string; name: string }): Promise<void> {
  await setDoc(doc(db(), "systemParams", "capaSettings"), {
    ...value,
    updatedAt: new Date().toISOString(),
    updatedAtServer: serverTimestamp(),
  }, { merge: true });
  logAudit(db(), { actor: actor.id, actorName: actor.name, action: "更新 CAPA 系統設定", targetType: "capaSettings", targetId: "capaSettings", detail: `預設觸發期數 ${value.defaultTriggerPeriods}；${value.multiLevelApproval ? "多層級" : "單層級"}核准` });
}

export async function saveCapaTemplate(item: CapaTemplate, actor: { id: string; name: string }): Promise<void> {
  const ref = doc(db(), "systemParams", "capaSettings");
  const current = await getDoc(ref);
  const templates = current.exists() ? ((current.data() as { templates?: CapaTemplate[] }).templates ?? []) : [];
  const next = [item, ...templates.filter((row) => row.id !== item.id)];
  await setDoc(ref, { templates: next, updatedAt: new Date().toISOString() }, { merge: true });
  logAudit(db(), { actor: actor.id, actorName: actor.name, action: "維護 CAPA 範本", targetType: "capaTemplate", targetId: item.id, detail: `${item.type}｜${item.name}｜${item.active ? "啟用" : "停用"}` });
}
