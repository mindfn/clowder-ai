/**
 * F056 catId → persona slug mapping.
 *
 * Slugs match cat-persona-tokens.css `--{slug}-hue/-chroma` anchors and the
 * SLUGS array in oklch-tuner-engine.ts. For dynamic catIds (user-created cats
 * not in this map), the slug falls back to the catId itself — CatHueInjector
 * emits an inline `--{catId}-hue/-chroma` + a generated --color-{catId}-* token
 * rule, so those resolve fine too.
 *
 * Use catSlug() to derive the slug, then build `var(--color-${slug}-{tier})`
 * tokens for any cat-keyed color. This routes everything through the F056
 * gradient (--cat-{tier}-l/cmul) which Tuner globally controls.
 */

export const CAT_ID_TO_SLUG: Record<string, string> = {
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
  cocreator: 'cocreator',
};

/** Resolve a catId to its persona slug. Falls back to the catId itself. */
export function catSlug(catId: string | undefined): string {
  if (!catId) return 'opus';
  return CAT_ID_TO_SLUG[catId] ?? catId;
}

/** Build `var(--color-{slug}-{tier})` for a cat color. Default tier is primary. */
export function catColorVar(
  catId: string | undefined,
  tier: 'bubble' | 'surface' | 'text' | 'ring' | 'primary' | 'light' | 'dark' | 'bg' = 'primary',
): string {
  return `var(--color-${catSlug(catId)}-${tier})`;
}

/** Build `color-mix(...)` for a cat color with alpha. Routes through the cat
 * token, so opacity overlays still follow Tuner-controlled gradient. */
export function catColorMix(
  catId: string | undefined,
  alpha: number,
  tier: 'primary' | 'surface' | 'bubble' = 'primary',
): string {
  const pct = Math.round(alpha * 100);
  return `color-mix(in srgb, ${catColorVar(catId, tier)} ${pct}%, transparent)`;
}
