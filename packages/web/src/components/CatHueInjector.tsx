'use client';

/**
 * F056 Phase E2b — Cat Persona hue/chroma injector
 *
 * 读 cat catalog primary hex → 算 OKLCH hue/chroma → 注入 :root CSS var，
 * 覆盖 cat-persona-tokens.css 的 fallback 默认值。
 *
 * 两条注入路径：
 *  (1) 已知 slug (opus/codex/...)：写 --{slug}-hue/-chroma 到 root inline style，
 *      cat-persona-tokens.css 的 --color-{slug}-surface 派生公式自动用上。
 *  (2) 动态 catId (用户在 Hub 新建的猫, e.g. cat-voyczf20)：cat-persona-tokens.css
 *      没有对应的派生公式，我们用 <style id="f056-dynamic-cat-tokens"> 动态生成
 *      light + dark 两套 --color-{catId}-{bubble,surface,text,ring} 规则。
 *
 * 真相源（KD-25）：cat-template.json (seed) + .cat-cafe/cat-catalog.json (overlay)，
 * 通过 /api/cats → useCatData hook 拿到的 catData.color.primary 已经走完整链路。
 */

import { useEffect } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { hexToOklch } from '@/lib/color-utils';

/* catId → persona slug (matches cat-persona-tokens.css --{slug}-hue anchors
 * and SLUGS in oklch-tuner-engine.ts). */
const CAT_ID_TO_SLUG: Record<string, string> = {
  'opus-default': 'opus',
  'opus-sonnet': 'sonnet',
  'opus-45': 'opus-45',
  'opus-47': 'opus-47',
  'codex-default': 'codex',
  'codex-gpt52': 'gpt52',
  'codex-spark': 'spark',
  'gemini-default': 'gemini',
  'gemini-25': 'gemini25',
  'dare-default': 'dare',
  'kimi-default': 'kimi',
};

/* Slugs that have static derivation rules in cat-persona-tokens.css. Any cat
 * not resolving to one of these needs dynamic --color-{catId}-* injection. */
const STATIC_SLUGS = new Set([
  'opus',
  'sonnet',
  'opus-45',
  'opus-47',
  'codex',
  'gpt52',
  'spark',
  'gemini',
  'gemini25',
  'kimi',
  'dare',
  'antig-opus',
  'antigravity',
  'opencode',
  'cocreator',
]);

const DYNAMIC_STYLE_ID = 'f056-dynamic-cat-tokens';

/* Both light and dark use the same formula, just with different fallback L/Cmul
 * values. Tuner emits :root + [data-theme="dark"] overrides for the --cat-{tier}-
 * L/Cmul vars, so the dark fallbacks below only kick in when Tuner hasn't run
 * (SSR or no localStorage state). The hue/chroma are per-cat from CatHueInjector. */
function lightDecl(id: string): string {
  return (
    `--color-${id}-bubble:oklch(var(--cat-bubble-l, 0.62) calc(var(--${id}-chroma) * var(--cat-bubble-cmul, 1)) var(--${id}-hue));` +
    `--color-${id}-surface:oklch(var(--cat-surface-l, 0.94) calc(var(--${id}-chroma) * var(--cat-surface-cmul, 0.3)) var(--${id}-hue));` +
    `--color-${id}-text:oklch(var(--cat-text-l, 0.24) calc(var(--${id}-chroma) * var(--cat-text-cmul, 0.8)) var(--${id}-hue));` +
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
    `--color-${id}-text:oklch(var(--cat-text-l, 0.88) calc(var(--${id}-chroma) * var(--cat-text-cmul, 0.6)) var(--${id}-hue));` +
    `--color-${id}-ring:oklch(var(--cat-ring-l, 0.70) calc(var(--${id}-chroma) * var(--cat-ring-cmul, 1)) var(--${id}-hue));`
  );
}

export function CatHueInjector() {
  const { cats } = useCatData();

  useEffect(() => {
    if (typeof document === 'undefined' || cats.length === 0) return;
    const root = document.documentElement;
    const dynamicIds: string[] = [];

    for (const cat of cats) {
      if (!cat.id || !cat.color?.primary) continue;
      try {
        const { h, c } = hexToOklch(cat.color.primary);
        if (!Number.isFinite(h) || !Number.isFinite(c)) continue;
        const hStr = h.toFixed(1);
        const cStr = c.toFixed(3);
        const slug = CAT_ID_TO_SLUG[cat.id] ?? cat.id;
        /* Write slug-keyed AND catId-keyed hue/chroma vars. */
        root.style.setProperty(`--${slug}-hue`, hStr);
        root.style.setProperty(`--${slug}-chroma`, cStr);
        if (slug !== cat.id) {
          root.style.setProperty(`--${cat.id}-hue`, hStr);
          root.style.setProperty(`--${cat.id}-chroma`, cStr);
        }
        /* Track cats whose slug isn't in the static cat-persona-tokens.css
         * list — they need dynamic --color-{id}-* derivation rules. */
        if (!STATIC_SLUGS.has(slug)) dynamicIds.push(cat.id);
      } catch {
        /* 单只猫颜色坏掉不该影响其他猫——保持 fallback */
      }
    }

    /* Update dynamic cat tokens stylesheet (handles user-created cats whose
     * id is not pre-baked into cat-persona-tokens.css). */
    let styleEl = document.getElementById(DYNAMIC_STYLE_ID) as HTMLStyleElement | null;
    if (dynamicIds.length === 0) {
      if (styleEl) styleEl.textContent = '';
      return;
    }
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = DYNAMIC_STYLE_ID;
      document.head.appendChild(styleEl);
    }
    const lightRules = dynamicIds.map(lightDecl).join('');
    const darkRules = dynamicIds.map(darkDecl).join('');
    styleEl.textContent = `:root{${lightRules}}\n[data-theme="dark"]{${darkRules}}`;
  }, [cats]);

  return null;
}
