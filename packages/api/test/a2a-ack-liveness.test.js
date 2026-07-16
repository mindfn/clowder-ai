// @ts-check

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateAckLiveness } from '../dist/domains/cats/services/agents/routing/a2a-ack-liveness.js';

/**
 * F257 LI-005 — A2A Ack Liveness Detection unit tests.
 *
 * Red-first TDD: each test targets a specific detection scenario from the
 * LI-005 candidate definition (live-candidates-2026-07-14.md).
 */

/** Helper: build default input with overrides. */
function input(overrides = {}) {
  return {
    isA2AInvocation: true,
    toolNames: [],
    lineStartMentions: [],
    structuredTargetCats: [],
    hasCoCreatorLineStartMention: false,
    ...overrides,
  };
}

describe('evaluateAckLiveness', () => {
  // ── Core detection: void ack ────────────────────────────────────────────

  it('fires when A2A invocation ends without routing exit or durable trigger', () => {
    const result = evaluateAckLiveness(input());
    assert.equal(result.shouldEmit, true, 'should fire on bare A2A ack');
    assert.equal(result.hasRoutingExit, false);
    assert.equal(result.hasDurableTrigger, false);
  });

  // ── Suppression: non-A2A ────────────────────────────────────────────────

  it('never fires for user-initiated invocations', () => {
    const result = evaluateAckLiveness(input({ isA2AInvocation: false }));
    assert.equal(result.shouldEmit, false, 'user-initiated should not fire');
  });

  // ── Suppression: routing exits ──────────────────────────────────────────

  it('suppressed by line-start @mention (ball passed forward)', () => {
    const result = evaluateAckLiveness(input({ lineStartMentions: ['codex'] }));
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasRoutingExit, true);
  });

  it('suppressed by structured targetCats (post_message routing)', () => {
    const result = evaluateAckLiveness(input({ structuredTargetCats: ['opus'] }));
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasRoutingExit, true);
  });

  it('suppressed by @co-creator line-start mention', () => {
    const result = evaluateAckLiveness(input({ hasCoCreatorLineStartMention: true }));
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasRoutingExit, true);
  });

  // ── Suppression: durable triggers ───────────────────────────────────────

  it('suppressed by hold_ball tool call', () => {
    const result = evaluateAckLiveness(input({ toolNames: ['mcp__cat-cafe-collab__cat_cafe_hold_ball'] }));
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasDurableTrigger, true);
  });

  it('suppressed by create_task tool call', () => {
    const result = evaluateAckLiveness(input({ toolNames: ['cat_cafe_create_task'] }));
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasDurableTrigger, true);
  });

  it('suppressed by register_scheduled_task tool call', () => {
    const result = evaluateAckLiveness(
      input({ toolNames: ['mcp__cat-cafe-collab__cat_cafe_register_scheduled_task'] }),
    );
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasDurableTrigger, true);
  });

  it('suppressed by register_pr_tracking tool call', () => {
    const result = evaluateAckLiveness(input({ toolNames: ['cat_cafe_register_pr_tracking'] }));
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasDurableTrigger, true);
  });

  it('suppressed by register_issue_tracking tool call', () => {
    const result = evaluateAckLiveness(input({ toolNames: ['cat_cafe_register_issue_tracking'] }));
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasDurableTrigger, true);
  });

  it('suppressed by community_await_external tool call', () => {
    const result = evaluateAckLiveness(input({ toolNames: ['cat_cafe_community_await_external'] }));
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasDurableTrigger, true);
  });

  // ── Non-trigger tools do NOT suppress ───────────────────────────────────

  it('non-trigger tools (search_evidence, post_message) do not suppress', () => {
    const result = evaluateAckLiveness(
      input({
        toolNames: ['cat_cafe_search_evidence', 'cat_cafe_post_message', 'Read', 'Bash'],
      }),
    );
    assert.equal(result.shouldEmit, true, 'informational tools should not suppress');
    assert.equal(result.hasDurableTrigger, false);
  });

  // ── Combination: routing exit + no trigger still suppresses ─────────────

  it('routing exit alone suppresses even without durable trigger', () => {
    const result = evaluateAckLiveness(input({ lineStartMentions: ['sol'] }));
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasRoutingExit, true);
    assert.equal(result.hasDurableTrigger, false);
  });

  // ── Combination: trigger alone suppresses even without routing exit ─────

  it('durable trigger alone suppresses even without routing exit', () => {
    const result = evaluateAckLiveness(input({ toolNames: ['cat_cafe_hold_ball'] }));
    assert.equal(result.shouldEmit, false);
    assert.equal(result.hasRoutingExit, false);
    assert.equal(result.hasDurableTrigger, true);
  });
});
