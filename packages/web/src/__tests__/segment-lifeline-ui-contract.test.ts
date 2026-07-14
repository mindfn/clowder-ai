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
  const src = readComponent('LifelineStageDetail.tsx');

  it('KIND_LABEL covers all LifecycleEventKind values', () => {
    // Every kind in the shared type must have a user-facing label.
    // If a new kind is added to segment-lifecycle.ts but not here,
    // the UI falls back to raw enum — wrong UX (AF-5 root cause).
    const kinds = [
      'auto-iterate',
      'user-create',
      'version-activate',
      'user-edit',
      'eval-pass',
      'eval-reject',
      'governance-approve',
      'governance-reject',
    ];
    for (const kind of kinds) {
      expect(src).toContain(`'${kind}'`);
    }
  });

  it('governance-reject has Chinese label (not raw enum)', () => {
    expect(src).toMatch(/'governance-reject':\s*'[^']+'/);
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
