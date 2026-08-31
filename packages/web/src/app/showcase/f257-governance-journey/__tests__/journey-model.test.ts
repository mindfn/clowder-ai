import { describe, expect, it } from 'vitest';
import { CANDIDATE_ID, type JourneyScenario, type JourneyScene, journeyFor } from '../journey-model';

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
    ]);
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
});
