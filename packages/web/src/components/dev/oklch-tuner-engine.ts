/* F056 OKLCH Tuner engine — types, INIT defaults, CSS generation, export. */
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
  surfaceHue: number /* warm beige ~80, independent of accent (KD-34) */;
  surfaceChroma: number /* multiplier on base chroma [0.015..0.003], default 1.0 */;
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
  sunken: '层 1 · 基底 (L)',
  base: '层 2 · 承载 (L)',
  elevated: '层 3 · 抬升 (L)',
  canvas: '层 4 · 浮出 (L)',
};

export const NEUTRAL_ROWS: [keyof NeutralP, string][] = [
  ['textL', '正文'],
  ['secondaryL', '二级'],
  ['mutedL', '弱/三级'],
  ['interactiveL', '交互'],
  ['borderL', '边框'],
  ['borderSubtleL', '细线'],
];

/* ── Per-theme INIT defaults (CVO-tuned 2026-05-28) ──
 * Light and Dark themes have different accent hue, inset/msgText tuning,
 * surface elevation, and catText color. INIT = INIT_DARK (migration fallback). */
export const INIT_LIGHT: TunerState = {
  accentHue: 50,
  accentChroma: 0.12,
  surfaceHue: 80,
  surfaceChroma: 1.0,
  light: {
    primary: { L: 0.62, Cmul: 1.0 },
    surface: { L: 0.9, Cmul: 0.5 },
    text: { L: 0.24, Cmul: 0.8 },
    inset: { L: 0.3, Cmul: 0.15 },
    ring: { L: 0.55, Cmul: 1.1 },
    insetText: { L: 0.75, C: 0.03 },
    msgText: { L: 0.3, C: 0.01 },
    elev: { sunken: 0.9, base: 0.95, elevated: 0.985, canvas: 0.99 },
  },
  dark: {
    primary: { L: 0.68, Cmul: 0.85 },
    surface: { L: 0.28, Cmul: 0.25 },
    text: { L: 0.88, Cmul: 0.6 },
    inset: { L: 0.24, Cmul: 0.1 },
    ring: { L: 0.7, Cmul: 1.0 },
    insetText: { L: 0.8, C: 0.02 },
    msgText: { L: 0.8, C: 0.02 },
    elev: { sunken: 0.275, base: 0.18, elevated: 0.1, canvas: 0.18 },
  },
  // biome-ignore format: compact INIT block
  semanticLight: { criticalH: 38, successH: 135, warningH: 46, infoH: 209, L: 0.57, C: 0.12, surfL: 0.96, surfC: 0.03 },
  semanticDark: { criticalH: 25, successH: 145, warningH: 70, infoH: 230, L: 0.7, C: 0.17, surfL: 0.25, surfC: 0.05 },
  queue: { H: 290, C: 0.1, L: 0.62 },
  neutralHue: 30,
  neutralChroma: 0.005,
  neutralLight: { textL: 0.2, secondaryL: 0.45, mutedL: 0.56, interactiveL: 0.36, borderL: 0.84, borderSubtleL: 0.915 },
  neutralDark: { textL: 0.94, secondaryL: 0.76, mutedL: 0.66, interactiveL: 0.84, borderL: 0.32, borderSubtleL: 0.24 },
  catTextH: 5,
  catTextC: 0.025,
  catTextLightL: 0.15,
  catTextDarkL: 0.88,
};

export const INIT_DARK: TunerState = {
  accentHue: 35,
  accentChroma: 0.12,
  surfaceHue: 80,
  surfaceChroma: 1.0,
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
    surface: { L: 0.3, Cmul: 0.25 },
    text: { L: 0.88, Cmul: 0.6 },
    inset: { L: 0.24, Cmul: 0.1 },
    ring: { L: 0.7, Cmul: 1.0 },
    insetText: { L: 0.8, C: 0.02 },
    msgText: { L: 0.75, C: 0.04 },
    elev: { sunken: 0.4, base: 0.25, elevated: 0.1, canvas: 0.2 },
  },
  // biome-ignore format: compact INIT block
  semanticLight: { criticalH: 38, successH: 135, warningH: 46, infoH: 209, L: 0.57, C: 0.12, surfL: 0.96, surfC: 0.03 },
  semanticDark: { criticalH: 25, successH: 145, warningH: 70, infoH: 230, L: 0.7, C: 0.17, surfL: 0.25, surfC: 0.05 },
  queue: { H: 290, C: 0.1, L: 0.62 },
  neutralHue: 30,
  neutralChroma: 0.005,
  neutralLight: { textL: 0.2, secondaryL: 0.45, mutedL: 0.56, interactiveL: 0.36, borderL: 0.84, borderSubtleL: 0.915 },
  neutralDark: { textL: 0.94, secondaryL: 0.76, mutedL: 0.66, interactiveL: 0.84, borderL: 0.32, borderSubtleL: 0.24 },
  catTextH: 35,
  catTextC: 0.095,
  catTextLightL: 0.24,
  catTextDarkL: 0.9,
};

/** Migration fallback — used by migrateTunerState() to patch missing fields. */
export const INIT = INIT_DARK;

export const STYLE_ID = 'oklch-tuner-override';

/** Deep-merge SurfaceP to handle fields added after a user saved their theme. */
function migrateElev(e: Partial<SurfaceP> | undefined, fallback: SurfaceP): SurfaceP {
  if (!e) return fallback;
  return {
    sunken: e.sunken ?? fallback.sunken,
    base: e.base ?? fallback.base,
    elevated: e.elevated ?? fallback.elevated,
    canvas: e.canvas ?? fallback.canvas,
  };
}

/** Patch missing ModeP fields from INIT (forward-compat for schema additions). */
function migrateModeP(m: Partial<ModeP>, fallback: ModeP): ModeP {
  return {
    primary: m.primary ?? fallback.primary,
    surface: m.surface ?? fallback.surface,
    text: m.text ?? fallback.text,
    inset: m.inset ?? fallback.inset,
    ring: m.ring ?? fallback.ring,
    insetText: m.insetText ?? fallback.insetText,
    msgText: m.msgText ?? fallback.msgText,
    elev: migrateElev(m.elev as Partial<SurfaceP> | undefined, fallback.elev),
  };
}

/** Patch missing TunerState fields with INIT defaults (survives schema additions). */
export function migrateTunerState(s: Partial<TunerState>): TunerState {
  return {
    ...INIT,
    ...s,
    light: migrateModeP((s.light as Partial<ModeP>) ?? {}, INIT.light),
    dark: migrateModeP((s.dark as Partial<ModeP>) ?? {}, INIT.dark),
  };
}

/* ── CSS generation ── */
export function buildCSS(p: TunerState, hc: HcOverride): string {
  const ok = (m: ModeP, t: CatTier, h: string, c: string) => `oklch(${m[t].L} calc(${c} * ${m[t].Cmul}) ${h})`;
  const it = (m: ModeP) => `oklch(${m.insetText.L} ${m.insetText.C} 250)`;
  /* Defensive: old persisted data may lack msgText (added mid-PR) */
  const mt = (m: ModeP) => {
    const msg = m.msgText ?? INIT.light.msgText;
    return `oklch(${msg.L} ${msg.C} ${p.neutralHue})`;
  };

  // 1. Accent + surface hue — accent cascades to --accent-*, surface hue is independent (KD-34)
  const sH = p.surfaceHue ?? 80;
  const accent = `:root{--accent-hue:${p.accentHue};--accent-chroma:${p.accentChroma};--surface-hue:${sH};}`;

  // 1b. Cat tier gradients — per-slug tokens in cat-persona-tokens.css consume these
  const catGrads = (m: ModeP, dark: boolean) => {
    const sel = dark ? '[data-theme="dark"]' : ':root';
    /* Defensive: old persisted data may lack msgText */
    const msg = m.msgText ?? (dark ? INIT.dark.msgText : INIT.light.msgText);
    /* Cat name text: unified H/L/C across all cats. CSS formulas in
     * cat-persona-tokens.css consume --cat-name-l/c/h (not per-cat hue).
     * This avoids fragile source-order override of final --color-{slug}-text. */
    const nameL = dark ? p.catTextDarkL : p.catTextLightL;
    return (
      `${sel}{` +
      `--cat-bubble-l:${m.primary.L};--cat-bubble-cmul:${m.primary.Cmul};` +
      `--cat-surface-l:${m.surface.L};--cat-surface-cmul:${m.surface.Cmul};` +
      `--cat-text-l:${m.text.L};--cat-text-cmul:${m.text.Cmul};` +
      `--cat-ring-l:${m.ring.L};--cat-ring-cmul:${m.ring.Cmul};` +
      `--cat-inset-l:${m.inset.L};--cat-inset-cmul:${m.inset.Cmul};` +
      `--cat-inset-text-l:${m.insetText.L};--cat-inset-text-c:${m.insetText.C};` +
      `--cat-msg-text-l:${msg.L};--cat-msg-text-c:${msg.C};` +
      `--cat-name-l:${nameL};--cat-name-c:${p.catTextC};--cat-name-h:${p.catTextH};}`
    );
  };

  // 2. Surface elevation — hue + chroma independent of accent (KD-34)
  const sCmul = p.surfaceChroma ?? 1;
  const surf = (e: SurfaceP, dark: boolean) => {
    const sel = dark ? '[data-theme="dark"]' : ':root';
    const ch = [0.015, 0.012, 0.005, 0.003].map((c) => +(c * sCmul).toFixed(4));
    const h = sH;
    return (
      `${sel}{` +
      `--cafe-surface-sunken:oklch(${e.sunken} ${ch[0]} ${h});` +
      `--cafe-surface:oklch(${e.base} ${ch[1]} ${h});` +
      `--cafe-surface-elevated:oklch(${e.elevated} ${ch[2]} ${h});` +
      `--cafe-surface-canvas:oklch(${e.canvas} ${ch[3]} ${h});}`
    );
  };

  // 3. Runtime message derived (.cat-persona-derived)
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
    // --cat-{tier}-l/cmul → cat-persona-tokens.css per-slug formulas + CatHueInjector
    catGrads(p.light, false),
    catGrads(p.dark, true),
    surf(p.light.elev, false),
    surf(p.dark.elev, true),
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
