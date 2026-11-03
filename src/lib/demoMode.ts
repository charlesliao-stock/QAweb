/** 展示模式（demo 帳號）旗標：sessionStorage 持久化，重整頁面保持 */

const KEY = "nurseboard-demo-mode";

export function isDemoMode(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setDemoMode(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(KEY, "1");
    else sessionStorage.removeItem(KEY);
  } catch {
    /* 忽略儲存失敗 */
  }
}
