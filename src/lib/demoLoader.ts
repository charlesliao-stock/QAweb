/**
 * 展示模式資料層的延遲載入。
 *
 * demoStore／demoData 只有展示帳號會用到，不該進正式使用者的主 bundle。
 * db.ts 的 API 是同步取用（collection／doc／query／where…），不能在呼叫當下才 await，
 * 所以規則是：「進入展示模式之前先 await loadDemoStore()」——
 * - 登入展示帳號：auth.tsx 的 login 先載入、再 setDemoMode(true)；
 * - 重新整理仍在展示模式（sessionStorage 旗標）：main.tsx 先載入、再 render。
 * 載入完成前若被取用（程式錯誤），會丟出明確錯誤而不是靜默讀到空資料。
 */
export type DemoStoreModule = typeof import("./demoStore");

let loaded: DemoStoreModule | undefined;

export async function loadDemoStore(): Promise<void> {
  loaded ??= await import("./demoStore");
}

/** 同步取得已載入的 demoStore；尚未載入時丟錯。 */
export function demoStoreSync(): DemoStoreModule {
  if (!loaded) throw new Error("展示模式資料尚未載入（需先 await loadDemoStore()）");
  return loaded;
}
