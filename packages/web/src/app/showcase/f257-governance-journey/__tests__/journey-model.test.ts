import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_ID,
  DEFAULT_REJECTION_REASON,
  type JourneyScenario,
  type JourneyScene,
  journeyFor,
} from '../journey-model';

function scene(scenario: JourneyScenario, id: JourneyScene['id']): JourneyScene {
  const found = journeyFor(scenario).find((entry) => entry.id === id);
  if (!found) throw new Error(`missing ${scenario} scene ${id}`);
  return found;
}

describe('F257 conclusion → governance journey contract', () => {
  it.each(['happy', 'recovery'] as const)('keeps one Candidate identity across the %s journey', (scenario) => {
    const candidateScenes = journeyFor(scenario).filter((entry) => entry.candidate !== null);
    expect(candidateScenes.length).toBeGreaterThan(0);
    expect(new Set(candidateScenes.map((entry) => entry.candidate?.candidateId))).toEqual(new Set([CANDIDATE_ID]));
  });

  it('follows the canonical happy-path handoffs in order', () => {
    expect(journeyFor('happy').map((entry) => entry.event)).toEqual([
      'TraceAnnotationCommitted',
      'ObjectiveJudgmentCommitted',
      'GovernanceCandidateOpened',
      'CandidateDecisionApproved',
      'OverrideApplied',
      'PatchTrialEvaluated',
      'PatchTrialClosed',
      'TraceAnnotationCommitted',
    ]);
  });

  it('makes the evaluation metric, rule, window, source and conclusion explicit', () => {
    const judgment = scene('happy', 'judgment-committed');
    expect(judgment.evaluationEvidence).toMatchObject({
      snapshotId: 'snapshot-s13-schema-failure',
      sourceKind: 'InjectionTrace summary',
      sourceRefs: ['turn_schema_failure_1', 'turn_schema_failure_2', 'turn_schema_failure_3'],
      window: { start: expect.any(Number), end: expect.any(Number) },
      verdict: 'retire-candidate',
      metrics: [
        {
          metricId: 'tool-schema-failure-count',
          rule: 'counter-zero',
          measurement: 'count = 3',
          decision: 'breach',
        },
      ],
    });
  });

  it('makes Candidate creation automatic and keeps the click at the operator approval boundary', () => {
    const judgment = scene('happy', 'judgment-committed');
    const candidate = scene('happy', 'candidate-opened');
    expect(judgment.transitionOwner).toBe('evaluation-runtime');
    expect(candidate.transitionOwner).toBe('governance-worker');
    expect(candidate.candidate).toMatchObject({ status: 'proposed', decisionMode: 'approve-reject' });
    expect(candidate.operatorActionRequired).toBe('approve-or-reject');
  });

  it('fails visibly and resumes the same executing Candidate without asking for approval twice', () => {
    const interrupted = scene('recovery', 'override-interrupted');
    expect(interrupted.candidate).toMatchObject({ status: 'executing', decisionMode: 'resume-only' });
    expect(interrupted.override).toMatchObject({ attempts: 1, successfulWrites: 0 });
    expect(interrupted.patchTrial).toBeNull();
    expect(interrupted.actionableCandidateCount).toBe(1);

    const recovered = scene('recovery', 'override-applied');
    expect(recovered.candidate).toMatchObject({ status: 'approved', decisionMode: 'none', operatorDecisionCount: 1 });
    expect(recovered.override).toMatchObject({ attempts: 2, successfulWrites: 1 });
    expect(recovered.patchTrial).toMatchObject({ trialCount: 1, outcome: 'pending' });
  });

  it('does not call traffic growth an improvement when the immutable trace hash is unchanged', () => {
    const firstTreatment = scene('happy', 'treatment-inconclusive');
    expect(firstTreatment.patchTrial).toMatchObject({ outcome: 'inconclusive', decision: 'pending' });
    expect(firstTreatment.patchTrial?.beforeHash).toBe(firstTreatment.patchTrial?.afterHash);
    expect(firstTreatment.candidate?.status).toBe('approved');
  });

  it('reaches a decidable terminal state only after measured treatment changes', () => {
    const terminal = scene('happy', 'trial-closed');
    expect(terminal.candidate?.status).toBe('closed');
    expect(terminal.patchTrial).toMatchObject({ outcome: 'improved', decision: 'solidify', measurement: 0 });
    expect(terminal.patchTrial?.afterHash).not.toBe(terminal.patchTrial?.beforeHash);
    expect(terminal.actionableCandidateCount).toBe(0);
    expect(terminal.terminal).toBe(true);
  });

  it('persists a rejection reason, creates no intervention, and returns to a new tracing window', () => {
    const rejectedJourney = journeyFor('rejected', DEFAULT_REJECTION_REASON);
    expect(rejectedJourney.map((entry) => entry.event)).toEqual([
      'TraceAnnotationCommitted',
      'ObjectiveJudgmentCommitted',
      'GovernanceCandidateOpened',
      'CandidateDecisionRejected',
      'TraceAnnotationCommitted',
    ]);

    const rejected = scene('rejected', 'operator-rejected');
    expect(rejected.candidate).toMatchObject({
      status: 'rejected',
      operatorDecisionCount: 1,
      decisionNote: DEFAULT_REJECTION_REASON,
    });
    expect(rejected.override).toBeNull();
    expect(rejected.patchTrial).toBeNull();

    const nextRound = scene('rejected', 'next-round-tracing');
    expect(nextRound).toMatchObject({
      round: 2,
      activeStage: 'tracing',
      nextEvaluationContext: {
        rejectionNote: DEFAULT_REJECTION_REASON,
        persistence: 'candidate-approval-note',
        evaluatorBridge: 'prototype-only',
      },
    });
    expect(nextRound.actionableCandidateCount).toBe(0);
  });

  it.each([
    'happy',
    'recovery',
    'rejected',
  ] as const)('makes the %s decision visibly loop back to tracing', (scenario) => {
    const journey = journeyFor(scenario);
    const nextRound = journey.at(-1);
    expect(nextRound).toMatchObject({
      id: 'next-round-tracing',
      event: 'TraceAnnotationCommitted',
      activeStage: 'tracing',
      selectedStage: 'tracing',
      round: 2,
      terminal: true,
    });
  });
});
