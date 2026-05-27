/*
 * F056 OKLCH Tuner — extra sections (semantic, queue, neutral)
 *
 * Extracted from OklchTuner to keep files under 350-line hard limit.
 * Sections: 6. Semantic status · 7. Queue accent · 8. Text/Border (neutral)
 */

/* eslint-disable cafe/no-hardcoded-colors -- OKLCH Tuner sub-module; preview swatches
 * must render dynamic oklch() literals computed from live params. AC-E11 exception. */
import {
  type Mode,
  NEUTRAL_ROWS,
  type NeutralP,
  SEMANTIC_H_FIELD,
  SEMANTIC_KEYS,
  SEMANTIC_LABELS,
  type SemanticP,
  type TunerState,
} from './oklch-tuner-engine';
import { Slider } from './oklch-tuner-slider';

interface Props {
  mode: Mode;
  params: TunerState;
  onSemantic: (field: keyof SemanticP, value: number) => void;
  onQueue: (field: 'H' | 'C' | 'L', value: number) => void;
  onNeutral: (field: keyof NeutralP, value: number) => void;
}

export function TunerExtraSections({ mode, params, onSemantic, onQueue, onNeutral }: Props) {
  const sp = mode === 'light' ? params.semanticLight : params.semanticDark;
  const np = mode === 'light' ? params.neutralLight : params.neutralDark;

  return (
    <>
      {/* ── 6. Semantic status colors ── */}
      <div className="space-y-1 pb-2 border-b border-[var(--console-border-soft)]">
        <div className="text-[10px] text-cafe-muted font-bold">🚦 语义状态色 ({mode})</div>
        <div className="flex gap-0.5 pl-4">
          {SEMANTIC_KEYS.map((k) => {
            const h = sp[SEMANTIC_H_FIELD[k] as keyof SemanticP] as number;
            return (
              <div key={k} className="flex-1 text-center">
                <div
                  className="h-5 rounded-sm border border-[var(--console-border-soft)] mb-0.5"
                  style={{ background: `oklch(${sp.L} ${sp.C} ${h})` }}
                />
                <div
                  className="h-3 rounded-sm border border-[var(--console-border-soft)]"
                  style={{ background: `oklch(${sp.surfL} ${sp.surfC} ${h})` }}
                />
                <span className="text-[8px] text-cafe-muted block mt-0.5">{k}</span>
              </div>
            );
          })}
        </div>
        {SEMANTIC_KEYS.map((k) => {
          const field = SEMANTIC_H_FIELD[k] as keyof SemanticP;
          return (
            <div key={k} className="flex items-center gap-1 pl-4">
              <span className="w-12 text-[9px] text-cafe-muted shrink-0 truncate">
                {SEMANTIC_LABELS[k].split(' ')[0]}
              </span>
              <span className="w-5 text-[9px] text-cafe-muted shrink-0">H</span>
              <input
                type="range"
                aria-label={`${k} hue`}
                min={0}
                max={360}
                step={1}
                value={sp[field] as number}
                onChange={(e) => onSemantic(field, +e.target.value)}
                className="flex-1 h-1 accent-[var(--color-cafe-accent)]"
              />
              <span className="w-8 text-right text-[9px] tabular-nums shrink-0">{sp[field] as number}</span>
            </div>
          );
        })}
        <Slider
          label="L"
          value={sp.L}
          min={0.3}
          max={0.9}
          step={0.01}
          fmt={sp.L.toFixed(2)}
          onChange={(v) => onSemantic('L', v)}
        />
        <Slider
          label="C"
          value={sp.C}
          min={0}
          max={0.3}
          step={0.005}
          fmt={sp.C.toFixed(3)}
          onChange={(v) => onSemantic('C', v)}
        />
      </div>

      {/* ── 7. Queue accent ── */}
      <div className="space-y-1 pb-2 border-b border-[var(--console-border-soft)]">
        <div className="text-[10px] text-cafe-muted font-bold">📬 队列强调色</div>
        <div className="flex gap-0.5 pl-4">
          {[0, -0.06, 0.34].map((dL, i) => (
            <div
              key={i}
              className="flex-1 h-4 rounded-sm border border-[var(--console-border-soft)]"
              style={{
                background: `oklch(${params.queue.L + dL} ${params.queue.C * (i === 2 ? 0.2 : 1)} ${params.queue.H})`,
              }}
            />
          ))}
        </div>
        <Slider
          label="H"
          value={params.queue.H}
          min={0}
          max={360}
          step={1}
          fmt={`${params.queue.H}`}
          onChange={(v) => onQueue('H', v)}
        />
        <Slider
          label="C"
          value={params.queue.C}
          min={0}
          max={0.25}
          step={0.005}
          fmt={params.queue.C.toFixed(3)}
          onChange={(v) => onQueue('C', v)}
        />
        <Slider
          label="L"
          value={params.queue.L}
          min={0.3}
          max={0.85}
          step={0.01}
          fmt={params.queue.L.toFixed(2)}
          onChange={(v) => onQueue('L', v)}
        />
      </div>

      {/* ── 8. Text/Border (also drives console tokens via alias) ── */}
      <div className="space-y-1">
        <div className="text-[10px] text-cafe-muted font-bold">📝 文字/边框 ({mode})</div>
        {NEUTRAL_ROWS.map(([f, lbl]) => (
          <div key={f} className="flex items-center gap-1.5 pl-4">
            <div
              className="w-3 h-3 rounded border border-[var(--console-border-soft)] shrink-0"
              style={{ background: `oklch(${np[f]} ${params.neutralChroma} ${params.neutralHue})` }}
            />
            <span className="w-14 text-[9px] text-cafe-muted shrink-0">{lbl}</span>
            <input
              type="range"
              aria-label={lbl}
              min={0}
              max={1}
              step={0.005}
              value={np[f]}
              onChange={(e) => onNeutral(f, +e.target.value)}
              className="flex-1 h-1 accent-[var(--color-cafe-accent)]"
            />
            <span className="w-9 text-right text-[9px] tabular-nums shrink-0">{np[f].toFixed(3)}</span>
          </div>
        ))}
      </div>
    </>
  );
}
