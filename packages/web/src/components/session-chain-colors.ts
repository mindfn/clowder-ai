import { hexToOklch, hexToRgba } from '@/lib/color-utils';

const FALLBACK_COLOR = '#9CA3AF';

export interface SessionColors {
  badgeBg: string;
  badgeText: string;
  /** Per-cat tinted card shadow — gives each cat visual identity on session cards. */
  cardShadow: string;
}

/** Derive badge background from the cat's single color.
 * Uses a lightened/softened variant so the badge is legible in both modes.
 * F056: each cat has one color; secondary was removed in the OKLCH migration. */
function badgeBackground(hex: string): string {
  try {
    const { l, c, h } = hexToOklch(hex);
    // Light, desaturated tint for the badge bg — readable against both light/dark cards.
    const bgL = Math.min(0.92, l * 0.6 + 0.55);
    const bgC = Math.min(c * 0.35, 0.06);
    return `oklch(${bgL.toFixed(2)} ${bgC.toFixed(3)} ${h.toFixed(0)})`;
  } catch {
    return `rgba(229,231,235,1)`; // neutral gray fallback
  }
}

/** Derive text color that contrasts with the badge background.
 * Uses the color's OKLCH hue/chroma but shifts lightness to ensure readability.
 * Light bg → dark text; dark bg → light text. */
function contrastingText(hex: string): string {
  try {
    const { l, c, h } = hexToOklch(hex);
    const textL = l > 0.5 ? Math.max(0.15, l - 0.45) : Math.min(0.92, l + 0.45);
    return `oklch(${textL.toFixed(2)} ${c.toFixed(3)} ${h.toFixed(0)})`;
  } catch {
    return FALLBACK_COLOR;
  }
}

/** Derive session chain badge/shadow colors from the cat's single primary color.
 * F056: secondary was removed — all derivation from one hue. */
export function deriveSessionColors(color?: string): SessionColors {
  const c = color ?? FALLBACK_COLOR;
  const tint = hexToRgba(c, 0.12);
  const soft = hexToRgba(c, 0.06);
  const bg = badgeBackground(c);
  return {
    badgeBg: bg,
    badgeText: contrastingText(c),
    cardShadow: `0 2px 8px ${tint}, 0 0 2px ${soft}`,
  };
}
