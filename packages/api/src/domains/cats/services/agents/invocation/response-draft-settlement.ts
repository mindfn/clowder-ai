import type { RichBlock } from '@cat-cafe/shared';
import type { DraftRecord, IDraftStore } from '../../stores/ports/DraftStore.js';
import {
  type IMessageStore,
  type LifecycleResponseTerminalPatch,
  type StoredMessage,
  type StoredToolEvent,
  settleLifecycleResponseInputs,
} from '../../stores/ports/MessageStore.js';
import type { ITurnExecutionStore, TurnExecutionRecord } from '../../stores/ports/TurnExecutionStore.js';
import { extractRichFromText } from '../routing/rich-block-extract.js';
import { sanitizeInjectedContent } from '../routing/route-helpers.js';

/**
 * F117 KD-21: a streaming draft is the in-flight body of its response R and lives exactly as long as
 * R is processing. A path that ends a turn outside the route's own commit (stop, restart, zombie
 * reclaim) settles R here: a processing R takes the draft's streamed body with its terminal state,
 * and an R that is already terminal keeps its own. Either way the inputs settle, the terminal R is
 * published, and only then is the draft deleted and the turn cleared from the response-pending
 * ledger. A rejected commit throws before any of that, so the draft and the ledger entry survive for
 * the next settlement pass.
 */

/** The admission key of the response R a child turn owns; its draft is keyed by the same id. */
export function lifecycleResponseIdempotencyKey(invocationId: string): string {
  return `message-lifecycle-response:${invocationId}`;
}

export interface ResponseDraftSettlementDeps {
  messageStore: IMessageStore;
  draftStore?: Pick<IDraftStore, 'getByThread' | 'delete'>;
  /** Clears the turn from the response-pending ledger once R is confirmed terminal. */
  responseLedger?: Pick<ITurnExecutionStore, 'clearResponsePending'>;
  /** Publishes the terminal R to its user's live timeline. */
  emit?: (userId: string, message: StoredMessage) => void;
}

export interface ResponseDraftSettlementInput {
  userId: string;
  threadId: string;
  /** The child turn id that keys both R and its draft. */
  invocationId: string;
  status: 'failed' | 'canceled' | 'interrupted';
  reason: string;
  endedAt: number;
  /** Why the turn ended, appended once after the streamed body. */
  explanation?: string;
  /**
   * The turn's output was rejected. Its draft is deleted before R commits, so neither this commit
   * nor a later retry can publish it; R keeps its own empty body.
   */
  discardDraftBody?: boolean;
}

/**
 * How a later settlement pass ends R: with the ended turn's own terminal truth. A turn that
 * succeeded but whose R never committed lost its delivery to the process restart.
 */
export function responseOutcomeForEndedTurn(
  turn: TurnExecutionRecord,
): Pick<ResponseDraftSettlementInput, 'status' | 'reason' | 'endedAt'> {
  const endedAt = turn.endedAt ?? turn.startedAt;
  if (turn.status === 'failed' || turn.status === 'canceled' || turn.status === 'interrupted') {
    return { status: turn.status, reason: turn.terminalReason ?? 'process_restart', endedAt };
  }
  return { status: 'interrupted', reason: 'process_restart', endedAt };
}

export type ResponseDraftSettlement =
  | { kind: 'committed' | 'already_terminal'; message: StoredMessage }
  | { kind: 'no_response' };

export async function settleResponseFromDraft(
  deps: ResponseDraftSettlementDeps,
  input: ResponseDraftSettlementInput,
): Promise<ResponseDraftSettlement> {
  const response = await deps.messageStore.getByIdempotencyKey(
    input.userId,
    input.threadId,
    lifecycleResponseIdempotencyKey(input.invocationId),
  );
  if (response?.lifecycle?.kind !== 'response') {
    await deps.responseLedger?.clearResponsePending(input.invocationId);
    return { kind: 'no_response' };
  }

  const settled =
    response.lifecycle.status === 'processing'
      ? await commitFromDraft(deps, response, input)
      : { kind: 'already_terminal' as const, message: response };
  await settleLifecycleResponseInputs(deps.messageStore, settled.message, settled.message.id);
  deps.emit?.(input.userId, settled.message);
  await deps.draftStore?.delete(input.userId, input.threadId, input.invocationId);
  await deps.responseLedger?.clearResponsePending(input.invocationId);
  return settled;
}

/** Commits a processing R with its draft's body. A writer that ended R first keeps its own body. */
async function commitFromDraft(
  deps: ResponseDraftSettlementDeps,
  response: StoredMessage,
  input: ResponseDraftSettlementInput,
): Promise<{ kind: 'committed' | 'already_terminal'; message: StoredMessage }> {
  if (input.discardDraftBody) await deps.draftStore?.delete(input.userId, input.threadId, input.invocationId);
  const draft = input.discardDraftBody ? undefined : await readDraft(deps, input);
  const result = await deps.messageStore.commitLifecycleResponseTerminal(
    response.id,
    terminalPatchFromDraft(response, draft, input),
  );
  if (result.kind === 'applied' || result.kind === 'replayed') return { kind: 'committed', message: result.message };
  const endedByAnotherWriter =
    result.kind === 'conflict' &&
    result.message.lifecycle?.kind === 'response' &&
    result.message.lifecycle.status !== 'processing';
  if (endedByAnotherWriter) return { kind: 'already_terminal', message: result.message };
  throw new Error(
    `response draft settlement rejected: ${result.kind}${result.kind === 'conflict' ? `:${result.reason}` : ''}`,
  );
}

async function readDraft(
  deps: ResponseDraftSettlementDeps,
  input: ResponseDraftSettlementInput,
): Promise<DraftRecord | undefined> {
  if (!deps.draftStore) return undefined;
  const drafts = await deps.draftStore.getByThread(input.userId, input.threadId);
  return drafts.find((candidate) => candidate.invocationId === input.invocationId);
}

function terminalPatchFromDraft(
  response: StoredMessage,
  draft: DraftRecord | undefined,
  input: ResponseDraftSettlementInput,
): LifecycleResponseTerminalPatch {
  const streamed = streamedContent(response, draft, input.explanation);
  const toolEvents = draft?.toolEvents ? draft.toolEvents.filter(isStoredToolEvent) : response.toolEvents;
  const thinking = draft?.thinking ?? response.thinking;
  const extra = withRichBlocks(response.extra, streamed.blocks);
  const startedAt = response.lifecycle?.kind === 'response' ? response.lifecycle.startedAt : input.endedAt;
  return {
    invocationId: input.invocationId,
    status: input.status,
    completedAt: Math.max(input.endedAt, startedAt),
    reason: input.reason,
    content: streamed.content,
    ...retainedResponseFields(response),
    ...(toolEvents?.length ? { toolEvents } : {}),
    ...(extra ? { extra } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

/** The draft holds the raw streamed text; R stores it the way the route's own commit does. */
function streamedContent(
  response: StoredMessage,
  draft: DraftRecord | undefined,
  explanation: string | undefined,
): { content: string; blocks: RichBlock[] } {
  const streamed = draft
    ? extractRichFromText(sanitizeInjectedContent(draft.content))
    : { cleanText: response.content, blocks: [] };
  const body = streamed.cleanText.trim();
  const suffix = explanation && !body.includes(explanation) ? [explanation] : [];
  return { content: [body, ...suffix].filter(Boolean).join('\n\n'), blocks: streamed.blocks };
}

function withRichBlocks(extra: StoredMessage['extra'], blocks: readonly RichBlock[]): StoredMessage['extra'] {
  if (blocks.length === 0) return extra;
  return { ...extra, rich: { v: 1, blocks: [...(extra?.rich?.blocks ?? []), ...blocks] } };
}

/** R's own surfaces, restated because the terminal commit deletes every field its patch omits. */
function retainedResponseFields(response: StoredMessage) {
  return {
    ...(response.contentBlocks ? { contentBlocks: response.contentBlocks } : {}),
    ...(response.metadata ? { metadata: response.metadata } : {}),
    ...(response.origin ? { origin: response.origin } : {}),
    mentions: response.mentions,
    ...(response.mentionsUser ? { mentionsUser: true } : {}),
    ...(response.replyTo ? { replyTo: response.replyTo } : {}),
  };
}

/** Draft tool events are the route's StoredToolEvent buffer after a JSON round trip. */
function isStoredToolEvent(value: unknown): value is StoredToolEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === 'string' &&
    (event.type === 'tool_use' || event.type === 'tool_result') &&
    typeof event.label === 'string' &&
    typeof event.timestamp === 'number'
  );
}
