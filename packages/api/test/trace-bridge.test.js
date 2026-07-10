/**
 * F257 Phase A Line B — Trace Persistence Bridge tests
 *
 * Verifies pipeline PipelineResult → v0 InjectionTraceSummary/Detail conversion.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { buildFromPipeline } = await import('../dist/domains/prompt-hooks/trace-bridge.js');

// ── Test data factories ──

/** Build a minimal PipelineResult with fired events */
function makePipelineResult(hooks = []) {
  const events = hooks.map((h) => ({
    hookId: h.id,
    status: h.status ?? 'fired',
    contentHash: h.hash ?? `hash-${h.id}`,
    tokenEstimate: h.tokens ?? 100,
  }));
  const patches = hooks
    .filter((h) => (h.status ?? 'fired') === 'fired')
    .map((h) => ({
      hookId: h.id,
      content: h.content ?? `content-for-${h.id}`,
      position: 'prepend',
    }));
  return { events, patches };
}

const META = {
  turnId: 'turn-001',
  threadId: 'thread-abc',
  catId: 'opus-47',
  hasNativeL0: false,
};

describe('trace-bridge buildFromPipeline', () => {
  test('returns null when both session and turn are null', () => {
    const result = buildFromPipeline(null, null, META);
    assert.equal(result, null);
  });

  test('builds summary + detail from session-only pipeline result', () => {
    const session = makePipelineResult([
      { id: 'hook-a', tokens: 50, content: 'hello' },
      { id: 'hook-b', tokens: 30, content: 'world' },
    ]);
    const result = buildFromPipeline(session, null, META);

    assert.ok(result, 'result should not be null');
    const { summary, detail } = result;

    // Summary checks
    assert.equal(summary.turnId, 'turn-001');
    assert.equal(summary.threadId, 'thread-abc');
    assert.equal(summary.catId, 'opus-47');
    assert.equal(summary.segments.length, 2);
    assert.equal(summary.totalSegmentsObserved, 2);
    assert.equal(summary.totalSegmentsAbsent, 0);
    assert.equal(summary.totalTokenEstimate, 80);
    assert.equal(summary.totalCharCount, 10); // 'hello' + 'world' = 5 + 5

    // Detail checks
    assert.equal(detail.turnId, 'turn-001');
    assert.equal(detail.sessionTokenEstimate, 80);
    assert.equal(detail.turnTokenEstimate, 0);
    assert.equal(detail.sessionCharCount, 10);
    assert.equal(detail.turnCharCount, 0);
  });

  test('builds from turn-only pipeline result', () => {
    const turn = makePipelineResult([{ id: 'turn-hook', tokens: 200, content: 'turn-content' }]);
    const result = buildFromPipeline(null, turn, META);

    assert.ok(result);
    const { summary, detail } = result;

    assert.equal(summary.segments.length, 1);
    assert.equal(summary.totalTokenEstimate, 200);
    assert.equal(detail.sessionTokenEstimate, 0);
    assert.equal(detail.turnTokenEstimate, 200);
    assert.equal(detail.turnCharCount, 12); // 'turn-content'.length
  });

  test('builds from both session + turn pipeline results', () => {
    const session = makePipelineResult([{ id: 'session-h', tokens: 100, content: 'sess' }]);
    const turn = makePipelineResult([{ id: 'turn-h', tokens: 50, content: 'trn' }]);
    const result = buildFromPipeline(session, turn, META);

    assert.ok(result);
    const { summary, detail } = result;

    assert.equal(summary.segments.length, 2);
    assert.equal(summary.totalTokenEstimate, 150);
    assert.equal(summary.totalCharCount, 7); // 'sess' + 'trn'
    assert.equal(detail.sessionTokenEstimate, 100);
    assert.equal(detail.turnTokenEstimate, 50);
  });

  test('skipped hooks produce absent segments', () => {
    const session = makePipelineResult([
      { id: 'active', status: 'fired', tokens: 100, content: 'active-content' },
      { id: 'skipped', status: 'skipped', tokens: 0 },
      { id: 'disabled', status: 'disabled', tokens: 0 },
    ]);
    const result = buildFromPipeline(session, null, META);

    assert.ok(result);
    const { summary } = result;

    assert.equal(summary.totalSegmentsObserved, 1);
    assert.equal(summary.totalSegmentsAbsent, 2);

    const observed = summary.segments.filter((s) => s.status === 'observed');
    const absent = summary.segments.filter((s) => s.status === 'absent');
    assert.equal(observed.length, 1);
    assert.equal(observed[0].segmentId, 'active');
    assert.equal(absent.length, 2);
  });

  test('session segments have stage session-init, turn segments have per-turn', () => {
    const session = makePipelineResult([{ id: 'sh', tokens: 10, content: 'x' }]);
    const turn = makePipelineResult([{ id: 'th', tokens: 10, content: 'y' }]);
    const result = buildFromPipeline(session, turn, META);

    assert.ok(result);
    const sessionSeg = result.summary.segments.find((s) => s.segmentId === 'sh');
    const turnSeg = result.summary.segments.find((s) => s.segmentId === 'th');
    assert.equal(sessionSeg.stage, 'session-init');
    assert.equal(turnSeg.stage, 'per-turn');
  });

  test('delivery decisions reflect hasNativeL0 flag', () => {
    const session = makePipelineResult([{ id: 'h', tokens: 10, content: 'x' }]);

    // Without native L0
    const result1 = buildFromPipeline(session, null, { ...META, hasNativeL0: false });
    assert.ok(result1);
    const sessionDelivery1 = result1.summary.delivery.find((d) => d.stage === 'session-init');
    assert.equal(sessionDelivery1.channel, 'message-prepend');

    // With native L0
    const result2 = buildFromPipeline(session, null, { ...META, hasNativeL0: true });
    assert.ok(result2);
    const sessionDelivery2 = result2.summary.delivery.find((d) => d.stage === 'session-init');
    assert.equal(sessionDelivery2.channel, 'pack-only');
  });

  test('contentHash comes from first fired event', () => {
    const session = makePipelineResult([{ id: 'h1', status: 'fired', hash: 'abc123', tokens: 10, content: 'x' }]);
    const result = buildFromPipeline(session, null, META);

    assert.ok(result);
    assert.equal(result.detail.sessionContentHash, 'abc123');
    assert.equal(result.detail.turnContentHash, null);
  });

  test('optional sessionId is included when provided', () => {
    const session = makePipelineResult([{ id: 'h', tokens: 10, content: 'x' }]);
    const metaWithSession = { ...META, sessionId: 'sess-42' };
    const result = buildFromPipeline(session, null, metaWithSession);

    assert.ok(result);
    assert.equal(result.summary.sessionId, 'sess-42');
  });
});
