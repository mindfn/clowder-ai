import { beforeEach, describe, expect, it } from 'vitest';
import type { GuideStep } from '../guideStore';
import { useGuideStore } from '../guideStore';

const MOCK_STEPS: GuideStep[] = [
  { id: 's1', targetGuideId: 'hub.trigger', title: 'Step 1', instruction: 'Do X', expectedAction: 'click' },
  { id: 's2', targetGuideId: 'cats.overview', title: 'Step 2', instruction: 'Do Y', expectedAction: 'click' },
  { id: 's3', targetGuideId: 'cats.add-member', title: 'Step 3', instruction: 'Do Z', expectedAction: 'click', canSkip: false, timeoutSec: 30 },
];

describe('guideStore', () => {
  beforeEach(() => {
    useGuideStore.setState({ session: null });
  });

  it('starts a guide session with correct initial state', () => {
    useGuideStore.getState().startGuide('test-flow', MOCK_STEPS);
    const s = useGuideStore.getState().session!;
    expect(s).not.toBeNull();
    expect(s.guideId).toBe('test-flow');
    expect(s.currentStepIndex).toBe(0);
    expect(s.observationState).toBe('active');
    expect(s.stepStatus).toBe('locating_target');
    expect(s.steps).toHaveLength(3);
  });

  it('advances to next step', () => {
    useGuideStore.getState().startGuide('test-flow', MOCK_STEPS);
    useGuideStore.getState().nextStep();
    const s = useGuideStore.getState().session!;
    expect(s.currentStepIndex).toBe(1);
    expect(s.observationState).toBe('active');
    expect(s.stepStatus).toBe('locating_target');
  });

  it('goes back to previous step', () => {
    useGuideStore.getState().startGuide('test-flow', MOCK_STEPS);
    useGuideStore.getState().nextStep();
    useGuideStore.getState().prevStep();
    expect(useGuideStore.getState().session!.currentStepIndex).toBe(0);
  });

  it('prevStep does nothing at index 0', () => {
    useGuideStore.getState().startGuide('test-flow', MOCK_STEPS);
    useGuideStore.getState().prevStep();
    expect(useGuideStore.getState().session!.currentStepIndex).toBe(0);
  });

  it('skipStep advances like nextStep', () => {
    useGuideStore.getState().startGuide('test-flow', MOCK_STEPS);
    useGuideStore.getState().skipStep();
    expect(useGuideStore.getState().session!.currentStepIndex).toBe(1);
  });

  it('marks flow complete when advancing past last step', () => {
    useGuideStore.getState().startGuide('test-flow', MOCK_STEPS);
    useGuideStore.getState().nextStep(); // → 1
    useGuideStore.getState().nextStep(); // → 2
    useGuideStore.getState().nextStep(); // → 3 (past end)
    const s = useGuideStore.getState().session!;
    expect(s.currentStepIndex).toBe(3);
    expect(s.observationState).toBe('success');
    expect(s.stepStatus).toBe('passed');
  });

  it('exitGuide clears session', () => {
    useGuideStore.getState().startGuide('test-flow', MOCK_STEPS);
    useGuideStore.getState().exitGuide();
    expect(useGuideStore.getState().session).toBeNull();
  });

  it('setObservationState updates state', () => {
    useGuideStore.getState().startGuide('test-flow', MOCK_STEPS);
    useGuideStore.getState().setObservationState('error');
    expect(useGuideStore.getState().session!.observationState).toBe('error');
  });

  it('setStepStatus updates status', () => {
    useGuideStore.getState().startGuide('test-flow', MOCK_STEPS);
    useGuideStore.getState().setStepStatus('timed_out');
    expect(useGuideStore.getState().session!.stepStatus).toBe('timed_out');
  });

  it('completeCurrentStep sets passed + success', () => {
    useGuideStore.getState().startGuide('test-flow', MOCK_STEPS);
    useGuideStore.getState().completeCurrentStep();
    const s = useGuideStore.getState().session!;
    expect(s.stepStatus).toBe('passed');
    expect(s.observationState).toBe('success');
  });

  it('preserves canSkip and timeoutSec on steps', () => {
    useGuideStore.getState().startGuide('test-flow', MOCK_STEPS);
    const s = useGuideStore.getState().session!;
    expect(s.steps[0].canSkip).toBeUndefined();
    expect(s.steps[2].canSkip).toBe(false);
    expect(s.steps[2].timeoutSec).toBe(30);
  });

  it('generates unique session IDs', () => {
    useGuideStore.getState().startGuide('a', MOCK_STEPS);
    const id1 = useGuideStore.getState().session!.sessionId;
    useGuideStore.getState().startGuide('b', MOCK_STEPS);
    const id2 = useGuideStore.getState().session!.sessionId;
    expect(id1).not.toBe(id2);
  });
});
