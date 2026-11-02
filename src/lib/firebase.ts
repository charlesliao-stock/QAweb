import type { Firestore } from "firebase/firestore";
import type { Indicator } from "../types";

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? "",
};

const configured = Boolean(config.apiKey && config.projectId && config.appId);
let firestorePromise: Promise<Firestore> | undefined;

export type DemoDataSource = "local" | "firebase" | "firebase-unavailable";

export function isFirebaseDemoReadEnabled(): boolean {
  return configured && import.meta.env.VITE_FIREBASE_DEMO_READS === "true";
}

async function getDemoFirestore(): Promise<Firestore | null> {
  if (!isFirebaseDemoReadEnabled()) return null;
  firestorePromise ??= Promise.all([
    import("firebase/app"),
    import("firebase/firestore"),
  ]).then(([appSdk, firestoreSdk]) => {
    const app =
      appSdk.getApps().length > 0
        ? appSdk.getApp()
        : appSdk.initializeApp(config);
    return firestoreSdk.getFirestore(app);
  });
  return firestorePromise;
}

/**
 * Read-only display adapter. It requests only the dedicated demo path and has no write APIs.
 * Every returned document must explicitly opt into demoOnly=true before its allowlisted fields
 * can be displayed. Firebase Rules must independently restrict access to this demo-only path.
 */
export async function readDemoIndicators(): Promise<Indicator[] | null> {
  const firestore = await getDemoFirestore();
  if (!firestore) return null;

  const firestoreSdk = await import("firebase/firestore");
  const demoCollection = firestoreSdk.collection(
    firestore,
    "qms_demo",
    "indicators",
    "records",
  );
  const result = await firestoreSdk.getDocs(
    firestoreSdk.query(
      demoCollection,
      firestoreSdk.where("demoOnly", "==", true),
      firestoreSdk.limit(30),
    ),
  );
  const rows = result.docs.flatMap((snapshot) => {
    const raw = snapshot.data();
    if (raw.demoOnly !== true) return [];

    const status =
      raw.status === "審核中" || raw.status === "草稿" ? raw.status : "啟用";
    return [
      {
        id: snapshot.id,
        code: safeText(raw.code, "DEMO"),
        name: safeText(raw.name, "展示指標"),
        group: safeText(raw.group, "展示組別"),
        threshold: safeNumber(raw.threshold, 90),
        attainment: safeNumber(raw.attainment, 0),
        audited: safeNumber(raw.audited, 0),
        planned: safeNumber(raw.planned, 0),
        version: safeText(raw.version, "v1.0"),
        status,
        owner: "展示負責人",
        resultLabel: safeText(raw.resultLabel, "符合率"),
      } satisfies Indicator,
    ];
  });

  return rows.length > 0 ? rows : null;
}

function safeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length <= 100 ? value : fallback;
}

function safeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
