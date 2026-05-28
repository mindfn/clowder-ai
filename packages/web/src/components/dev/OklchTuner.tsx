'use client';

/* eslint-disable cafe/no-hardcoded-colors -- OKLCH Tuner is the design-token EDITOR itself;
 * preview swatches must render dynamic oklch() literals computed from live params.
 * This file is the documented AC-E11 exception. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { applyThemeCSS, getActiveTheme, useThemeStore } from '@/stores/themeStore';
import { useDrag } from './oklch-tuner-drag';
import {
  type CatTier,
  exportText,
  type Mode,
  type NeutralP,
  type SemanticP,
  SURF_KEYS,
  SURF_LABELS,
  type SurfaceP,
  TIER_LABELS,
  type TunerState,
} from './oklch-tuner-engine';
import { TunerExtraSections } from './oklch-tuner-extra';
import { Slider } from './oklch-tuner-slider';
import { PaletteIcon } from '../ThemeMenu';

/* ── Section header SVG icons (replace emoji per maintainer feedback) ── */
const IC = 'w-3 h-3 shrink-0';
function LayersIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={IC}>
      <title>页面层次</title>
      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function BubbleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={IC}>
      <title>气泡</title>
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function TagIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={IC}>
      <title>标签</title>
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="7" cy="7" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/* Only surface (bubble bg) and inset (thinking block) are user-tunable;
 * primary → accent, text → unified section below, ring → unused token */
const TUNER_TIERS: readonly CatTier[] = ['surface', 'inset'];

/* ── Main component ── */
export function OklchTuner({ onClose }: { onClose: () => void }) {
  const store = useThemeStore();
  const active = getActiveTheme(store);
  const mode: Mode = active.base;
  const [params, setParams] = useState<TunerState>(() => structuredClone(active.params));
  const [copied, setCopied] = useState(false);
  const skipSync = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeId is a change-trigger, not used as value
  useEffect(() => {
    skipSync.current = true;
    setParams(structuredClone(getActiveTheme(useThemeStore.getState()).params));
  }, [store.activeId]);

  /* Live CSS injection + sync to store (skip store write after theme switch) */
  useEffect(() => {
    applyThemeCSS(params);
    if (skipSync.current) {
      skipSync.current = false;
    } else {
      useThemeStore.getState().updateParams(params);
    }
  }, [params]);

  const updateTier = useCallback(
    (tier: CatTier | 'insetText', field: 'L' | 'Cmul' | 'C', value: number) => {
      setParams((prev) => ({
        ...prev,
        [mode]: { ...prev[mode], [tier]: { ...prev[mode][tier], [field]: value } },
      }));
    },
    [mode],
  );

  const updateElev = useCallback(
    (key: keyof SurfaceP, value: number) => {
      setParams((prev) => ({
        ...prev,
        [mode]: { ...prev[mode], elev: { ...prev[mode].elev, [key]: value } },
      }));
    },
    [mode],
  );

  const updateSemantic = useCallback(
    (field: keyof SemanticP, value: number) => {
      const key = mode === 'light' ? 'semanticLight' : 'semanticDark';
      setParams((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
    },
    [mode],
  );

  const updateQueue = useCallback((field: 'H' | 'C' | 'L', value: number) => {
    setParams((prev) => ({ ...prev, queue: { ...prev.queue, [field]: value } }));
  }, []);

  const updateNeutral = useCallback(
    (field: keyof NeutralP, value: number) => {
      const key = mode === 'light' ? 'neutralLight' : 'neutralDark';
      setParams((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
    },
    [mode],
  );

  const handleCopy = () => {
    navigator.clipboard.writeText(exportText(params));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const handleReset = () => {
    store.resetTheme();
    setParams(structuredClone(getActiveTheme(useThemeStore.getState()).params));
  };

  const mp = params[mode];
  const { pos, onPointerDown } = useDrag({ x: 70, y: 80 });

  return (
    <div
      className="fixed z-[9999] w-[420px] max-h-[85vh] overflow-y-auto rounded-xl bg-cafe-surface-sunken text-cafe shadow-2xl border border-[var(--console-border-soft)] text-xs font-mono"
      style={{ left: pos.x, top: pos.y, backdropFilter: 'blur(12px)' }}
    >
      {/* Header — drag handle */}
      <div
        className="flex items-center justify-between px-3 py-2 border-b border-[var(--console-border-soft)] sticky top-0 bg-cafe-surface-sunken z-10 cursor-grab active:cursor-grabbing select-none"
        onPointerDown={onPointerDown}
      >
        <span className="font-bold text-sm flex items-center gap-1"><PaletteIcon className="w-4 h-4 inline-block" /> OKLCH Tuner — {active.name}</span>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={handleCopy}
            className="px-2 py-0.5 rounded bg-[var(--semantic-success)] hover:opacity-90 text-[10px]"
          >
            {copied ? '✓' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={handleReset}
            className="px-2 py-0.5 rounded bg-cafe-surface-sunken hover:bg-[var(--console-hover-bg)] text-[10px]"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-2 py-0.5 rounded bg-[var(--semantic-critical)] hover:opacity-90 text-[10px]"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="p-3 space-y-3">
        {/* ── 1. Accent (accent-hue → ALL buttons/links/highlights) ── */}
        <div className="space-y-1 pb-2 border-b border-[var(--console-border-soft)]">
          <div className="flex items-center gap-2">
            <div className="text-[10px] text-cafe-muted font-bold flex items-center gap-1"><PaletteIcon className="w-3 h-3" /> 全局主题色 (按钮/链接/高亮/品牌)</div>
            <div
              className="w-4 h-4 rounded border border-[var(--console-border-soft)] shrink-0 ml-auto"
              style={{ background: `oklch(0.65 ${params.accentChroma} ${params.accentHue})` }}
            />
          </div>
          <Slider
            label="H"
            value={params.accentHue}
            min={0}
            max={360}
            step={1}
            fmt={`${params.accentHue}`}
            onChange={(v) => setParams((p) => ({ ...p, accentHue: v }))}
          />
          <Slider
            label="C"
            value={params.accentChroma}
            min={0}
            max={0.3}
            step={0.005}
            fmt={params.accentChroma.toFixed(3)}
            onChange={(v) => setParams((p) => ({ ...p, accentChroma: v }))}
          />
          <div className="flex gap-0.5 pl-4">
            {[0.97, 0.88, 0.65, 0.55, 0.45, 0.35, 0.2].map((l) => (
              <div
                key={l}
                className="flex-1 h-3 rounded-sm border border-[var(--console-border-soft)]"
                style={{ background: `oklch(${l} ${params.accentChroma} ${params.accentHue})` }}
              />
            ))}
          </div>
        </div>

        {/* ── 2. Surface elevation ── */}
        <div className="space-y-1 pb-2 border-b border-[var(--console-border-soft)]">
          <div className="text-[10px] text-cafe-muted font-bold flex items-center gap-1"><LayersIcon /> 页面层次 ({mode})</div>
          {SURF_KEYS.map((k) => (
            <div key={k} className="flex items-center gap-1.5">
              <div
                className="w-3 h-3 rounded border border-[var(--console-border-soft)] shrink-0"
                style={{ background: `oklch(${mp.elev[k]} 0.012 80)` }}
              />
              <span className="w-20 text-[9px] text-cafe-muted shrink-0">{SURF_LABELS[k]}</span>
              <input
                type="range"
                aria-label={SURF_LABELS[k]}
                min={0}
                max={1}
                step={0.005}
                value={mp.elev[k]}
                onChange={(e) => updateElev(k, +e.target.value)}
                className="flex-1 h-1 accent-[var(--color-cafe-accent)]"
              />
              <span className="w-9 text-right text-[9px] tabular-nums shrink-0">{mp.elev[k].toFixed(3)}</span>
            </div>
          ))}
        </div>

        {/* ── 3. Bubble / inset tier (L/Cmul 派生) ── */}
        <div className="space-y-1.5 pb-2 border-b border-[var(--console-border-soft)]">
          <div className="text-[10px] text-cafe-muted font-bold flex items-center gap-1"><BubbleIcon /> 气泡/嵌套 ({mode})</div>
          {TUNER_TIERS.map((tier) => (
            <div key={tier} className="space-y-0.5">
              <div className="flex items-center gap-2 pl-4">
                <span className="text-[10px] text-cafe-muted">{TIER_LABELS[tier]}</span>
                <span className="text-[10px] text-cafe-secondary ml-auto tabular-nums">
                  L={mp[tier].L.toFixed(2)} C*{mp[tier].Cmul.toFixed(2)}
                </span>
              </div>
              <Slider
                label="L"
                value={mp[tier].L}
                min={0}
                max={1}
                step={0.01}
                fmt={mp[tier].L.toFixed(2)}
                onChange={(v) => updateTier(tier, 'L', v)}
              />
              <Slider
                label="C*"
                value={mp[tier].Cmul}
                min={0}
                max={2}
                step={0.01}
                fmt={mp[tier].Cmul.toFixed(2)}
                onChange={(v) => updateTier(tier, 'Cmul', v)}
              />
            </div>
          ))}
        </div>

        {/* ── 4. Inset text (紧跟气泡/嵌套，同为成员色推导) ── */}
        <div className="space-y-0.5 pb-2 border-b border-[var(--console-border-soft)]">
          <div className="pl-4">
            <span className="text-[10px] text-cafe-muted">{TIER_LABELS.insetText}</span>
          </div>
          <Slider
            label="L"
            value={mp.insetText.L}
            min={0}
            max={1}
            step={0.01}
            fmt={mp.insetText.L.toFixed(2)}
            onChange={(v) => updateTier('insetText', 'L', v)}
          />
          <Slider
            label="C"
            value={mp.insetText.C}
            min={0}
            max={0.1}
            step={0.001}
            fmt={mp.insetText.C.toFixed(3)}
            onChange={(v) => updateTier('insetText', 'C', v)}
          />
        </div>

        {/* ── 5. Cat name text (unified H/L/C — 所有猫共用，不跟成员主题色) ── */}
        <div className="space-y-0.5 pb-2 border-b border-[var(--console-border-soft)]">
          <div className="flex items-center gap-2">
            <div className="text-[10px] text-cafe-muted font-bold flex items-center gap-1"><TagIcon /> 猫名文字 (统一)</div>
            <div
              className="w-4 h-4 rounded border border-[var(--console-border-soft)] shrink-0 ml-auto"
              style={{
                background: `oklch(${mode === 'light' ? params.catTextLightL : params.catTextDarkL} ${params.catTextC} ${params.catTextH})`,
              }}
            />
          </div>
          <Slider
            label="H"
            value={params.catTextH}
            min={0}
            max={360}
            step={1}
            fmt={`${params.catTextH}`}
            onChange={(v) => setParams((p) => ({ ...p, catTextH: v }))}
          />
          <Slider
            label="L"
            value={mode === 'light' ? params.catTextLightL : params.catTextDarkL}
            min={0}
            max={1}
            step={0.01}
            fmt={(mode === 'light' ? params.catTextLightL : params.catTextDarkL).toFixed(2)}
            onChange={(v) => {
              const key = mode === 'light' ? 'catTextLightL' : 'catTextDarkL';
              setParams((p) => ({ ...p, [key]: v }));
            }}
          />
          <Slider
            label="C"
            value={params.catTextC}
            min={0}
            max={0.15}
            step={0.005}
            fmt={params.catTextC.toFixed(3)}
            onChange={(v) => setParams((p) => ({ ...p, catTextC: v }))}
          />
        </div>

        <TunerExtraSections
          mode={mode}
          params={params}
          onSemantic={updateSemantic}
          onQueue={updateQueue}
          onNeutral={updateNeutral}
        />
      </div>
    </div>
  );
}
