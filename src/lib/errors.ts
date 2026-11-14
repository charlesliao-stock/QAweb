/** 把任意例外轉成可顯示的訊息（各頁共用；無訊息時給通用提示）。 */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "讀寫失敗，請檢查網路連線後再試";
}
