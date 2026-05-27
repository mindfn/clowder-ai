import { hexToRgba } from '@/lib/color-utils';

const FALLBACK_PRIMARY = '#9CA3AF';
const FALLBACK_SECONDARY = '#E5E7EB';

export interface SessionColors {
  badgeBg: string;
  badgeText: string;
  /** Per-cat tinted card shadow — gives each cat visual identity on session cards. */
  cardShadow: string;
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
    badgeText: p,
    cardShadow: `0 2px 8px ${tint}, 0 0 2px ${soft}`,
  };
}
