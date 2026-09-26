import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { AgentClientInputConsumption } from '../../types.js';

/** One Append the Queue handed to a running carrier; its History ref waits until the model reads it. */
export interface HandedAppend {
  readonly threadId: string;
  readonly userId: string;
  readonly entryId: string;
  readonly inputMessageIds: readonly string[];
  readonly run: { readonly targetId: string; readonly invocationId: string; readonly responseMessageId: string };
}

export interface AppendReadCutoverDeps {
  readonly messageStore: Pick<IMessageStore, 'commitLifecycleAppendRead'>;
  /** Mirror a read input into the live run; false once that run has closed (History is still the truth). */
  mirrorIntoActiveRun(handed: HandedAppend): boolean;
  /** Publish the inputs into the timeline (queued → delivered) and tell the owner's clients. */
  publish(handed: HandedAppend, deliveredAt: number): Promise<{ failedIds: readonly string[] }>;
  emitMessage(userId: string, message: StoredMessage): void;
  registerCallerSources(sources: readonly StoredMessage[], targetIds: readonly string[]): void;
  emitQueue(handed: HandedAppend, reason: 'append_read' | 'append_unread'): Promise<void>;
  readonly log: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
  readonly now?: () => number;
}

/**
 * F117 Phase M: consumption evidence arrived, so the Append becomes read in one commit — the
 * response's input and the ref's `readAt` — then it is published at its read time and mirrored into
 * the live run. Publication is idempotent; if it fails here, the response's settlement publishes it.
 */
async function commitRead(deps: AppendReadCutoverDeps, handed: HandedAppend, readAt: number): Promise<void> {
  const read = await deps.messageStore.commitLifecycleAppendRead({
    threadId: handed.threadId,
    entryId: handed.entryId,
    inputMessageIds: handed.inputMessageIds,
    run: handed.run,
    readAt,
  });
  if (read.kind !== 'applied' && read.kind !== 'replayed') {
    deps.log.error(
      { threadId: handed.threadId, entryId: handed.entryId, outcome: read },
      '[append-read] consumption evidence could not be committed; the Append stays waiting',
    );
    return;
  }
  if (!deps.mirrorIntoActiveRun(handed)) {
    deps.log.info(
      { threadId: handed.threadId, invocationId: handed.run.invocationId },
      '[append-read] the Append was read after its live run closed; History records it',
    );
  }
  await publishInputs(deps, handed, readAt);
  for (const message of read.messages) deps.emitMessage(handed.userId, message);
  deps.registerCallerSources(read.messages.slice(0, handed.inputMessageIds.length), [handed.run.targetId]);
  await deps.emitQueue(handed, 'append_read');
}

async function publishInputs(deps: AppendReadCutoverDeps, handed: HandedAppend, deliveredAt: number): Promise<void> {
  const delivery = await deps.publish(handed, deliveredAt);
  if (delivery.failedIds.length > 0) {
    deps.log.warn(
      { threadId: handed.threadId, failedIds: delivery.failedIds },
      '[append-read] publishing the Append failed; its response settlement publishes it',
    );
  }
}

/**
 * Follow the carrier's consumption report for one accepted Append. Read on evidence; a run that
 * closed without evidence publishes the Append now, and its response settles the ref `unread`. A
 * carrier that cannot report consumption leaves the Append waiting until that settlement. The
 * Append is never returned to the Queue.
 */
export async function followAppendConsumption(
  deps: AppendReadCutoverDeps,
  handed: HandedAppend,
  consumption: Promise<AgentClientInputConsumption> | undefined,
): Promise<void> {
  if (!consumption) return;
  try {
    const report = await consumption;
    if (report.consumed) {
      await commitRead(deps, handed, report.at);
      return;
    }
    await publishInputs(deps, handed, (deps.now ?? Date.now)());
    await deps.emitQueue(handed, 'append_unread');
  } catch (err) {
    deps.log.error(
      { err, threadId: handed.threadId, entryId: handed.entryId },
      '[append-read] following the Append consumption failed; its response settlement publishes it',
    );
  }
}
