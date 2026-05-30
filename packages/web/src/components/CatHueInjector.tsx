'use client';

/**
 * F056 Phase E2b — Cat Persona hue/chroma injector (all-dynamic)
 *
 * Reads cat catalog primary hex → computes OKLCH hue/chroma → injects
 * :root CSS vars + generates full --color-{catId}-* derivation rules for
 * ALL cats dynamically. No static per-cat CSS rules needed.
 *
 * cat.id at runtime is the resolved catId (e.g. "opus", "codex", "sonnet"),
 * NOT the template variant id (e.g. "opus-default"). Resolution happens in
 * cat-config-loader.ts: `variant.catId ?? breed.catId`.
 *
 * Truth source (KD-25): cat-template.json (seed) + .cat-cafe/cat-catalog.json
 * (overlay), via /api/cats → useCatData hook.
 */

import { useEffect } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { hexToOklch } from '@/lib/color-utils';

const DYNAMIC_STYLE_ID = 'f056-dynamic-cat-tokens';

/** F056: Connector sources with fixed OKLCH hue/chroma — participate in the same
 * cat L/C derivation pipeline so their bubbles follow the Tuner (surface L, Cmul,
 * ring L etc.) instead of hardcoded hex values in connector-tokens.css.
 * Extend this array to OKLCH-ize more connector color families. */
const CONN_OKLCH: ReadonlyArray<{ id: string; hue: number; chroma: number; alias: string }> = [
  { id: 'scheduler', hue: 85, chroma: 0.15, alias: 'amber' },
];

/* Both light and dark use the same formula, just with different fallback L/Cmul
 * values. Tuner emits :root + [data-theme="dark"] overrides for the --cat-{tier}-
 * L/Cmul vars, so the dark fallbacks below only kick in when Tuner hasn't run
 * (SSR or no localStorage state). The hue/chroma are per-cat from CatHueInjector. */
function lightDecl(id: string): string {
  return (
    `--color-${id}-bubble:oklch(var(--cat-bubble-l, 0.62) calc(var(--${id}-chroma) * var(--cat-bubble-cmul, 1)) var(--${id}-hue));` +
    `--color-${id}-surface:oklch(var(--cat-surface-l, 0.85) calc(var(--${id}-chroma) * var(--cat-surface-cmul, 0.45)) var(--${id}-hue));` +
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
    `--color-${id}-surface:oklch(var(--cat-surface-l, 0.28) calc(var(--${id}-chroma) * var(--cat-surface-cmul, 0.25)) var(--${id}-hue));` +
    `--color-${id}-text:oklch(var(--cat-name-l, 0.88) var(--cat-name-c, 0.005) var(--cat-name-h, 139));` +
    `--color-${id}-ring:oklch(var(--cat-ring-l, 0.70) calc(var(--${id}-chroma) * var(--cat-ring-cmul, 1)) var(--${id}-hue));`
  );
}

export function CatHueInjector() {
  const { cats } = useCatData();

  useEffect(() => {
    if (typeof document === 'undefined' || cats.length === 0) return;
    const root = document.documentElement;
    const ruleIds: string[] = [];

    for (const cat of cats) {
      if (!cat.id || !/^[a-zA-Z0-9_-]+$/.test(cat.id)) continue;
      let h = 0;
      let c = 0;
      if (cat.color?.primary) {
        try {
          const oklch = hexToOklch(cat.color.primary);
          if (Number.isFinite(oklch.h) && Number.isFinite(oklch.c)) {
            h = oklch.h;
            c = oklch.c;
          }
        } catch {
          /* Invalid hex → neutral fallback (h=0 c=0) so tokens still exist */
        }
      }
      root.style.setProperty(`--${cat.id}-hue`, h.toFixed(1));
      root.style.setProperty(`--${cat.id}-chroma`, c.toFixed(3));
      ruleIds.push(cat.id);
    }

    /* Connector sources: fixed hue/chroma, L controlled by Tuner via cat tier vars */
    for (const conn of CONN_OKLCH) {
      root.style.setProperty(`--${conn.id}-hue`, conn.hue.toFixed(1));
      root.style.setProperty(`--${conn.id}-chroma`, conn.chroma.toFixed(3));
      ruleIds.push(conn.id);
    }

    /* Generate dynamic cat token stylesheet for ALL cats + connector sources. */
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
    /* Connector token aliases — map --conn-{alias}-* to OKLCH-derived --color-{id}-*
     * so existing Tailwind classes (bg-conn-amber-bg etc.) follow the Tuner.
     * Both :root and [data-theme="dark"] blocks get the same var() aliases;
     * the referenced tokens resolve to mode-appropriate values automatically. */
    const connAlias = CONN_OKLCH.map(
      ({ id, alias }) =>
        `--conn-${alias}-bg:var(--color-${id}-surface);` +
        `--conn-${alias}-ring:var(--color-${id}-ring);` +
        `--conn-${alias}-text:var(--color-${id}-ring);` +
        `--conn-${alias}-hover:var(--color-${id}-bubble);` +
        `--conn-${alias}-bubble-bg:var(--color-${id}-surface);` +
        `--conn-${alias}-bubble-border:var(--color-${id}-ring);`,
    ).join('');
    styleEl.textContent = `:root{${lightRules}${connAlias}}\n[data-theme="dark"]{${darkRules}${connAlias}}`;
  }, [cats]);

  return null;
}
