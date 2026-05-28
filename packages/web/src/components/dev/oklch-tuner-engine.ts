/* F056 OKLCH Tuner — engine: types, defaults, CSS generation, export.
 * buildCSS() generates overrides for accent, surface elevation, per-cat tokens,
 * .cat-persona-derived msg tokens, and optional hue/chroma force. */

/* ── Types ── */
export interface TierP {
  L: number;
  Cmul: number;
}
export interface FixedP {
  L: number;
  C: number;
}
export interface SurfaceP {
  sunken: number;
  base: number;
  elevated: number;
  canvas: number;
}
export interface ModeP {
  primary: TierP;
  surface: TierP;
  text: TierP;
  inset: TierP;
  ring: TierP;
  insetText: FixedP;
  msgText: FixedP;
  elev: SurfaceP;
}
export interface SemanticP {
  criticalH: number;
  successH: number;
  warningH: number;
  infoH: number;
  L: number;
  C: number;
  surfL: number;
  surfC: number;
}
export interface QueueP {
  H: number;
  C: number;
  L: number;
}
export interface NeutralP {
  textL: number;
  secondaryL: number;
  mutedL: number;
  interactiveL: number;
  borderL: number;
  borderSubtleL: number;
}
export type Mode = 'light' | 'dark';
export interface TunerState {
  accentHue: number;
  accentChroma: number;
  light: ModeP;
  dark: ModeP;
  semanticLight: SemanticP;
  semanticDark: SemanticP;
  queue: QueueP;
  neutralHue: number;
  neutralChroma: number;
  neutralLight: NeutralP;
  neutralDark: NeutralP;
  /* Cat name text — unified across all cats (not per-cat hue derived) */
  catTextH: number;
  catTextC: number;
  catTextLightL: number;
  catTextDarkL: number;
}
export interface HcOverride {
  on: boolean;
  hue: number;
  chroma: number;
}

/* ── Constants ── */
export const CAT_TIERS = ['primary', 'surface', 'text', 'inset', 'ring'] as const;
export type CatTier = (typeof CAT_TIERS)[number];
// biome-ignore format: compact slug list (file-size limit)
const SLUGS = ['opus','sonnet','opus-45','opus-47','codex','gpt52','spark','gemini','gemini25','kimi','dare','cocreator'] as const;
export const SURF_KEYS = ['sunken', 'base', 'elevated', 'canvas'] as const;
export const SEMANTIC_KEYS = ['critical', 'success', 'warning', 'info'] as const;
export type SemanticKey = (typeof SEMANTIC_KEYS)[number];
export const SEMANTIC_LABELS: Record<SemanticKey, string> = {
  critical: '危险/错误 (删除/失败)',
  success: '成功/健康 (通过/完成)',
  warning: '警告 (静默/降级)',
  info: '信息/蓝 (跨帖/链接)',
};
export const SEMANTIC_H_FIELD: Record<SemanticKey, keyof SemanticP> = {
  critical: 'criticalH',
  success: 'successH',
  warning: 'warningH',
  info: 'infoH',
};

export const TIER_LABELS: Record<CatTier | 'insetText' | 'msgText', string> = {
  primary: '主色 (图标/头像环)',
  surface: '消息气泡背景',
  text: '猫名文字',
  inset: '嵌套块 (Thinking/CLI)',
  ring: '聚焦环线',
  insetText: '嵌套块文字',
  msgText: '消息文字',
};

export const SURF_LABELS: Record<keyof SurfaceP, string> = {
  sunken: '层 1 · 基底',
  base: '层 2 · 承载',
  elevated: '层 3 · 抬升',
  canvas: '层 4 · 浮出',
};

export const NEUTRAL_ROWS: [keyof NeutralP, string][] = [
  ['textL', '正文'],
  ['secondaryL', '二级'],
  ['mutedL', '弱/三级'],
  ['interactiveL', '交互'],
  ['borderL', '边框'],
  ['borderSubtleL', '细线'],
];

/* ── Defaults (match cat-persona-tokens.css + theme-tokens.css exactly) ── */
export const INIT: TunerState = {
  accentHue: 35,
  accentChroma: 0.12,
  light: {
    primary: { L: 0.62, Cmul: 1.0 },
    surface: { L: 0.9, Cmul: 0.5 },
    text: { L: 0.24, Cmul: 0.8 },
    inset: { L: 0.3, Cmul: 0.1 },
    ring: { L: 0.55, Cmul: 1.1 },
    insetText: { L: 0.85, C: 0.03 },
    msgText: { L: 0.2, C: 0.005 },
    elev: { sunken: 0.92, base: 0.95, elevated: 0.985, canvas: 0.996 },
  },
  dark: {
    primary: { L: 0.68, Cmul: 0.85 },
    surface: { L: 0.28, Cmul: 0.25 },
    text: { L: 0.88, Cmul: 0.6 },
    inset: { L: 0.24, Cmul: 0.1 },
    ring: { L: 0.7, Cmul: 1.0 },
    insetText: { L: 0.80, C: 0.02 },
    msgText: { L: 0.80, C: 0.02 },
    elev: { sunken: 0.275, base: 0.18, elevated: 0.1, canvas: 0.18 },
  },
  /* Semantic status — light/dark hues differ (铲屎官 2026-05-27 调优) */
  semanticLight: { criticalH: 38, successH: 135, warningH: 46, infoH: 209, L: 0.57, C: 0.12, surfL: 0.96, surfC: 0.03 },
  semanticDark: { criticalH: 25, successH: 145, warningH: 70, infoH: 230, L: 0.7, C: 0.17, surfL: 0.25, surfC: 0.05 },
  /* Queue accent — OKLCH approximation of #9B7EBD */
  queue: { H: 290, C: 0.1, L: 0.62 },
  /* Neutral text/border — from theme-tokens.css neutral scale */
  neutralHue: 30,
  neutralChroma: 0.005,
  neutralLight: { textL: 0.2, secondaryL: 0.45, mutedL: 0.56, interactiveL: 0.36, borderL: 0.84, borderSubtleL: 0.915 },
  neutralDark: { textL: 0.94, secondaryL: 0.76, mutedL: 0.66, interactiveL: 0.84, borderL: 0.32, borderSubtleL: 0.24 },
  /* Cat name text — green-neutral, unified across all cats */
  catTextH: 139,
  catTextC: 0.005,
  catTextLightL: 0.24,
  catTextDarkL: 0.88,
};

export const STYLE_ID = 'oklch-tuner-override';

/* ── CSS generation ── */
export function buildCSS(p: TunerState, hc: HcOverride): string {
  const ok = (m: ModeP, t: CatTier, h: string, c: string) => `oklch(${m[t].L} calc(${c} * ${m[t].Cmul}) ${h})`;
  const it = (m: ModeP) => `oklch(${m.insetText.L} ${m.insetText.C} 250)`;
  const mt = (m: ModeP) => `oklch(${m.msgText.L} ${m.msgText.C} ${p.neutralHue})`;

  // 1. Accent — cascades to all --accent-* in theme-tokens.css
  const accent = `:root{--accent-hue:${p.accentHue};--accent-chroma:${p.accentChroma};}`;

  // 1b. Cat tier gradients (--cat-{tier}-l/cmul). Per-cat tokens
  // (--color-{slug}-*) in cat-persona-tokens.css consume these so all cats,
  // including dynamically-created ones, follow Tuner's L/Cmul globally.
  // hue/chroma still come from each cat's own --{slug}-hue/-chroma.
  const catGrads = (m: ModeP, dark: boolean) => {
    const sel = dark ? '[data-theme="dark"]' : ':root';
    return (
      `${sel}{` +
      `--cat-bubble-l:${m.primary.L};--cat-bubble-cmul:${m.primary.Cmul};` +
      `--cat-surface-l:${m.surface.L};--cat-surface-cmul:${m.surface.Cmul};` +
      `--cat-text-l:${m.text.L};--cat-text-cmul:${m.text.Cmul};` +
      `--cat-ring-l:${m.ring.L};--cat-ring-cmul:${m.ring.Cmul};` +
      `--cat-inset-l:${m.inset.L};--cat-inset-cmul:${m.inset.Cmul};` +
      `--cat-inset-text-l:${m.insetText.L};--cat-inset-text-c:${m.insetText.C};` +
      `--cat-msg-text-l:${m.msgText.L};--cat-msg-text-c:${m.msgText.C};}`
    );
  };

  // 2. Surface elevation — hue follows accent (KD-34 rev: surfaces tint with brand)
  //    Chroma unified across light/dark so Tuner behavior is consistent in both modes.
  const surf = (e: SurfaceP, dark: boolean) => {
    const sel = dark ? '[data-theme="dark"]' : ':root';
    const ch = [0.015, 0.012, 0.005, 0.003]; // unified — no dark-specific chroma
    const h = p.accentHue;
    return (
      `${sel}{` +
      `--cafe-surface-sunken:oklch(${e.sunken} ${ch[0]} ${h});` +
      `--cafe-surface:oklch(${e.base} ${ch[1]} ${h});` +
      `--cafe-surface-elevated:oklch(${e.elevated} ${ch[2]} ${h});` +
      `--cafe-surface-canvas:oklch(${e.canvas} ${ch[3]} ${h});}`
    );
  };

  // 3. Per-cat static tokens removed: per-slug gradient now comes from
  //    cat-persona-tokens.css via --cat-{tier}-l/cmul (see catGrads below).
  //    Old `catTkn`/`catBlk`/`accentPri` helpers deleted to prevent shadowing.

  // 3c. Unified cat name text (铲屎官: "H L C 统一，不跟成员主题色变")
  const catTxt = (dark: boolean) => {
    const l = dark ? p.catTextDarkL : p.catTextLightL;
    const v = `oklch(${l} ${p.catTextC} ${p.catTextH})`;
    const sel = dark ? '[data-theme="dark"]' : ':root';
    return `${sel}{${SLUGS.map((s) => `--color-${s}-text:${v};--color-${s}-dark:${v};`).join('')}}`;
  };

  // 4. Runtime message derived (.cat-persona-derived)
  const mH = hc.on ? `${hc.hue}` : 'var(--msg-hue,297)';
  const mC = hc.on ? `${hc.chroma}` : 'var(--msg-chroma,0.1)';
  const drv = (m: ModeP, dark: boolean) => {
    const sel = dark ? '[data-theme="dark"] .cat-persona-derived' : '.cat-persona-derived';
    return (
      `${sel}{` +
      `--cat-msg-bubble:${ok(m, 'primary', mH, mC)};` +
      `--cat-msg-surface:${ok(m, 'surface', mH, mC)};` +
      `--cat-msg-inset:${ok(m, 'inset', mH, mC)};` +
      `--cat-msg-inset-text:${it(m)};` +
      `--cat-msg-text:${mt(m)};` +
      `--cat-msg-ring:${ok(m, 'ring', mH, mC)};}`
    );
  };

  // 5. Force all cats to same H/C (!important to beat inline styles)
  const force = hc.on ? `.cat-persona-derived{--msg-hue:${hc.hue}!important;--msg-chroma:${hc.chroma}!important;}` : '';

  // 6. Semantic status colors (critical / success / warning / info + surface variants)
  const semCSS = (s: SemanticP, dark: boolean) => {
    const sel = dark ? '[data-theme="dark"]' : ':root';
    return (
      `${sel}{` +
      `--semantic-critical:oklch(${s.L} ${s.C} ${s.criticalH});` +
      `--semantic-success:oklch(${s.L} ${s.C} ${s.successH});` +
      `--semantic-warning:oklch(${s.L} ${s.C} ${s.warningH});` +
      `--semantic-info:oklch(${s.L} ${s.C} ${s.infoH});` +
      `--semantic-spotlight:oklch(${s.L + 0.1} ${s.C} ${s.warningH});` +
      `--semantic-critical-surface:oklch(${s.surfL} ${s.surfC} ${s.criticalH});` +
      `--semantic-success-surface:oklch(${s.surfL} ${s.surfC} ${s.successH});` +
      `--semantic-warning-surface:oklch(${s.surfL} ${s.surfC + 0.01} ${s.warningH});` +
      `--semantic-info-surface:oklch(${s.surfL} ${s.surfC} ${s.infoH});` +
      `--semantic-spotlight-surface:oklch(${s.surfL} ${s.surfC + 0.01} ${s.warningH});}`
    );
  };

  // 7. Queue accent (overrides fixed hex with OKLCH)
  const q = p.queue;
  const qLight =
    `:root{--queue-accent:oklch(${q.L} ${q.C} ${q.H});` +
    `--queue-accent-hover:oklch(${q.L - 0.06} ${q.C + 0.01} ${q.H});` +
    `--queue-accent-surface:oklch(0.96 ${q.C * 0.2} ${q.H});` +
    `--queue-on-accent:oklch(1 0 0);}`;
  const qDark =
    `[data-theme="dark"]{--queue-accent:oklch(${q.L + 0.16} ${q.C + 0.02} ${q.H});` +
    `--queue-accent-hover:oklch(${q.L + 0.22} ${q.C + 0.04} ${q.H});` +
    `--queue-accent-surface:oklch(0.25 ${q.C * 0.4} ${q.H});` +
    `--queue-on-accent:oklch(0.18 0.03 ${q.H});}`;

  // 8. Neutral text/border (overrides --cafe-text/border aliases)
  const nCSS = (n: NeutralP, dark: boolean) => {
    const sel = dark ? '[data-theme="dark"]' : ':root';
    const o = (l: number) => `oklch(${l} ${p.neutralChroma} ${p.neutralHue})`;
    return `${sel}{--cafe-text:${o(n.textL)};--cafe-text-secondary:${o(n.secondaryL)};--cafe-text-muted:${o(n.mutedL)};--cafe-interactive:${o(n.interactiveL)};--cafe-border:${o(n.borderL)};--cafe-border-subtle:${o(n.borderSubtleL)};}`;
  };

  return [
    accent,
    /* F056: --cat-{tier}-l/cmul gradient feeds cat-persona-tokens.css's
     * per-slug derivation formulas (and CatHueInjector's dynamic stylesheet),
     * so all cats follow Tuner uniformly while each keeps its own hue/chroma.
     * The old per-slug `catBlk` hardcoded oklch(L Cmul·c hue) which would
     * shadow the new var-based formulas, so it's intentionally removed. */
    catGrads(p.light, false),
    catGrads(p.dark, true),
    surf(p.light.elev, false),
    surf(p.dark.elev, true),
    /* F056 (铲屎官 2026-05-28 architecture clarification): bubble/primary
     * should derive from each cat's own hue/chroma (not be flattened to a
     * single --cafe-accent). The per-slug --color-{slug}-bubble in
     * cat-persona-tokens.css already does this via --cat-bubble-l/cmul gradient,
     * so the accentPri override that forced bubble=cafe-accent is removed.
     * catTxt kept: cat-name labels (small text next to avatars) still use a
     * unified green-neutral tone (catTextH/L/C), not per-cat hue. */
    catTxt(false),
    catTxt(true),
    drv(p.light, false),
    drv(p.dark, true),
    force,
    semCSS(p.semanticLight, false),
    semCSS(p.semanticDark, true),
    qLight,
    qDark,
    nCSS(p.neutralLight, false),
    nCSS(p.neutralDark, true),
  ]
    .filter(Boolean)
    .join('\n');
}

/* ── Export text (Copy button) ── */
export function exportText(p: TunerState): string {
  const r = (mode: Mode, t: CatTier) =>
    `  ${t.padEnd(9)} L=${p[mode][t].L.toFixed(2)}  C*${p[mode][t].Cmul.toFixed(2)}`;
  const fx = (mode: Mode, k: 'insetText' | 'msgText') =>
    `  ${k.padEnd(9)} L=${p[mode][k].L.toFixed(2)}  C=${p[mode][k].C.toFixed(3)}`;
  const el = (mode: Mode) => {
    const e = p[mode].elev;
    return `  surface: ${e.sunken}/${e.base}/${e.elevated}/${e.canvas}`;
  };
  const blk = (mode: Mode) =>
    `${mode}:\n${CAT_TIERS.map((t) => r(mode, t)).join('\n')}\n${fx(mode, 'insetText')}\n${fx(mode, 'msgText')}\n${el(mode)}`;
  const sem = (s: SemanticP) =>
    `  H: crit=${s.criticalH} suc=${s.successH} warn=${s.warningH} info=${s.infoH}  L=${s.L.toFixed(2)} C=${s.C.toFixed(3)} surfL=${s.surfL.toFixed(2)} surfC=${s.surfC.toFixed(3)}`;
  const n = (n: NeutralP) =>
    `txt=${n.textL} sec=${n.secondaryL} mut=${n.mutedL} int=${n.interactiveL} bdr=${n.borderL} sub=${n.borderSubtleL}`;
  return [
    'OKLCH Token Values',
    `accent H=${p.accentHue} C=${p.accentChroma}`,
    '='.repeat(30),
    blk('light'),
    '',
    blk('dark'),
    '',
    'semantic (light):',
    sem(p.semanticLight),
    'semantic (dark):',
    sem(p.semanticDark),
    `queue: H=${p.queue.H} C=${p.queue.C} L=${p.queue.L}`,
    `neutral: H=${p.neutralHue} C=${p.neutralChroma}  light: ${n(p.neutralLight)}  dark: ${n(p.neutralDark)}`,
    `catText: H=${p.catTextH} C=${p.catTextC} lightL=${p.catTextLightL} darkL=${p.catTextDarkL}`,
  ].join('\n');
}
