import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ContentModificationAcceptance,
  ContentModificationRecord,
  ContentModificationRejection,
  ContentTextProposal,
  ContentWritebackReceipt,
} from '@cat-cafe/shared';
import type { PersistedQueueDeliveryPort } from '../src/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import { assembleContext, getMessageSpeakerName } from '../src/domains/cats/services/context/ContextAssembler.js';
import { MessageStore, type StoredMessage } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ContentModificationChatProjection } from '../src/domains/collaborative-content/modification/chat-projection.js';

const requestId = `f309-modification-${'a'.repeat(64)}`;
const revision = `sha256:${'b'.repeat(64)}`;

function record(
  overrides: {
    requestId?: string;
    taskId?: string;
    sourceVisibility?: { visibility: 'public' | 'whisper'; whisperTo?: readonly string[] };
  } = {},
): ContentModificationRecord {
  return {
    requestId: overrides.requestId ?? requestId,
    ownerUserId: 'operator',
    payload: {
      operationId: '11111111-1111-4111-8111-111111111111',
      targetCatId: 'codex-astra',
      threadId: 'thread-1',
      source: {
        kind: 'workspace',
        locator: { worktreeId: 'work', path: 'guide.md' },
        expectedSourceRevision: revision,
        reviewId: 'review-1',
        expectedReviewRevision: 1,
      },
      intent: { body: 'Please revise this.' },
    },
    progress: {
      sourceMessageId: 'human-message-1',
      sourceMessageRevision: `sha256:${'c'.repeat(64)}`,
      sourceKind: 'human_message',
      ...(overrides.sourceVisibility ? { sourceVisibility: overrides.sourceVisibility } : {}),
      prepared: { kind: 'text', reviewId: 'review-1', sourceRevision: revision },
      task: { taskId: overrides.taskId ?? 'task-open', revision: 1, receiptRef: 'task-receipt-1' },
      review: { reviewId: 'review-1', receiptRef: `${requestId}#request` },
    },
    revision: 5,
    createdAt: 100,
    updatedAt: 200,
  };
}

function proposal(): ContentTextProposal {
  return {
    proposalRef: 'content-patch:request:1',
    requestId,
    revision: 1,
    operationId: '22222222-2222-4222-8222-222222222222',
    baseRevision: revision,
    resultRevision: `sha256:${'d'.repeat(64)}`,
    edits: [{ selectionId: 'selection-1', start: 0, end: 1, expectedText: 'a', replacement: 'b' }],
    response: 'Done.',
    authorCatId: 'codex-astra',
    createdAt: 300,
    receiptRef: 'content-patch:request:1#prepared',
  };
}

function rejection(): ContentModificationRejection {
  return {
    requestId,
    candidateRef: proposal().proposalRef,
    ownerUserId: 'operator',
    actorId: 'operator',
    receiptRef: 'f309-rejection:1',
    state: 'rejected',
    rejectedAt: 400,
  };
}

function acceptance(receiptRef: string): ContentModificationAcceptance {
  return {
    requestId,
    ownerUserId: 'operator',
    acceptOperationId: '33333333-3333-4333-8333-333333333333',
    candidateRef: proposal().proposalRef,
    baseRevision: revision,
    locator: { worktreeId: 'work', path: 'guide.md' },
    humanReceiptRef: `${receiptRef}#human-accepted`,
    fileReceiptRef: receiptRef,
    acceptedAt: 500,
  };
}

function writeback(state: 'applied' | 'conflict' | 'unknown', receiptRef: string): ContentWritebackReceipt {
  return {
    receiptRef,
    ownerUserId: 'operator',
    locator: { worktreeId: 'work', path: 'guide.md' },
    baseRevision: revision,
    candidateRevision: `sha256:${'d'.repeat(64)}`,
    requestId,
    candidateRef: proposal().proposalRef,
    acceptOperationId: '33333333-3333-4333-8333-333333333333',
    state,
    ...(state === 'applied' ? { appliedAt: 550, writtenRevision: `sha256:${'d'.repeat(64)}` } : {}),
    currentRevision: state === 'conflict' ? `sha256:${'e'.repeat(64)}` : revision,
  };
}

function openTask(taskId = 'task-open', ownerCatId = 'codex-astra', status = 'todo') {
  return {
    id: taskId,
    userId: 'operator',
    threadId: 'thread-1',
    ownerCatId,
    status,
    entrustedWork: { closure: { state: status === 'done' ? 'completed' : 'open' } },
  };
}

test('candidate, rejection and applied result append immutable system receipts without waking the cat', async () => {
  const messages = new MessageStore();
  const saved: string[] = [];
  let deliveries = 0;
  const projection = new ContentModificationChatProjection({
    messages,
    tasks: { get: async () => openTask() },
    delivery: { deliver: async () => ((deliveries += 1), { state: 'started', entryId: 'entry-1' }) },
    onSaved: (_userId, _threadId, messageId) => saved.push(messageId),
    onError: (error) => assert.fail(String(error)),
  });
  const source = record();
  await projection.projectCandidate(source, proposal());
  await projection.projectRejection(source, rejection());
  await projection.projectWriteback(source, acceptance('writeback-applied'), writeback('applied', 'writeback-applied'));
  await projection.projectCandidate(source, proposal());

  const stored = await messages.getByThread('thread-1', 20, 'operator');
  assert.equal(stored.length, 3);
  assert.equal(saved.length, 3, 'idempotent replay does not rebroadcast history');
  assert.equal(deliveries, 0);
  assert.deepEqual(
    stored.map((message) => message.extra?.contentModificationReceiptV1?.state),
    ['candidate', 'rejected', 'applied'],
  );
  for (const message of stored) {
    assert.equal(message.userId, 'system');
    assert.equal(message.catId, null);
    assert.deepEqual(message.mentions, []);
    assert.equal(message.extra?.targetCats, undefined);
    assert.equal(message.extra?.systemKind, 'content_modification_receipt');
    assert.equal(message.replyTo, 'human-message-1');
    assert.deepEqual(message.extra?.contentModificationReceiptV1?.followUp, {
      kind: 'none',
      reason: 'not_applicable',
    });
    assert.equal(getMessageSpeakerName(message), 'Host 作品修改回执');
  }
  const prompt = assembleContext(stored, { maxTotalTokens: 20_000 }).contextText;
  assert.match(prompt, /Host 作品修改回执/);
  assert.match(prompt, /候选修改已返回/);
  assert.doesNotMatch(prompt, /co-creator.*作品修改回执/);
});

test('a receipt inherits the Human source whisper audience instead of widening it to the thread', async () => {
  const messages = new MessageStore();
  const projection = new ContentModificationChatProjection({
    messages,
    tasks: { get: async () => openTask() },
    onSaved: () => {},
    onError: (error) => assert.fail(String(error)),
  });
  await projection.projectCandidate(
    record({ sourceVisibility: { visibility: 'whisper', whisperTo: ['codex-astra'] } }),
    proposal(),
  );

  const [receipt] = await messages.getByThread('thread-1', 20, 'operator');
  assert.equal(receipt?.visibility, 'whisper');
  assert.deepEqual(receipt?.whisperTo, ['codex-astra']);
});

test('conflict wakes one still-open exact Task owner through one idempotent refs-only carrier', async () => {
  const messages = new MessageStore();
  const delivered: Parameters<PersistedQueueDeliveryPort['deliver']>[0][] = [];
  const delivery: PersistedQueueDeliveryPort = {
    async deliver(input) {
      delivered.push(input);
      return { state: 'started', entryId: 'entry-1', message: wakeMessage(input) };
    },
  };
  const projection = new ContentModificationChatProjection({
    messages,
    tasks: { get: async () => openTask() },
    delivery,
    onSaved: () => {},
    onError: (error) => assert.fail(String(error)),
  });
  const source = record();
  const accepted = acceptance('writeback-conflict');
  const receipt = writeback('conflict', 'writeback-conflict');
  await projection.projectWriteback(source, accepted, receipt);
  await projection.projectWriteback(source, accepted, receipt);

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.targetCatId, 'codex-astra');
  assert.equal(delivered[0]?.source.meta?.requestId, requestId);
  assert.match(delivered[0]?.content ?? '', /不得自动重试写回/);
  const stored = await messages.getByThread('thread-1', 20, 'operator');
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0]?.extra?.contentModificationReceiptV1?.followUp, {
    kind: 'cat_woken',
    executionRef: 'message:wake-1#queue-custody',
  });
});

test('closed, owner-changed and unverified Tasks never manufacture a wake claim', async () => {
  const messages = new MessageStore();
  let deliveries = 0;
  const tasks = new Map([
    ['task-closed', openTask('task-closed', 'codex-astra', 'done')],
    ['task-other', openTask('task-other', 'opus55')],
  ]);
  const projection = new ContentModificationChatProjection({
    messages,
    tasks: { get: async (taskId) => tasks.get(taskId) ?? null },
    delivery: { deliver: async () => ((deliveries += 1), { state: 'started', entryId: 'unexpected' }) },
    onSaved: () => {},
    onError: (error) => assert.fail(String(error)),
  });
  await projection.projectWriteback(
    record({ taskId: 'task-closed' }),
    acceptance('writeback-closed'),
    writeback('conflict', 'writeback-closed'),
  );
  await projection.projectWriteback(
    record({ taskId: 'task-other', requestId: `f309-modification-${'f'.repeat(64)}` }),
    { ...acceptance('writeback-other'), requestId: `f309-modification-${'f'.repeat(64)}` },
    { ...writeback('conflict', 'writeback-other'), requestId: `f309-modification-${'f'.repeat(64)}` },
  );
  await projection.projectWriteback(
    record({ taskId: 'task-missing', requestId: `f309-modification-${'9'.repeat(64)}` }),
    { ...acceptance('writeback-missing'), requestId: `f309-modification-${'9'.repeat(64)}` },
    { ...writeback('unknown', 'writeback-missing'), requestId: `f309-modification-${'9'.repeat(64)}` },
  );
  assert.equal(deliveries, 0);
  const receipts = (await messages.getByThread('thread-1', 20, 'operator')).map(
    (message) => message.extra?.contentModificationReceiptV1,
  );
  assert.deepEqual(
    receipts.map((item) => item?.followUp),
    [{ kind: 'none', reason: 'task_closed' }, { kind: 'none', reason: 'owner_changed' }, { kind: 'unverified' }],
  );
});

test('deferred or terminal Queue custody never claims that the Cat was woken', async () => {
  for (const [index, state] of (
    ['owned_deferred_busy', 'owned_deferred_paused', 'owned_deferred_suppressed', 'terminal_owned'] as const
  ).entries()) {
    const requestId = `f309-modification-${String(index + 1).repeat(64)}`;
    const messages = new MessageStore();
    const projection = new ContentModificationChatProjection({
      messages,
      tasks: { get: async () => openTask() },
      delivery: {
        async deliver(input) {
          return { state, entryId: `entry-${state}`, message: wakeMessage(input) };
        },
      },
      onSaved: () => {},
      onError: (error) => assert.fail(String(error)),
    });
    await projection.projectWriteback(
      record({ requestId }),
      {
        ...acceptance(`writeback-${state}`),
        requestId,
      },
      {
        ...writeback('conflict', `writeback-${state}`),
        requestId,
      },
    );
    const [receipt] = await messages.getByThread('thread-1', 20, 'operator');
    assert.deepEqual(receipt?.extra?.contentModificationReceiptV1?.followUp, { kind: 'unverified' }, state);
  }
});

function wakeMessage(input: Parameters<PersistedQueueDeliveryPort['deliver']>[0]): StoredMessage {
  return {
    id: 'wake-1',
    userId: input.ownerUserId,
    threadId: input.threadId,
    catId: null,
    content: input.content,
    mentions: [input.targetCatId as StoredMessage['mentions'][number]],
    timestamp: 500,
    source: input.source,
  };
}
