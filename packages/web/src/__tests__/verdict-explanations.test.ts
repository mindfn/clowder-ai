/**
 * F257 #6 (slice 6a) — Verdict explanation vocabulary contract (判据 ③).
 *
 * Regression anchor: operator screenshot showed `eval(unmeasurable)` with no
 * explanation, because the lifeline UI only hard-coded alive/dormant/retire-candidate.
 * This test locks the canonical vocabulary + guarantees every verdict the eval layer
 * actually emits has a non-empty explanation, and that unknown verdicts degrade
 * visibly (never silently blank).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { explainVerdict, KNOWN_VERDICTS, VERDICT_EXPLANATIONS } from '../components/settings/verdict-explanations';

const SETTINGS_DIR = path.resolve(__dirname, '..', 'components', 'settings');
const readComponent = (name: string) => readFileSync(path.join(SETTINGS_DIR, name), 'utf-8');

describe('F257 #6: verdict explanations', () => {
  it('covers the real eval-layer verdict vocabulary', () => {
    // The verdict strings the eval / metrics layer actually emits.
    for (const v of ['alive', 'keep_observe', 'unmeasurable', 'dormant', 'retire-candidate']) {
      expect(KNOWN_VERDICTS).toContain(v);
    }
  });

  it('every known verdict has a non-empty label + explanation', () => {
    for (const v of KNOWN_VERDICTS) {
      const e = VERDICT_EXPLANATIONS[v];
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.explanation.length).toBeGreaterThan(0);
    }
  });

  it('unmeasurable is explained and disambiguated from zero-violation (screenshot regression)', () => {
    const e = explainVerdict('unmeasurable');
    expect(e.label).not.toBe('unmeasurable'); // has a real label, not a raw fallthrough
    expect(e.explanation).toContain('不等于'); // clarifies it is NOT zero-violation
  });

  it('null verdict → 未评估, never blank', () => {
    expect(explainVerdict(null).label).toBe('未评估');
    expect(explainVerdict(undefined).explanation.length).toBeGreaterThan(0);
  });

  it('unknown verdict degrades visibly (no silent blank)', () => {
    const e = explainVerdict('some_new_verdict_xyz');
    expect(e.label).toBe('some_new_verdict_xyz');
    expect(e.explanation.length).toBeGreaterThan(0);
  });
});

describe('F257 #6: verdict explanation wiring (判据③)', () => {
  it('LifelineChainView consumes explainVerdict (no hard-coded verdict tone ladder)', () => {
    const src = readComponent('LifelineChainView.tsx');
    expect(src).toContain("from './verdict-explanations'");
    expect(src).toContain('explainVerdict');
    // The old hard-coded verdict→tone branch must be gone (source of the unmeasurable bug).
    expect(src).not.toMatch(/verdict === 'dormant' \|\| epoch\.eval\.verdict === 'retire-candidate'/);
  });

  it('LifelineChainView surfaces the explanation as an eval-badge tooltip', () => {
    const src = readComponent('LifelineChainView.tsx');
    expect(src).toContain('evalTitle');
    expect(src).toMatch(/title\?:\s*string/); // StageBadge accepts a title
    expect(src).toMatch(/title=\{title\}/); // and renders it
  });

  it('EvalStagePanel consumes explainVerdict for the 判定 row', () => {
    const src = readComponent('EvalStagePanel.tsx');
    expect(src).toContain("from './verdict-explanations'");
    expect(src).toContain('explainVerdict');
    // The old hard-coded ternary tone must be gone.
    expect(src).not.toMatch(/verdict === 'alive' \? 'emerald'/);
  });
});
