import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { createDeliverFn, createLifecycleToastFn } from '../dist/infrastructure/scheduler/delivery.js';

/**
 * sol P1 regression (2026-07-20 → 23 incident): the scheduler delivery writer
 * silently missed the F257 V1 write-boundary contract (`append requires
 * provenance`), and the AnyFn-typed mock in this file self-certified — every
 * scheduled delivery failed at runtime while tests stayed green. These tests
 * therefore run against the REAL in-memory MessageStore, which enforces
 * assertProvenanceConsistent on every append.
 */
describe('createDeliverFn', () => {
  it('appends connector message to a REAL store with system provenance and broadcasts', async () => {
    const messageStore = new MessageStore();
    const socketManager = { broadcastToRoom: mock.fn(), emitToUser: mock.fn() };
    const deliver = createDeliverFn({ messageStore, socketManager });

    const msgId = await deliver({
      threadId: 'th-1',
      content: 'Hello reminder',
      userId: 'user-1',
      extra: { scheduler: { hiddenTrigger: true } },
    });

    const stored = messageStore.getById(msgId);
    assert.ok(stored, 'message persisted in real store');
    assert.deepEqual(stored.provenance, { author: 'system', routed: false, observation: 'original' });
    assert.equal(stored.threadId, 'th-1');
    assert.equal(stored.content, 'Hello reminder');
    assert.equal(stored.catId, null);
    assert.equal(stored.origin, 'callback');
    assert.equal(stored.source.connector, 'scheduler');
    assert.equal(stored.source.label, '定时任务');
    assert.equal(stored.extra.scheduler.hiddenTrigger, true);
    assert.equal(socketManager.broadcastToRoom.mock.calls.length, 1);
    const [room, event, payload] = socketManager.broadcastToRoom.mock.calls[0].arguments;
    assert.equal(room, 'thread:th-1');
    assert.equal(event, 'connector_message');
    assert.equal(payload.threadId, 'th-1');
    assert.equal(payload.message.content, 'Hello reminder');
    assert.equal(payload.message.source.connector, 'scheduler');
    assert.equal(payload.message.extra.scheduler.hiddenTrigger, true);
  });

  it('REGRESSION: real store rejects an append without provenance (the incident failure mode)', () => {
    const messageStore = new MessageStore();
    assert.throws(
      () =>
        messageStore.append({
          userId: 'user-1',
          catId: null,
          content: 'no provenance',
          mentions: [],
          origin: 'callback',
          timestamp: Date.now(),
          threadId: 'th-x',
        }),
      /append requires provenance/,
    );
  });

  it('idempotencyKey makes a retried delivery return the original message (once-task retry safety)', async () => {
    const messageStore = new MessageStore();
    const socketManager = { broadcastToRoom: mock.fn(), emitToUser: mock.fn() };
    const deliver = createDeliverFn({ messageStore, socketManager });

    const first = await deliver({
      threadId: 'th-1',
      content: 'wake',
      userId: 'scheduler',
      idempotencyKey: 'reminder:hold-ball-1',
    });
    const second = await deliver({
      threadId: 'th-1',
      content: 'wake',
      userId: 'scheduler',
      idempotencyKey: 'reminder:hold-ball-1',
    });

    assert.equal(second, first);
    assert.equal(messageStore.getByThread('th-1').length, 1);
  });

  it('works with async messageStore.append', async () => {
    const inner = new MessageStore();
    const messageStore = { append: async (msg) => inner.append(msg) };
    const socketManager = { broadcastToRoom: mock.fn(), emitToUser: mock.fn() };
    const deliver = createDeliverFn({ messageStore, socketManager });

    const msgId = await deliver({
      threadId: 'th-3',
      content: 'async test',
      userId: 'u-1',
    });
    const stored = await inner.getById(msgId);
    assert.ok(stored);
    assert.deepEqual(stored.provenance, { author: 'system', routed: false, observation: 'original' });
  });
});

describe('createLifecycleToastFn', () => {
  it('emits scheduler lifecycle toast via user-scoped connector_message without persistence', () => {
    const socketManager = { broadcastToRoom: mock.fn(), emitToUser: mock.fn() };
    const emitLifecycleToast = createLifecycleToastFn({ socketManager });

    emitLifecycleToast({
      threadId: 'thread-toast',
      userId: 'user-42',
      toast: {
        type: 'info',
        title: '定时任务已创建',
        message: '「喝水提醒」下次执行时间：2026-04-13 09:00:00',
        duration: 3200,
        lifecycleEvent: 'registered',
      },
    });

    assert.equal(socketManager.broadcastToRoom.mock.calls.length, 0);
    assert.equal(socketManager.emitToUser.mock.calls.length, 1);
    const [userId, event, payload] = socketManager.emitToUser.mock.calls[0].arguments;
    assert.equal(userId, 'user-42');
    assert.equal(event, 'connector_message');
    assert.equal(payload.threadId, 'thread-toast');
    assert.equal(payload.message.source.connector, 'scheduler');
    assert.equal(payload.message.extra.scheduler.toast.title, '定时任务已创建');
    assert.equal(payload.message.extra.scheduler.toast.lifecycleEvent, 'registered');
  });
});
