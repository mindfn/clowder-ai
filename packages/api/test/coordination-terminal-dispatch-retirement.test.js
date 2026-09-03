import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createCatId } from '@cat-cafe/shared';
import { buildHandedEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import { TurnCustodyProjectionService } from '../dist/domains/ball-custody/TurnCustodyProjectionService.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  createA2ADispositionAuth as auth,
  createA2ADispositionWake as dispatchWake,
  createA2ADispositionHarness as harness,
} from './helpers/a2a-dispatch-disposition-harness.js';

const COORDINATION_ID = 'coord-terminal-retirement';

function bindActiveCoordination(h) {
  h.source.extra = {
    crossPost: {
      sourceThreadId: 'thread-origin',
      sourceInvocationId: 'origin-invocation',
    },
    coordination: {
      id: COORDINATION_ID,
      phase: 'active',
      hop: 1,
      subjectRef: 'task:terminal-retirement',
    },
    targetCats: ['codex-sol'],
  };
}

function appendTerminal(h, overrides = {}) {
  return h.messageStore.append({
    userId: 'user-1',
    from: { kind: 'agent', catId: createCatId('codex-sol') },
    content: '@fable5 terminal result',
    mentions: [createCatId('fable5')],
    timestamp: 1_750,
    threadId: 'thread-origin',
    origin: 'callback',
    deliveryStatus: 'queued',
    extra: {
      crossPost: {
        sourceThreadId: 'thread-1',
        sourceInvocationId: 'inv-1',
      },
      coordination: {
        id: COORDINATION_ID,
        phase: 'terminal',
        hop: 2,
        subjectRef: 'task:terminal-retirement',
      },
      causal: {
        kind: 'invocation_reply',
        triggerMessageId: h.source.id,
      },
      stream: {
        invocationId: 'inv-1',
        turnInvocationId: 'inv-1',
      },
      targetCats: ['fable5'],
      ...overrides,
    },
  });
}

describe('coordination terminal → ordinary A2A dispatch retirement', () => {
  test('one consumed terminal retires the exact dispatch fence and both completion paths replay', async () => {
    const h = await harness();
    bindActiveCoordination(h);
    const gate = new TurnCustodyProjectionService({
      ballCustodyProjectionStore: h.projectionStore,
      ballCustodyEventLog: h.eventLog,
    });
    const opened = await gate.open(dispatchWake(h));
    const terminal = appendTerminal(h);
    const queue = new InvocationQueue();
    const enqueued = await queue.enqueueExistingMessageDurable(h.messageStore, terminal.id, {
      threadId: terminal.threadId,
      userId: terminal.userId,
      ownerAuthProvenance: 'unknown',
      sourceId: terminal.id,
      messageId: terminal.id,
      kind: 'message_wake',
      from: terminal.from,
      content: terminal.content,
      sourceCategory: 'a2a',
      targetCats: ['fable5'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'codex-sol',
      a2aParentInvocationId: 'inv-1',
      a2aTriggerMessageId: terminal.id,
    });
    assert.equal(enqueued.outcome, 'enqueued');
    const queued = queue.getEntrySnapshot(terminal.threadId, terminal.userId, enqueued.entry.id);
    const seenAt = queued.enqueuedAt + 10;
    assert.ok(await queue.markProcessingByIdDurable(terminal.threadId, queued.id, 'fable5'));
    assert.equal(await queue.commitClaimedProcessing(terminal.threadId, [queued.id], seenAt - 2), true);
    assert.equal(
      await queue.markProcessingAwakenedDurable(
        terminal.threadId,
        terminal.userId,
        queued.id,
        'fable5',
        'terminal-child',
        seenAt - 1,
      ),
      true,
    );
    await queue.markProcessingSeenDurable(
      terminal.threadId,
      terminal.userId,
      queued.id,
      'fable5',
      'terminal-child',
      seenAt,
    );
    const processing = queue.getEntrySnapshot(terminal.threadId, terminal.userId, queued.id);

    assert.equal((await gate.close(opened)).shouldBlock, true);
    assert.equal((await h.service.completeFromCoordinationTerminal(terminal.id)).outcome, 'applied');
    assert.ok(
      await queue.removeProcessedAcrossUsersDurable(
        terminal.threadId,
        processing.id,
        'handled',
        undefined,
        seenAt + 20,
      ),
    );
    await h.messageStore.markDelivered(terminal.id, seenAt + 20);
    const settled = await queue.getDurableEntry(terminal.threadId, processing.id);
    assert.equal(settled.status, 'terminal');
    assert.equal(settled.delivery.terminalOutcome, 'handled');
    assert.equal(settled.delivery.awakenedInvocationId, 'terminal-child');
    assert.equal(settled.delivery.seenInvocationId, 'terminal-child');
    assert.equal(h.messageStore.getById(terminal.id).deliveryStatus, 'delivered');
    assert.deepEqual(await gate.close(opened), {
      state: 'covered_active',
      shouldBlock: false,
      transitionObserved: true,
      structuredTransitionKind: 'dispatch_dispositioned',
      dispatchDisposition: 'completed',
      dispatchDispositionEventId: `dispatch-disposition:inv-1:${h.source.id}`,
      dispatchDispositionAt: 2_000,
      evidenceRefs: [`dispatch:ball:thread:thread-1`, `route:${h.source.id}:codex-sol`],
    });

    assert.equal((await h.service.complete(auth(h), 'completed')).outcome, 'replayed');
    h.setLatest(false);
    assert.equal((await h.service.completeFromCoordinationTerminal(terminal.id)).outcome, 'replayed');
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).filter((event) => event.kind === 'ball.dispatch_dispositioned')
        .length,
      1,
    );
  });

  test('missing terminal identity fails closed without producing a disposition', async () => {
    const h = await harness();
    bindActiveCoordination(h);
    const terminal = appendTerminal(h, { causal: undefined });

    await assert.rejects(
      () => h.service.completeFromCoordinationTerminal(terminal.id),
      /a2a_dispatch_coordination_terminal_identity_missing/,
    );
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.dispatch_dispositioned'),
      false,
    );
  });

  test('a superseded source with a successor handoff remains replaced and writes no disposition', async () => {
    const h = await harness();
    bindActiveCoordination(h);
    const terminal = appendTerminal(h);
    const successor = h.messageStore.append({
      userId: 'user-1',
      from: { kind: 'agent', catId: createCatId('opus') },
      content: '@codex-sol continue the successor coordination',
      mentions: [createCatId('codex-sol')],
      timestamp: 1_900,
      threadId: 'thread-1',
      extra: {
        coordination: {
          id: 'coord-successor',
          phase: 'active',
          hop: 1,
          subjectRef: 'task:successor',
        },
      },
    });
    await h.ingest.record(
      buildHandedEvent({
        threadId: 'thread-1',
        fromCatId: 'opus',
        toCatId: 'codex-sol',
        messageId: successor.id,
        at: 1_900,
      }),
    );
    h.setLatest(false);

    await assert.rejects(
      () => h.service.completeFromCoordinationTerminal(terminal.id),
      (error) => {
        assert.equal(error.code, 'a2a_dispatch_disposition_replaced');
        assert.equal(error.replacement.sourceMessageId, successor.id);
        return true;
      },
    );
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.dispatch_dispositioned'),
      false,
    );
  });

  test('both-missing coordination subjects fail closed without producing a disposition', async () => {
    const h = await harness();
    bindActiveCoordination(h);
    delete h.source.extra.coordination.subjectRef;
    const terminal = appendTerminal(h, {
      coordination: { id: COORDINATION_ID, phase: 'terminal', hop: 2 },
    });

    await assert.rejects(
      () => h.service.completeFromCoordinationTerminal(terminal.id),
      /a2a_dispatch_coordination_terminal_mismatch/,
    );
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.dispatch_dispositioned'),
      false,
    );
  });

  test('foreign or mismatched coordination terminals fail closed', async () => {
    const cases = [
      (h) => appendTerminal(h, { coordination: { id: 'coord-foreign', phase: 'terminal', hop: 2 } }),
      (h) => appendTerminal(h, { coordination: { id: COORDINATION_ID, phase: 'terminal', hop: 9 } }),
      (h) => {
        const terminal = appendTerminal(h);
        terminal.threadId = 'thread-foreign';
        return terminal;
      },
      (h) => appendTerminal(h, { stream: { invocationId: 'inv-foreign', turnInvocationId: 'inv-foreign' } }),
    ];

    for (const createTerminal of cases) {
      const h = await harness();
      bindActiveCoordination(h);
      const terminal = createTerminal(h);
      await assert.rejects(
        () => h.service.completeFromCoordinationTerminal(terminal.id),
        /a2a_dispatch_coordination_terminal_mismatch/,
      );
      assert.equal(
        (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.dispatch_dispositioned'),
        false,
      );
    }
  });
});
