import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisTurnExecutionStore } from '../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { readModificationSourceExecution } from '../dist/domains/collaborative-content/modification/media-publication/source-execution.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const redis = ownedRedisFixture('f117-execution-source');
const query = { userId: 'owner', threadId: 'thread', catId: 'codex-astra', messageId: 'private-carrier' };
const input = (id, extra = {}) => ({
  invocationId: id,
  parentInvocationId: 'parent',
  ...query,
  executionKind: 'ordinary',
  startedAt: 100,
  causal: { triggerMessageId: query.messageId },
  ...extra,
});

for (const backend of ['memory', 'Redis']) {
  test(`${backend} scoped source lookup retains terminal causality without creating delivery or read truth`, async () => {
    const client = backend === 'Redis' ? redis.client(`source-query:[*]:${randomUUID()}:`) : undefined;
    const store = client ? new RedisTurnExecutionStore(client) : new InMemoryTurnExecutionStore();
    await store.createRunning(input('exact'));
    await store.createRunning(input('late-bound', { causal: { triggerMessageId: 'other' } }));
    await store.bindCoveredMessageIds('late-bound', [query.messageId]);
    for (const [field, value] of [
      ['userId', 'foreign'],
      ['threadId', 'foreign'],
      ['catId', 'opus'],
      ['executionKind', 'routing_guard'],
    ]) {
      await store.createRunning(input(`wrong-${field}`, { [field]: value }));
    }
    await store.createRunning(input('wrong-source', { causal: { triggerMessageId: 'foreign' } }));
    await store.transitionTerminal('exact', { status: 'succeeded', endedAt: 101 });
    await store.clearResponsePending('exact');
    const reopened = client ? new RedisTurnExecutionStore(client) : store;
    const before = await reopened.get('exact');
    assert.deepEqual((await reopened.listBySource(query)).map((record) => record.invocationId).sort(), [
      'exact',
      'late-bound',
    ]);
    assert.deepEqual(await reopened.get('exact'), before);
    assert.deepEqual(await reopened.listBySource({ ...query, messageId: 'missing' }), []);
    assert.equal((await reopened.get('late-bound')).status, 'running');
    client?.disconnect();
  });
}

test('private execution lookup requires exact scope, audience and unambiguous causality; no public input reference is added', async () => {
  const messages = new MessageStore();
  const source = messages.append({
    userId: query.userId,
    threadId: query.threadId,
    from: { kind: 'external', connectorId: 'content-review' },
    source: { connector: 'content-review', label: 'owned review', meta: {} },
    content: 'private body',
    visibility: 'whisper',
    whisperTo: [query.catId],
    mentions: [query.catId],
    timestamp: 100,
    lifecycle: { kind: 'input', orderKey: '100:private', dispatchRefs: [] },
  });
  const turns = new InMemoryTurnExecutionStore();
  const exactQuery = { ...query, messageId: source.id };
  await turns.createRunning(input('exact', { causal: { triggerMessageId: source.id } }));
  const before = structuredClone(source);
  assert.equal((await readModificationSourceExecution(messages, turns, source, query.catId)).invocationId, 'exact');
  assert.equal(await readModificationSourceExecution(messages, turns, source, 'opus'), undefined);
  assert.equal(await readModificationSourceExecution(messages, turns, source, query.catId, 'unknown'), undefined);
  const exact = turns.get('exact');
  for (const patch of [
    { invocationId: 'different-child' },
    { parentInvocationId: '' },
    { parentInvocationId: 'exact' },
  ]) {
    assert.equal(
      await readModificationSourceExecution(
        messages,
        { get: () => ({ ...exact, ...patch }) },
        source,
        query.catId,
        'exact',
      ),
      undefined,
      'the requested native ID must identify a real exact child, not just a matching source',
    );
  }
  assert.equal(
    await readModificationSourceExecution(messages, turns, { ...source, userId: 'foreign' }, query.catId, 'exact'),
    undefined,
  );
  assert.equal(
    await readModificationSourceExecution(messages, turns, { ...source, threadId: 'foreign' }, query.catId, 'exact'),
    undefined,
  );
  assert.equal(
    await readModificationSourceExecution(messages, turns, { ...source, _tombstone: true }, query.catId, 'exact'),
    undefined,
  );
  await turns.createRunning(input('ambiguous', { causal: { coveredMessageIds: [source.id] } }));
  assert.equal((await turns.listBySource(exactQuery)).length, 2);
  assert.equal(await readModificationSourceExecution(messages, turns, source, query.catId), undefined);
  assert.deepEqual(messages.getById(source.id), before);
  assert.deepEqual(source.lifecycle.dispatchRefs, []);
});
