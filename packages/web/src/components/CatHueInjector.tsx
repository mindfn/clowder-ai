'use client';

/**
 * F056 Phase E2b — Cat Persona hue/chroma injector (all-dynamic)
 *
 * Reads cat catalog primary hex → computes OKLCH hue/chroma → injects
 * :root CSS vars + generates full --color-{catId}-* derivation rules for
 * ALL cats dynamically. No static per-cat CSS rules needed.
 *
 * Backward compat: for `-default` suffixed catIds (e.g. opus-default),
 * also generates alias rules under the stripped name (opus) so hardcoded
 * refs like `var(--color-opus-primary)` keep working.
 *
 * Truth source (KD-25): cat-template.json (seed) + .cat-cafe/cat-catalog.json
 * (overlay), via /api/cats → useCatData hook.
 */

import { useEffect } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { hexToOklch } from '@/lib/color-utils';

const DYNAMIC_STYLE_ID = 'f056-dynamic-cat-tokens';

/** Strip `-default` suffix → backward-compat alias (opus-default → opus).
 * Returns null if catId has no `-default` suffix. */
function legacyAlias(catId: string): string | null {
  return catId.endsWith('-default') ? catId.slice(0, -8) : null;
}

/* Both light and dark use the same formula, just with different fallback L/Cmul
 * values. Tuner emits :root + [data-theme="dark"] overrides for the --cat-{tier}-
 * L/Cmul vars, so the dark fallbacks below only kick in when Tuner hasn't run
 * (SSR or no localStorage state). The hue/chroma are per-cat from CatHueInjector. */
function lightDecl(id: string): string {
  return (
    `--color-${id}-bubble:oklch(var(--cat-bubble-l, 0.62) calc(var(--${id}-chroma) * var(--cat-bubble-cmul, 1)) var(--${id}-hue));` +
    `--color-${id}-surface:oklch(var(--cat-surface-l, 0.9) calc(var(--${id}-chroma) * var(--cat-surface-cmul, 0.5)) var(--${id}-hue));` +
    `--color-${id}-text:oklch(var(--cat-name-l, 0.24) var(--cat-name-c, 0.005) var(--cat-name-h, 139));` +
    `--color-${id}-ring:oklch(var(--cat-ring-l, 0.55) calc(var(--${id}-chroma) * var(--cat-ring-cmul, 1.1)) var(--${id}-hue));` +
    `--color-${id}-primary:var(--color-${id}-bubble);` +
    `--color-${id}-light:var(--color-${id}-surface);` +
    `--color-${id}-dark:var(--color-${id}-text);` +
    `--color-${id}-bg:var(--color-${id}-surface);`
  );
}

function darkDecl(id: string): string {
  return (
    `--color-${id}-bubble:oklch(var(--cat-bubble-l, 0.68) calc(var(--${id}-chroma) * var(--cat-bubble-cmul, 0.85)) var(--${id}-hue));` +
    `--color-${id}-surface:oklch(var(--cat-surface-l, 0.3) calc(var(--${id}-chroma) * var(--cat-surface-cmul, 0.25)) var(--${id}-hue));` +
    `--color-${id}-text:oklch(var(--cat-name-l, 0.88) var(--cat-name-c, 0.005) var(--cat-name-h, 139));` +
    `--color-${id}-ring:oklch(var(--cat-ring-l, 0.70) calc(var(--${id}-chroma) * var(--cat-ring-cmul, 1)) var(--${id}-hue));`
  );
}

export function CatHueInjector() {
  const { cats } = useCatData();

  useEffect(() => {
    if (typeof document === 'undefined' || cats.length === 0) return;
    const root = document.documentElement;
    /* Collect all IDs that need dynamic --color-{id}-* CSS rules. */
    const ruleIds: string[] = [];

    for (const cat of cats) {
      if (!cat.id || !cat.color?.primary) continue;
      try {
        const { h, c } = hexToOklch(cat.color.primary);
        if (!Number.isFinite(h) || !Number.isFinite(c)) continue;
        const hStr = h.toFixed(1);
        const cStr = c.toFixed(3);

        /* Write catId-keyed hue/chroma vars. */
        root.style.setProperty(`--${cat.id}-hue`, hStr);
        root.style.setProperty(`--${cat.id}-chroma`, cStr);
        ruleIds.push(cat.id);

        /* Backward compat: also write under stripped alias (opus-default → opus)
         * so hardcoded refs like var(--color-opus-primary) keep working. */
        const alias = legacyAlias(cat.id);
        if (alias) {
          root.style.setProperty(`--${alias}-hue`, hStr);
          root.style.setProperty(`--${alias}-chroma`, cStr);
          ruleIds.push(alias);
        }
      } catch {
        /* 单只猫颜色坏掉不该影响其他猫——保持 fallback */
      }
    }

    /* Generate dynamic cat token stylesheet for ALL cats. */
    let styleEl = document.getElementById(DYNAMIC_STYLE_ID) as HTMLStyleElement | null;
    if (ruleIds.length === 0) {
      if (styleEl) styleEl.textContent = '';
      return;
    }
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = DYNAMIC_STYLE_ID;
      document.head.appendChild(styleEl);
    }
    const lightRules = ruleIds.map(lightDecl).join('');
    const darkRules = ruleIds.map(darkDecl).join('');
    styleEl.textContent = `:root{${lightRules}}\n[data-theme="dark"]{${darkRules}}`;
  }, [cats]);

  return null;
}
