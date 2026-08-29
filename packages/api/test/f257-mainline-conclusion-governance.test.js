import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// State-machine acceptance test for the F257 mainline:
// tracing -> (trigger) -> eval -> conclusion(verdict) -> governance.
// Pt.1 here proves the CONCLUSION->GOVERNANCE transition that was severed by the
// objective-driven redesign: buildObjectiveJudgment now rolls a verdict, the
// lifeline maps it into the version chain, and deriveActiveStage advances the
// unit to governance. The regression guard pins the old bug (no conclusion ->
// forever tracing) so it can never silently come back.

const { buildVersionChain, deriveActiveStage, objectiveJudgmentToCachedJudgment } = await import(
  '../dist/routes/segment-lifeline-chain.js'
);

/** Minimal well-formed ObjectiveJudgment with a rolled-up verdict. */
function objectiveJudgment(verdict, counterValue = { kind: 'counter', count: 0, threshold: 3 }) {
  return {
    judgmentId: `judgment-${verdict}`,
    snapshotId: 'snapshot-1',
    ownerUserId: 'owner-1',
    objectiveId: 'obj-routing',
    evaluationModelId: 'em-routing',
    evaluationModelVersion: 'v1',
    unitRefs: [{ unitType: 'segment', unitId: 'S13' }],
    window: { start: 0, end: 1000 },
    metricResults: [
      {
        resultId: 'result-1',
        snapshotId: 'snapshot-1',
        ownerUserId: 'owner-1',
        objectiveId: 'obj-routing',
        metricId: 'm1',
        kind: 'counter',
        value: counterValue,
        evaluatedAt: 900,
      },
    ],
    metricOutcomes: [{ metricId: 'm1', status: 'evaluated' }],
    annotationIds: [],
    completion: 'complete',
    verdict,
    evaluatedAt: 900,
  };
}

const observations = [{ timestamp: 500, version: 1, fired: true }];

describe('F257 mainline conclusion -> governance', () => {
  test('an `alive` conclusion maps into the lifeline chain and reaches governance', () => {
    const cached = objectiveJudgmentToCachedJudgment(objectiveJudgment('alive'), 'S13');
    assert.equal(cached.verdict, 'alive');

    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [],
      observations,
      currentContentVersion: null,
      judgmentHistory: [cached],
    });
    const active = chain.find((epoch) => epoch.isActive) ?? chain[chain.length - 1];
    assert.ok(active.eval, 'eval stage must be attached from the conclusion');
    assert.equal(active.eval.verdict, 'alive');
    assert.equal(deriveActiveStage(active), 'governance');
  });

  test('REGRESSION GUARD: without a conclusion the identical chain stalls at tracing (the old bug)', () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [],
      observations,
      currentContentVersion: null,
      judgmentHistory: [],
    });
    const active = chain.find((epoch) => epoch.isActive) ?? chain[chain.length - 1];
    assert.equal(active.eval ?? null, null);
    assert.equal(deriveActiveStage(active), 'tracing');
  });

  test('a breach `retire-candidate` conclusion carries violation evidence into the chain', () => {
    const cached = objectiveJudgmentToCachedJudgment(
      objectiveJudgment('retire-candidate', { kind: 'counter', count: 3, threshold: 3 }),
      'S13',
    );
    assert.equal(cached.verdict, 'retire-candidate');
    assert.equal(cached.violationCount, 3);
  });
});
