/**
 * F150: Guide Engine Store
 *
 * Zustand store managing guide session state.
 * Phase A: internal flows only (add-member).
 */
import { create } from 'zustand';

/* ── Types ── */

export type GuideObservationState = 'idle' | 'active' | 'success' | 'error' | 'verifying';

export type GuideStepStatus =
  | 'locating_target'
  | 'awaiting_user'
  | 'passed'
  | 'failed'
  | 'timed_out'
  | 'skipped';

export interface GuideStep {
  id: string;
  /** data-guide-id of the target element. Optional for `information` type steps. */
  targetGuideId?: string;
  title: string;
  instruction: string;
  expectedAction: 'click' | 'visible' | 'select' | 'input' | 'confirm';
  canSkip?: boolean;
  timeoutSec?: number;
}

export interface GuideSession {
  guideId: string;
  sessionId: string;
  steps: GuideStep[];
  currentStepIndex: number;
  observationState: GuideObservationState;
  stepStatus: GuideStepStatus;
  startedAt: number;
}

interface GuideState {
  session: GuideSession | null;

  // Actions
  startGuide: (guideId: string, steps: GuideStep[]) => void;
  nextStep: () => void;
  prevStep: () => void;
  skipStep: () => void;
  exitGuide: () => void;
  setObservationState: (state: GuideObservationState) => void;
  setStepStatus: (status: GuideStepStatus) => void;
  completeCurrentStep: () => void;
}

let sessionCounter = 0;

export const useGuideStore = create<GuideState>((set, get) => ({
  session: null,

  startGuide: (guideId, steps) => {
    sessionCounter += 1;
    set({
      session: {
        guideId,
        sessionId: `guide-${guideId}-${sessionCounter}`,
        steps,
        currentStepIndex: 0,
        observationState: 'active',
        stepStatus: 'locating_target',
        startedAt: Date.now(),
      },
    });
  },

  nextStep: () => {
    const { session } = get();
    if (!session) return;
    const nextIndex = session.currentStepIndex + 1;
    if (nextIndex >= session.steps.length) {
      // Flow complete
      set({
        session: { ...session, observationState: 'success', stepStatus: 'passed', currentStepIndex: nextIndex },
      });
      return;
    }
    set({
      session: {
        ...session,
        currentStepIndex: nextIndex,
        observationState: 'active',
        stepStatus: 'locating_target',
      },
    });
  },

  prevStep: () => {
    const { session } = get();
    if (!session || session.currentStepIndex <= 0) return;
    set({
      session: {
        ...session,
        currentStepIndex: session.currentStepIndex - 1,
        observationState: 'active',
        stepStatus: 'locating_target',
      },
    });
  },

  skipStep: () => {
    const { session } = get();
    if (!session) return;
    const nextIndex = session.currentStepIndex + 1;
    if (nextIndex >= session.steps.length) {
      set({
        session: { ...session, observationState: 'success', stepStatus: 'passed', currentStepIndex: nextIndex },
      });
      return;
    }
    set({
      session: {
        ...session,
        currentStepIndex: nextIndex,
        observationState: 'active',
        stepStatus: 'locating_target',
      },
    });
  },

  exitGuide: () => set({ session: null }),

  setObservationState: (observationState) => {
    const { session } = get();
    if (!session) return;
    set({ session: { ...session, observationState } });
  },

  setStepStatus: (stepStatus) => {
    const { session } = get();
    if (!session) return;
    set({ session: { ...session, stepStatus } });
  },

  completeCurrentStep: () => {
    const { session } = get();
    if (!session) return;
    set({ session: { ...session, stepStatus: 'passed', observationState: 'success' } });
  },
}));
