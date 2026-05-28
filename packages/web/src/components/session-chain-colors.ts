import { hexToOklch, hexToRgba } from '@/lib/color-utils';

const FALLBACK_PRIMARY = '#9CA3AF';
const FALLBACK_SECONDARY = '#E5E7EB';

export interface SessionColors {
  badgeBg: string;
  badgeText: string;
  /** Per-cat tinted card shadow — gives each cat visual identity on session cards. */
  cardShadow: string;
}

/** Derive text color that contrasts with the badge background.
 * Uses the background's OKLCH hue/chroma but shifts lightness to ensure readability.
 * Light bg → dark text; dark bg → light text. */
function contrastingText(bgHex: string): string {
  try {
    const bg = hexToOklch(bgHex);
    const textL = bg.l > 0.5 ? Math.max(0.15, bg.l - 0.45) : Math.min(0.92, bg.l + 0.45);
    return `oklch(${textL.toFixed(2)} ${bg.c.toFixed(3)} ${bg.h.toFixed(0)})`;
  } catch {
    return FALLBACK_PRIMARY; // hex parse failure → safe fallback
  }
}

export function deriveSessionColors(primary?: string, secondary?: string): SessionColors {
  const p = primary ?? FALLBACK_PRIMARY;
  const s = secondary ?? FALLBACK_SECONDARY;
  // F056: badge 背景用实色（alpha=1）。半透明背景在 dark 模式深色卡片上
  // 会混色塌缩、文字几乎不可读 —— 实色让 badge 在 light/dark 都清晰。
  const tint = hexToRgba(p, 0.12);
  const soft = hexToRgba(p, 0.06);
  return {
    badgeBg: hexToRgba(s, 1),
    badgeText: contrastingText(s),
    cardShadow: `0 2px 8px ${tint}, 0 0 2px ${soft}`,
  };
}
