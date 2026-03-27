import { beforeEach, describe, expect, it } from 'vitest';
import { computeShieldPanels } from '../GuideOverlay';
import { useGuideStore } from '@/stores/guideStore';
import type { GuideStep } from '@/stores/guideStore';

/* ── computeShieldPanels geometry tests ── */

describe('computeShieldPanels', () => {
  const pad = 8;

  it('creates four panels around a centered target', () => {
    const rect = { top: 100, bottom: 150, left: 200, right: 350, width: 150, height: 50 };
    const p = computeShieldPanels(rect, pad);

    // Top panel: covers y=0 → y=92
    expect(p.top.height).toBe(92);
    // Bottom panel: starts at y=158
    expect(p.bottom.top).toBe(158);
    // Left panel: at y=92, covers x=0 → x=192, height=66
    expect(p.left).toEqual({ top: 92, width: 192, height: 66 });
    // Right panel: at y=92, starts x=358, height=66
    expect(p.right).toEqual({ top: 92, left: 358, height: 66 });
  });

  it('clamps to zero when target is at top-left corner', () => {
    const rect = { top: 0, bottom: 40, left: 0, right: 120, width: 120, height: 40 };
    const p = computeShieldPanels(rect, pad);

    expect(p.top.height).toBe(0);
    expect(p.left.width).toBe(0);
    expect(p.bottom.top).toBe(48);
    expect(p.right.left).toBe(128);
  });

  it('handles target close to edge (pad exceeds distance)', () => {
    const rect = { top: 3, bottom: 53, left: 5, right: 105, width: 100, height: 50 };
    const p = computeShieldPanels(rect, pad);

    // top: max(0, 3-8) = 0
    expect(p.top.height).toBe(0);
    // left: max(0, 5-8) = 0
    expect(p.left.width).toBe(0);
  });

  it('four panels leave exactly the target+pad hole', () => {
    const rect = { top: 200, bottom: 260, left: 300, right: 500, width: 200, height: 60 };
    const p = computeShieldPanels(rect, pad);

    // The hole is from (left.width, top.height) to (right.left, bottom.top)
    const holeLeft = p.left.width;   // 300 - 8 = 292
    const holeRight = p.right.left;  // 500 + 8 = 508
    const holeTop = p.top.height;    // 200 - 8 = 192
    const holeBottom = p.bottom.top; // 260 + 8 = 268

    expect(holeRight - holeLeft).toBe(rect.width + pad * 2);
    expect(holeBottom - holeTop).toBe(rect.height + pad * 2);
  });
});

/* ── Timeout state machine scenario tests ── */

const MOCK_STEPS: GuideStep[] = [
  { id: 's1', targetGuideId: 'hub.trigger', title: 'Step 1', instruction: 'Click', expectedAction: 'click', timeoutSec: 30 },
  { id: 's2', targetGuideId: 'cats.overview', title: 'Step 2', instruction: 'Navigate', expectedAction: 'click' },
];

describe('Guide timeout state transitions', () => {
  beforeEach(() => {
    useGuideStore.setState({ session: null });
  });

  it('full timeout scenario: active → awaiting_user → timed_out + error', () => {
    const store = useGuideStore.getState();
    store.startGuide('timeout-test', MOCK_STEPS);

    // Simulate: target found, step transitions to awaiting_user
    store.setObservationState('active');
    store.setStepStatus('awaiting_user');
    expect(useGuideStore.getState().session!.stepStatus).toBe('awaiting_user');
    expect(useGuideStore.getState().session!.observationState).toBe('active');

    // Simulate: timeout fires (component setTimeout → store actions)
    store.setStepStatus('timed_out');
    store.setObservationState('error');
    const s = useGuideStore.getState().session!;
    expect(s.stepStatus).toBe('timed_out');
    expect(s.observationState).toBe('error');
  });

  it('timeout resets when advancing to next step', () => {
    const store = useGuideStore.getState();
    store.startGuide('timeout-test', MOCK_STEPS);
    store.setStepStatus('timed_out');
    store.setObservationState('error');

    // Advance: nextStep resets to locating_target + active
    store.nextStep();
    const s = useGuideStore.getState().session!;
    expect(s.currentStepIndex).toBe(1);
    expect(s.stepStatus).toBe('locating_target');
    expect(s.observationState).toBe('active');
  });

  it('timeout does not affect session after exitGuide', () => {
    const store = useGuideStore.getState();
    store.startGuide('timeout-test', MOCK_STEPS);
    store.exitGuide();

    // Simulate: late timeout fire — should be no-op (session null)
    store.setStepStatus('timed_out');
    store.setObservationState('error');
    expect(useGuideStore.getState().session).toBeNull();
  });

  it('preserves per-step timeoutSec in step data', () => {
    useGuideStore.getState().startGuide('timeout-test', MOCK_STEPS);
    const s = useGuideStore.getState().session!;
    expect(s.steps[0].timeoutSec).toBe(30);
    expect(s.steps[1].timeoutSec).toBeUndefined();
  });
});
