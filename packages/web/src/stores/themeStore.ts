/*
 * F056 Theme Store — manages theme presets + localStorage persistence
 *
 * Built-in themes (Light/Dark) use INIT defaults from the OKLCH engine.
 * Users can create up to 2 custom themes by cloning an existing one.
 * The active theme's params are applied as CSS overrides via ThemeApplier.
 */
import { create } from 'zustand';
import { buildCSS, type HcOverride, INIT, STYLE_ID, type TunerState } from '@/components/dev/oklch-tuner-engine';

const LS_KEY = 'cat-cafe:themes';
const MAX_CUSTOM = 2;
const NO_HC: HcOverride = { on: false, hue: 0, chroma: 0 };
/* Bump when INIT defaults change in a way that user's persisted built-in
 * overrides should be discarded (so they see the new defaults instead of
 * stale tuner edits from an older INIT). Custom themes are preserved. */
const INIT_VERSION = '2026-05-27-cvo-tuning';

export interface ThemePreset {
  id: string;
  name: string;
  base: 'light' | 'dark';
  params: TunerState;
  builtIn: boolean;
}

interface ThemeState {
  themes: ThemePreset[];
  activeId: string;
  setActive: (id: string) => void;
  updateParams: (params: TunerState) => void;
  createCustom: (name: string, cloneFrom: string) => string | null;
  deleteCustom: (id: string) => void;
  resetTheme: () => void;
}

/* ── Persistence helpers ── */
function readLS(): { custom: ThemePreset[]; activeId: string; builtInOverrides: Record<string, TunerState> } {
  const empty = { custom: [] as ThemePreset[], activeId: 'light', builtInOverrides: {} as Record<string, TunerState> };
  if (typeof window === 'undefined') return empty;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return empty;
    const d = JSON.parse(raw) as {
      version?: string;
      custom?: ThemePreset[];
      activeId?: string;
      builtInOverrides?: Record<string, TunerState>;
    };
    /* INIT version migration: if persisted version is missing or older than
     * the current INIT_VERSION, discard built-in overrides so the user sees
     * the new INIT defaults. Custom themes are preserved (they're explicit
     * user creations, not stale tuner edits on built-ins). */
    const versionMismatch = d.version !== INIT_VERSION;
    if (versionMismatch && typeof console !== 'undefined') {
      console.info(
        `[F056 themeStore] INIT version changed (was: ${d.version ?? 'none'}, now: ${INIT_VERSION}). ` +
          'Discarding stale built-in tuner overrides; custom themes preserved.',
      );
    }
    return {
      custom: Array.isArray(d.custom) ? d.custom.slice(0, MAX_CUSTOM) : [],
      activeId: d.activeId ?? 'light',
      builtInOverrides:
        versionMismatch || !d.builtInOverrides || typeof d.builtInOverrides !== 'object' ? {} : d.builtInOverrides,
    };
  } catch {
    return empty;
  }
}

function writeLS(themes: ThemePreset[], activeId: string) {
  try {
    const custom = themes.filter((t) => !t.builtIn);
    // Persist built-in param overrides so tuner edits on Light/Dark survive refresh
    const builtInOverrides: Record<string, TunerState> = {};
    for (const t of themes) {
      if (t.builtIn) builtInOverrides[t.id] = t.params;
    }
    localStorage.setItem(LS_KEY, JSON.stringify({ version: INIT_VERSION, activeId, custom, builtInOverrides }));
  } catch {
    /* noop — quota exceeded or private mode */
  }
}

const mkBuiltIn = (): ThemePreset[] => [
  { id: 'light', name: 'Light', base: 'light', params: structuredClone(INIT), builtIn: true },
  { id: 'dark', name: 'Dark', base: 'dark', params: structuredClone(INIT), builtIn: true },
];

/* ── Store ── */
export const useThemeStore = create<ThemeState>((set, get) => {
  const { custom, activeId, builtInOverrides } = readLS();
  const builtIns = mkBuiltIn().map((t) => (builtInOverrides[t.id] ? { ...t, params: builtInOverrides[t.id] } : t));
  return {
    themes: [...builtIns, ...custom],
    activeId,

    setActive: (id) => {
      set({ activeId: id });
      writeLS(get().themes, id);
    },

    updateParams: (params) => {
      const { activeId: aid, themes } = get();
      const updated = themes.map((t) => (t.id === aid ? { ...t, params } : t));
      set({ themes: updated });
      writeLS(updated, aid);
    },

    createCustom: (name, cloneFrom) => {
      const { themes } = get();
      if (themes.filter((t) => !t.builtIn).length >= MAX_CUSTOM) return null;
      const src = themes.find((t) => t.id === cloneFrom);
      if (!src) return null;
      const id = `custom-${Date.now()}`;
      const preset: ThemePreset = {
        id,
        name,
        base: src.base,
        params: structuredClone(src.params),
        builtIn: false,
      };
      const updated = [...themes, preset];
      set({ themes: updated, activeId: id });
      writeLS(updated, id);
      return id;
    },

    deleteCustom: (id) => {
      const { themes, activeId: aid } = get();
      const updated = themes.filter((t) => t.id !== id || t.builtIn);
      const newActive = aid === id ? 'light' : aid;
      set({ themes: updated, activeId: newActive });
      writeLS(updated, newActive);
    },

    resetTheme: () => {
      const { activeId: aid, themes } = get();
      const updated = themes.map((t) => (t.id === aid ? { ...t, params: structuredClone(INIT) } : t));
      set({ themes: updated });
      writeLS(updated, aid);
    },
  };
});

/* ── Selectors ── */
export function getActiveTheme(state: ThemeState): ThemePreset {
  return state.themes.find((t) => t.id === state.activeId) ?? state.themes[0];
}

/* ── CSS injection (called by ThemeApplier + on page init) ── */
export function applyThemeCSS(params: TunerState) {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  const css = buildCSS(params, NO_HC);
  el.textContent = css;
  /* Debug aid: expose last applied params + CSS length on window for console inspection.
   * Open DevTools and inspect `window.__f056ThemeDebug` to verify CSS injection is live. */
  if (typeof window !== 'undefined') {
    (window as unknown as { __f056ThemeDebug?: unknown }).__f056ThemeDebug = {
      lastApplyAt: Date.now(),
      cssLength: css.length,
      params,
      styleElPresent: !!document.getElementById(STYLE_ID),
    };
  }
}
