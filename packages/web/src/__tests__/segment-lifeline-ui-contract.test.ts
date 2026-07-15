/**
 * F257 Phase D — Segment lifeline UI contract tests.
 *
 * Verifies two non-degradable UI contracts (terra P2-3/P2-4):
 *   1. Guard events section surfaces "窗口关联" / "非因果" attribution
 *   2. Lifeline entry point is a <button> with aria-label, not a <span>
 *
 * Source-structure contracts: read the actual component source and verify
 * the presence of key elements. No jsdom/render needed — these guard
 * against silent regression during refactoring.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SETTINGS_DIR = path.resolve(__dirname, '..', 'components', 'settings');

function readComponent(name: string): string {
  return readFileSync(path.join(SETTINGS_DIR, name), 'utf-8');
}

describe('segment lifeline: guard event attribution (P2-3)', () => {
  // Guard event rendering (attribution hint, GuardEvent interface) moved to
  // LifelineStageDetail.tsx in Phase D chain refactor. SegmentLifelineModal
  // is now the outer shell; LifelineStageDetail renders stage-specific panels.
  const src = readComponent('LifelineStageDetail.tsx');

  it('GuardEvent interface includes attribution field', () => {
    // The interface must declare the attribution field from the API
    expect(src).toMatch(/interface\s+GuardEvent[\s\S]*?attribution\??:\s*['"]window-correlated['"]/);
  });

  it('section title contains "窗口关联"', () => {
    // Must not regress to plain "守卫事件" without attribution context
    expect(src).toContain('窗口关联');
  });

  it('section includes "非因果" disclaimer', () => {
    // The non-causal caveat must be visible to the user
    expect(src).toContain('非因果');
  });
});

describe('segment lifeline: lifecycle event kind labels (AF-5)', () => {
  const uiSrc = readComponent('LifelineStageDetail.tsx');

  // Extract LifecycleEventKind union members from the SHARED type source —
  // not a hand-copied list. If a new kind is added to segment-lifecycle.ts
  // but not to KIND_LABEL, this test fails. (AF-5 root cause: hand-copy drifts.)
  const sharedTypeSrc = readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'shared', 'src', 'types', 'segment-lifecycle.ts'),
    'utf-8',
  );
  // Match all single-quoted string literals in the LifecycleEventKind union
  const kindMatches = sharedTypeSrc.match(/export type LifecycleEventKind[\s\S]*?;/);
  const kinds = kindMatches ? [...kindMatches[0].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];

  it('shared type has LifecycleEventKind members (test sanity)', () => {
    expect(kinds.length).toBeGreaterThanOrEqual(8);
  });

  it('KIND_LABEL covers every LifecycleEventKind from shared types', () => {
    for (const kind of kinds) {
      expect(uiSrc).toContain(`'${kind}'`);
    }
  });

  it('governance-reject has Chinese label (not raw enum)', () => {
    expect(uiSrc).toMatch(/'governance-reject':\s*'[^']+'/);
  });
});

describe('segment lifeline: eval pending metrics panel (AC补遗)', () => {
  const evalSrc = readComponent('EvalStagePanel.tsx');

  it('EvalStagePanel shows observation count in pending state', () => {
    expect(evalSrc).toContain('观测次数');
  });

  it('EvalStagePanel shows guard event count in pending state', () => {
    expect(evalSrc).toContain('违规事件');
  });

  it('EvalStagePanel shows trigger progress toward threshold', () => {
    expect(evalSrc).toContain('触发进度');
    expect(evalSrc).toContain('EVAL_TRIGGER_THRESHOLD');
  });

  it('EvalStagePanel shows eval method (fired-count)', () => {
    expect(evalSrc).toContain('fired-count');
  });

  it('EvalStagePanel explains zero-violation state', () => {
    expect(evalSrc).toContain('零违规事件');
  });

  it('EvalStagePanel has progress bar for trigger threshold', () => {
    expect(evalSrc).toContain('progressPct');
  });
});

describe('segment lifeline: version operation buttons (①)', () => {
  const detailSrc = readComponent('LifelineStageDetail.tsx');
  const actionsSrc = readComponent('VersionActions.tsx');

  it('LifelineStageDetail imports action button components', () => {
    expect(detailSrc).toContain('ActivateVersionButton');
    expect(detailSrc).toContain('ToggleOverrideButton');
    expect(detailSrc).toContain('RollbackButton');
  });

  it('VersionActions calls prompt-hooks API endpoints', () => {
    expect(actionsSrc).toContain('/api/prompt-hooks/');
    expect(actionsSrc).toContain('/versions/activate');
    expect(actionsSrc).toContain('/override');
  });

  it('VersionActions requires reason for audit trail', () => {
    expect(actionsSrc).toContain('审计追踪');
    expect(actionsSrc).toContain('reason');
  });

  it('destructive actions have confirmation', () => {
    expect(actionsSrc).toContain('window.confirm');
  });

  it('LifelineStageDetail accepts hookId and onRefresh props', () => {
    expect(detailSrc).toContain('hookId: string');
    expect(detailSrc).toContain('onRefresh: () => void');
  });
});

describe('segment lifeline: tracing row drill-down (②)', () => {
  const src = readComponent('LifelineStageDetail.tsx');

  it('ObservationRow is expandable (has useState toggle)', () => {
    expect(src).toContain('useState');
    expect(src).toMatch(/setExpanded/);
  });

  it('expanded row shows threadId and turnId', () => {
    expect(src).toContain('obs.threadId');
    expect(src).toContain('obs.turnId');
  });

  it('expand indicator shows ▸/▾ chevron', () => {
    expect(src).toContain('▾');
    expect(src).toContain('▸');
  });
});

describe('segment lifeline: a11y entry point (P2-4)', () => {
  const src = readComponent('StageDetailPanels.tsx');

  it('lifeline trigger is a <button>, not a <span>', () => {
    // The 📊 trigger must be a semantic button for keyboard/screen-reader access
    expect(src).toMatch(/<button[\s\S]*?📊[\s\S]*?<\/button>/);
    // Must NOT have a clickable span with the chart emoji
    expect(src).not.toMatch(/<span[^>]*onClick[\s\S]*?📊[\s\S]*?<\/span>/);
  });

  it('lifeline button has aria-label', () => {
    // The button must have an accessible name describing the action
    expect(src).toMatch(/<button[\s\S]*?aria-label=/);
    expect(src).toContain('生命线');
  });

  it('lifeline button has type="button"', () => {
    // Explicit type prevents accidental form submission
    expect(src).toMatch(/<button[\s\S]*?type="button"/);
  });
});
