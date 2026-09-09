import { mock } from 'node:test';
import { buildHandedCvoEvent } from '../../dist/domains/ball-custody/ball-custody-events.js';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { commitLifecycleResponseFromAppendInput } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { createA2ADispositionHarness } from './a2a-dispatch-disposition-harness.js';

export async function runTerminalQueueHarness(scenario = 'active control') {
  const h = await createA2ADispositionHarness({
    ...(scenario === 'retirement unavailable'
      ? {
          beforeDispositionRecord: async () => {
            throw new Error('retirement store unavailable');
          },
        }
      : {}),
  });
  h.source.extra = {
    crossPost: { sourceThreadId: 'thread-origin', sourceInvocationId: 'origin-invocation' },
    coordination: { id: 'coord-review', phase: 'active', hop: 1, subjectRef: 'task:review' },
    targetCats: ['codex-sol'],
  };
  const terminal = h.messageStore.append({
    from: { kind: 'agent', catId: 'codex-sol' },
    userId: 'user-1',
    content: '@fable5 terminal result',
    mentions: ['fable5'],
    timestamp: 1_750,
    threadId: 'thread-origin',
    origin: 'callback',
    extra: {
      crossPost: { sourceThreadId: 'thread-1', sourceInvocationId: 'inv-1' },
      coordination: { id: 'coord-review', phase: 'terminal', hop: 2, subjectRef: 'task:review' },
      causal: { kind: 'invocation_reply', triggerMessageId: h.source.id },
      stream: { invocationId: 'inv-1', turnInvocationId: 'inv-1' },
      targetCats: ['fable5'],
    },
  });
  h.setLatest(false);
  if (scenario === 'done_notify') {
    await h.ingest.record(
      buildHandedCvoEvent({
        threadId: 'thread-1',
        fromCatId: 'opus',
        messageId: 'unrelated-cvo-message',
        intent: 'done_notify',
        at: 1_751,
      }),
    );
  }

  const queue = new InvocationQueue();
  const invocationTracker = new InvocationTracker();
  const invocationRecords = new Map();
  const invocationRecordStore = {
    create: async (input) => {
      const invocationId = 'inv-stub';
      const record = {
        id: invocationId,
        ...input,
        userMessageId: null,
        status: 'queued',
        createdAt: 1_755,
        updatedAt: 1_755,
      };
      invocationRecords.set(invocationId, record);
      return { outcome: 'created', invocationId };
    },
    get: async (invocationId) => invocationRecords.get(invocationId) ?? null,
    update: async (invocationId, patch) => {
      const current = invocationRecords.get(invocationId);
      if (!current) return null;
      if (patch.expectedStatus && current.status !== patch.expectedStatus) return null;
      const { expectedStatus: _expectedStatus, ...changes } = patch;
      const next = { ...current, ...changes, updatedAt: 1_770 };
      invocationRecords.set(invocationId, next);
      return next;
    },
  };
  let responseMessageId;
  const deps = {
    queue,
    messageStore: h.messageStore,
    a2aDispatchDispositionService: h.service,
    invocationTracker,
    invocationRecordStore,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    router: {
      routeExecution: mock.fn(async function* (...args) {
        const options = args[6];
        const childInvocationId = 'terminal-child';
        const lifecycleAdmission = await options.onLifecycleInvocationStarted({
          threadId: terminal.threadId,
          userId: terminal.userId,
          catId: 'fable5',
          invocationId: childInvocationId,
          parentInvocationId: options.parentInvocationId,
          startedAt: 1_760,
        });
        responseMessageId = lifecycleAdmission.responseMessageId;
        await options.onPromptMessagesExposed({
          threadId: terminal.threadId,
          userId: terminal.userId,
          catId: 'fable5',
          invocationId: childInvocationId,
          messageIds: [terminal.id],
          seenAt: 1_761,
        });
        await commitLifecycleResponseFromAppendInput(
          h.messageStore,
          responseMessageId,
          childInvocationId,
          { status: 'completed', completedAt: 1_765 },
          {
            from: { kind: 'agent', catId: 'fable5' },
            userId: terminal.userId,
            content: 'Review finished.',
            mentions: [],
            timestamp: 1_765,
            threadId: terminal.threadId,
            replyTo: terminal.id,
            origin: 'stream',
            extra: {
              causal: { kind: 'invocation_reply', triggerMessageId: terminal.id },
              stream: { invocationId: 'inv-stub', turnInvocationId: childInvocationId },
            },
          },
        );
        yield {
          type: 'done',
          catId: 'fable5',
          invocationId: childInvocationId,
          isFinal: true,
          timestamp: 1_770,
          turnCustodyTerminalWitness: {
            kind: 'terminal_silent',
            projectionState: 'covered_empty',
            wake: 'coordination_terminal',
          },
        };
      }),
      ackCollectedCursors: async () => {},
    },
  };
  const admitted = await queue.enqueueExistingMessageDurable(h.messageStore, terminal.id, {
    from: terminal.from,
    threadId: terminal.threadId,
    userId: terminal.userId,
    kind: 'message_wake',
    ownerAuthProvenance: 'unknown',
    content: terminal.content,
    messageId: terminal.id,
    sourceId: terminal.id,
    sourceCategory: 'a2a',
    targetCats: ['fable5'],
    intent: 'execute',
    autoExecute: true,
    callerCatId: 'codex-sol',
    a2aParentInvocationId: 'inv-1',
    a2aTriggerMessageId: terminal.id,
  });
  const entry = admitted.entry;
  const queued = queue.getEntrySnapshot(terminal.threadId, terminal.userId, entry.id);
  const processor = new QueueProcessor(deps);
  const attempt = await queue.markProcessingByIdDurable(terminal.threadId, entry.id, 'fable5');
  const result = await processor.executeEntry(attempt);
  const source = h.messageStore.getById(terminal.id);
  const response = responseMessageId ? h.messageStore.getById(responseMessageId) : null;
  return { h, terminal, source, response, queue, deps, entry, queued, processor, result };
}
