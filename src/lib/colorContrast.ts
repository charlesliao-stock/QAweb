/**
 * WCAG 對比度計算（v1.32.0，資料驅動主題）。
 * 單一實作：程式（主題驗證）與測試（test-v1.32.mjs）共用，避免各算一套。
 */

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function channelLuminance(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function hexLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/** 兩色對比值（WCAG，相對亮度公式）。hex 格式錯誤時回傳 1。 */
export function contrastRatio(foreground: string, background: string): number {
  if (!isHexColor(foreground) || !isHexColor(background)) return 1;
  const l1 = hexLuminance(foreground);
  const l2 = hexLuminance(background);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export interface ThemeContrastCheck {
  /** 擋下儲存的錯誤（白字主色／深色字對比不足） */
  errors: string[];
  /** 只警告（點綴色白字對比不足：只用於小圓點／淡底，不配白字） */
  warnings: string[];
}

/**
 * 主題對比驗證（設計 v2 §2.4）。
 * errors：teal／tealDeep／accentDeep 白字對比須 ≥4.5（它們實際配白字或作
 * 深色字）；tealDeep 字 on tealSoft、accentDeep 字 on accentSoft 亦須 ≥4.5；
 * btnHoverBg 配 btnHoverColor（白字或亮黃配黑字）須 ≥4.5。
 * warnings：accent／accent2 白字對比不足（不擋下，只提醒）。
 */
export function validateThemeContrast(def: {
  teal: string;
  tealDeep: string;
  tealSoft: string;
  accent: string;
  accentDeep: string;
  accentSoft: string;
  accent2: string;
  btnHoverBg: string;
  btnHoverColor: string;
}): ThemeContrastCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const need = (
    label: string,
    fg: string,
    bg: string,
    min = 4.5,
  ): void => {
    const r = contrastRatio(fg, bg);
    if (r < min) errors.push(`${label} 對比 ${r.toFixed(2)} < ${min}`);
  };
  need("主色白字", def.teal, "#ffffff");
  need("主色深版白字", def.tealDeep, "#ffffff");
  need("輔色深版白字", def.accentDeep, "#ffffff");
  need("主色深版字 on 淡底", def.tealDeep, def.tealSoft);
  need("輔色深版字 on 淡底", def.accentDeep, def.accentSoft);
  if (isHexColor(def.btnHoverBg) && isHexColor(def.btnHoverColor)) {
    need("主按鈕 hover 字", def.btnHoverColor, def.btnHoverBg);
  }
  for (const [label, hex] of [
    ["輔色白字", def.accent],
    ["點綴色白字", def.accent2],
  ] as const) {
    if (contrastRatio(hex, "#ffffff") < 4.5) {
      warnings.push(`${label} 對比不足，僅可用於小元素／淡底，勿配白字`);
    }
  }
  return { errors, warnings };
}
