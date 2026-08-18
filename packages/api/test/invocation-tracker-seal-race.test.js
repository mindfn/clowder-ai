import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');

describe('InvocationTracker manual-session-seal fence', () => {
  it('waits for a single stopped invocation to finish teardown before sealing', () => {
    const tracker = new InvocationTracker();
    const controller = tracker.start('thread-1', 'opus', 'user-1', ['opus']);

    tracker.cancel('thread-1', 'opus', 'user-1', 'user_cancel');
    assert.equal(tracker.has('thread-1', 'opus'), false, 'cancelled tombstones must not occupy a live slot');
    assert.equal(tracker.guardSessionSeal('thread-1', 'opus').acquired, false);

    tracker.complete('thread-1', 'opus', controller);
    const seal = tracker.guardSessionSeal('thread-1', 'opus');
    assert.equal(seal.acquired, true);
    seal.release();
  });

  it('keeps every whole-thread stop tombstone fenced until batch teardown completes', () => {
    const tracker = new InvocationTracker();
    const batch = tracker.startAll('thread-1', ['opus', 'codex'], 'user-1');

    tracker.cancelAll('thread-1', 'user-1', 'cancel_all');
    assert.equal(tracker.has('thread-1'), false);
    assert.equal(tracker.guardSessionSeal('thread-1', 'opus').acquired, false);
    assert.equal(tracker.guardSessionSeal('thread-1', 'codex').acquired, false);

    tracker.completeAll('thread-1', ['opus', 'codex'], batch);
    const opusSeal = tracker.guardSessionSeal('thread-1', 'opus');
    const codexSeal = tracker.guardSessionSeal('thread-1', 'codex');
    assert.equal(opusSeal.acquired, true);
    assert.equal(codexSeal.acquired, true);
    opusSeal.release();
    codexSeal.release();
  });

  it('fences a scoped batch preempt until its terminal cleanup completes', () => {
    const tracker = new InvocationTracker();
    const batch = tracker.startAll('thread-1', ['opus', 'codex'], 'user-1', 'inv-preempted');

    assert.deepEqual(tracker.cancelInvocation('thread-1', ['opus'], 'user-1', 'preempted').sort(), ['codex', 'opus']);
    assert.equal(
      tracker.classifyExecutionId('thread-1', 'codex', 'inv-preempted'),
      'absent',
      'a preempted sibling must not remain the current execution owner',
    );
    assert.equal(tracker.guardSessionSeal('thread-1', 'opus').acquired, false);
    assert.equal(tracker.guardSessionSeal('thread-1', 'codex').acquired, false);

    tracker.completeAll('thread-1', ['opus', 'codex'], batch);
    const seal = tracker.guardSessionSeal('thread-1', 'opus');
    assert.equal(seal.acquired, true);
    seal.release();
  });

  it('does not admit a replacement invocation while a session seal owns the slot', () => {
    const tracker = new InvocationTracker();
    const seal = tracker.guardSessionSeal('thread-1', 'opus');
    assert.equal(seal.acquired, true);

    const blocked = tracker.start('thread-1', 'opus', 'user-1', ['opus']);
    assert.equal(blocked.signal.aborted, true);
    assert.equal(tracker.trackExternalSlot('thread-1', 'opus', new AbortController(), 'user-1'), false);

    seal.release();
    const admitted = tracker.start('thread-1', 'opus', 'user-1', ['opus']);
    assert.equal(admitted.signal.aborted, false);
  });
});
