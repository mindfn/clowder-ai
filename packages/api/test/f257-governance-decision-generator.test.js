/** F257 content→v2: GovernanceDecision validation + skip-default contract. */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { assertValidGovernanceDecision, SkipGovernanceDecisionGenerator } = await import(
  '../dist/infrastructure/harness-eval/governance/GovernanceDecisionGenerator.js'
);

describe('F257 GovernanceDecision contract', () => {
  test('change-content requires non-empty proposed content', () => {
    assert.throws(
      () => assertValidGovernanceDecision({ action: 'change-content', rationale: 'x' }),
      /nonempty_proposed_content/,
    );
    assert.throws(
      () =>
        assertValidGovernanceDecision({
          action: 'change-content',
          contentDraft: { proposedContent: '   ', rationale: 'r' },
          rationale: 'x',
        }),
      /nonempty_proposed_content/,
    );
  });

  test('change-content requires a draft rationale', () => {
    assert.throws(
      () =>
        assertValidGovernanceDecision({
          action: 'change-content',
          contentDraft: { proposedContent: 'new', rationale: '' },
          rationale: 'x',
        }),
      /draft_rationale/,
    );
  });

  test('rollback requires a prior version ordinal >= 1', () => {
    assert.throws(() => assertValidGovernanceDecision({ action: 'rollback', rationale: 'x' }), /prior_version_ordinal/);
    assert.throws(
      () => assertValidGovernanceDecision({ action: 'rollback', rollbackToVersion: 0, rationale: 'x' }),
      /prior_version_ordinal/,
    );
  });

  test('every decision requires a rationale', () => {
    assert.throws(() => assertValidGovernanceDecision({ action: 'skip', rationale: '' }), /requires_rationale/);
  });

  test('valid decisions pass through', () => {
    assert.equal(
      assertValidGovernanceDecision({
        action: 'change-content',
        contentDraft: { proposedContent: 'new content', rationale: 'why' },
        rationale: 'x',
      }).action,
      'change-content',
    );
    assert.equal(
      assertValidGovernanceDecision({ action: 'rollback', rollbackToVersion: 1, rationale: 'x' }).action,
      'rollback',
    );
    assert.equal(assertValidGovernanceDecision({ action: 'skip', rationale: 'x' }).action, 'skip');
  });

  test('unwired generator defaults to skip, never fabricates a change', async () => {
    const decision = await new SkipGovernanceDecisionGenerator().decide({
      segmentId: 'S13',
      objectiveId: 'obj-1',
      currentContent: 'x',
      currentVersion: 1,
      verdict: 'retire-candidate',
      verdictDecision: {},
      conclusion: 'c',
      counterexampleAnchors: [],
    });
    assert.equal(decision.action, 'skip');
    assert.equal(decision.contentDraft, undefined);
  });
});
