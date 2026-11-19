/**
 * 測試／工具腳本共用的路徑解析：由本檔位置推出 repo 根目錄，
 * 取代各腳本寫死的個人環境絕對路徑。
 * 輸出一律使用正斜線，才能安全嵌入 esbuild 動態產生的 import 字串（含 Windows）。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..").replace(/\\/g, "/");
