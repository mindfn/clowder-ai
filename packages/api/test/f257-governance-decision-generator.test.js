/** F257 content→v2: GovernanceDecision validation + skip-default contract. */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { AnthropicGovernanceDecisionGenerator, assertValidGovernanceDecision, SkipGovernanceDecisionGenerator } =
  await import('../dist/infrastructure/harness-eval/governance/GovernanceDecisionGenerator.js');

const INPUT = {
  segmentId: 'S13',
  objectiveId: 'obj-1',
  currentContent: 'current-v2-content',
  currentVersion: 2,
  verdict: 'retire-candidate',
  verdictDecision: {
    schemaVersion: 2,
    evaluationModelVersion: 'v1',
    metricDecisions: [],
    primaryMetricId: null,
    measurement: null,
    targetSegmentIds: ['S13'],
  },
  conclusion: 'tool schema failures remain above the rule',
  counterexampleAnchors: ['ann-1', 'ann-2'],
};

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
    const decision = await new SkipGovernanceDecisionGenerator().decide(INPUT);
    assert.equal(decision.action, 'skip');
    assert.equal(decision.contentDraft, undefined);
  });

  test('Anthropic adapter sends the current evaluation/context and returns a validated content draft', async () => {
    let requestBody;
    const generator = new AnthropicGovernanceDecisionGenerator({
      apiKey: 'test-key',
      baseUrl: 'https://anthropic.invalid',
      fetchFn: async (_url, init) => {
        requestBody = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  action: 'change-content',
                  contentDraft: { proposedContent: 'safer-v3-content', rationale: 'covers the counterexamples' },
                  rationale: 'the measured schema failures come from the current instruction',
                }),
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    const decision = await generator.decide(INPUT);
    assert.equal(decision.action, 'change-content');
    assert.equal(decision.contentDraft.proposedContent, 'safer-v3-content');
    const prompt = requestBody.messages[0].content;
    assert.match(prompt, /current-v2-content/);
    assert.match(prompt, /tool schema failures/);
    assert.match(prompt, /ann-1/);
  });

  test('Anthropic adapter fails closed on malformed or self-identical changes', async () => {
    const responseFor = (text) => async () =>
      new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await assert.rejects(
      new AnthropicGovernanceDecisionGenerator({ apiKey: 'x', fetchFn: responseFor('not-json') }).decide(INPUT),
      /governance_decision_response_invalid/,
    );
    await assert.rejects(
      new AnthropicGovernanceDecisionGenerator({
        apiKey: 'x',
        fetchFn: responseFor(
          JSON.stringify({
            action: 'change-content',
            contentDraft: { proposedContent: INPUT.currentContent, rationale: 'same' },
            rationale: 'same',
          }),
        ),
      }).decide(INPUT),
      /governance_decision_content_unchanged/,
    );
  });
});
