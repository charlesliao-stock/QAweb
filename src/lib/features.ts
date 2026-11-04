/**
 * 功能開關：第一階段為 Spark 免費方案，以下功能保留設計、待升級 Blaze 後開啟。
 * 開啟方式：升 Blaze → 部署 functions/ 與 storage.rules → 將對應旗標改為 true。
 */
export const FEATURES = {
  /** 照片佐證上傳（需 Cloud Storage） */
  photoUpload: false,
  /** 語音備註上傳（需 Cloud Storage） */
  voiceNote: false,
  /** Email 通知（需 Cloud Functions） */
  emailNotify: false,
  /** 排程催辦通知（需 Cloud Functions + Scheduler） */
  scheduledRemind: false,
} as const;

export type FeatureFlag = keyof typeof FEATURES;
