import type { LifecycleDispatchRef, LifecycleStoredMessageMetadata } from '@cat-cafe/shared';
import { getTimelineOrderTime } from '../visibility.js';
import type { StoredMessage } from './MessageStore.js';

/**
 * F117 Phase M: an Append handed to a running carrier becomes read only on consumption evidence.
 *
 * The input's dispatchRef is canonical (`readState: 'awaiting'` until then); the response keeps a
 * handed index written in the same commit. These pure transitions are shared by every store.
 */
export interface LifecycleAppendReadInput {
  threadId: string;
  entryId: string;
  inputMessageIds: readonly string[];
  run: { targetId: string; invocationId: string; responseMessageId: string };
  /** When the carrier's consumption evidence arrived. */
  readAt: number;
}

export type CommitLifecycleAppendReadResult =
  | { kind: 'applied' | 'replayed'; messages: StoredMessage[] }
  | {
      kind: 'conflict';
      reason: 'invalid_input' | 'scope_mismatch' | 'input_lifecycle_conflict' | 'response_lifecycle_conflict';
    }
  | { kind: 'not_found' };

type ResponseLifecycle = Extract<LifecycleStoredMessageMetadata, { kind: 'response' }>;
type PreparedRead = { kind: 'prepared'; lifecycles: LifecycleStoredMessageMetadata[]; replayed: boolean };

function containsAll(list: readonly string[] | undefined, ids: readonly string[]): boolean {
  return ids.every((id) => list?.includes(id) === true);
}

function withoutIds(list: readonly string[] | undefined, ids: ReadonlySet<string>): string[] {
  return (list ?? []).filter((id) => !ids.has(id));
}

/** Drop an emptied handed index so a response that never had an Append keeps its old shape. */
export function withHandedInputs(
  response: ResponseLifecycle,
  handedEntryIds: readonly string[],
  handedMessageIds: readonly string[],
): ResponseLifecycle {
  const { handedInputEntryIds: _entries, handedInputMessageIds: _messages, ...rest } = response;
  return handedEntryIds.length === 0 && handedMessageIds.length === 0
    ? rest
    : { ...rest, handedInputEntryIds: [...handedEntryIds], handedInputMessageIds: [...handedMessageIds] };
}

/** Record an Append as handed to this processing response, not as one of its inputs. */
export function handLifecycleResponseInputsMetadata(
  current: LifecycleStoredMessageMetadata | undefined,
  input: { entryId: string; inputMessageIds: readonly string[]; targetId: string; invocationId: string },
): { kind: 'applied'; lifecycle: LifecycleStoredMessageMetadata } | { kind: 'replayed' } | { kind: 'conflict' } {
  if (
    current?.kind !== 'response' ||
    current.status !== 'processing' ||
    current.targetId !== input.targetId ||
    current.invocationId !== input.invocationId
  ) {
    return { kind: 'conflict' };
  }
  const handed = current.handedInputEntryIds?.includes(input.entryId) === true;
  const read = current.inputEntryIds.includes(input.entryId);
  if (handed || read) {
    const list = handed ? current.handedInputMessageIds : current.inputMessageIds;
    return containsAll(list, input.inputMessageIds) ? { kind: 'replayed' } : { kind: 'conflict' };
  }
  const known = [...current.inputMessageIds, ...(current.handedInputMessageIds ?? [])];
  if (input.inputMessageIds.some((id) => known.includes(id))) return { kind: 'conflict' };
  return {
    kind: 'applied',
    lifecycle: withHandedInputs(
      current,
      [...(current.handedInputEntryIds ?? []), input.entryId],
      [...(current.handedInputMessageIds ?? []), ...input.inputMessageIds],
    ),
  };
}

/** Undo either membership of a rejected Append: handed (Phase M) or read (adoption/legacy). */
export function removeLifecycleResponseInputs(
  current: ResponseLifecycle,
  entryId: string,
  inputMessageIds: readonly string[],
): { kind: 'applied'; lifecycle: ResponseLifecycle } | { kind: 'replayed' } | { kind: 'conflict' } {
  const ids = new Set(inputMessageIds);
  const handedEntry = current.handedInputEntryIds?.includes(entryId) === true;
  const readEntry = current.inputEntryIds.includes(entryId);
  const handedPresent = inputMessageIds.filter((id) => current.handedInputMessageIds?.includes(id));
  const readPresent = inputMessageIds.filter((id) => current.inputMessageIds.includes(id));
  if (!handedEntry && !readEntry && handedPresent.length === 0 && readPresent.length === 0) return { kind: 'replayed' };
  if (handedEntry && handedPresent.length === inputMessageIds.length && !readEntry && readPresent.length === 0) {
    return {
      kind: 'applied',
      lifecycle: withHandedInputs(
        current,
        (current.handedInputEntryIds ?? []).filter((id) => id !== entryId),
        withoutIds(current.handedInputMessageIds, ids),
      ),
    };
  }
  if (readEntry && readPresent.length === inputMessageIds.length && !handedEntry && handedPresent.length === 0) {
    return {
      kind: 'applied',
      lifecycle: {
        ...current,
        inputEntryIds: current.inputEntryIds.filter((id) => id !== entryId),
        inputMessageIds: withoutIds(current.inputMessageIds, ids),
      },
    };
  }
  return { kind: 'conflict' };
}

/** A read ref keeps its phase and gains `readAt`; a ref already read stays as it is. */
function readDispatchRef(ref: LifecycleDispatchRef, readAt: number): LifecycleDispatchRef | 'already_read' {
  if (ref.readAt !== undefined || ref.readState === undefined) return 'already_read';
  const { readState: _unreadYet, ...rest } = ref;
  return { ...rest, readAt } as LifecycleDispatchRef;
}

function isValidReadInput(input: LifecycleAppendReadInput): boolean {
  return (
    !!input.threadId &&
    !!input.entryId &&
    input.inputMessageIds.length > 0 &&
    new Set(input.inputMessageIds).size === input.inputMessageIds.length &&
    !!input.run.targetId &&
    !!input.run.invocationId &&
    !!input.run.responseMessageId &&
    !input.inputMessageIds.includes(input.run.responseMessageId) &&
    Number.isFinite(input.readAt)
  );
}

/**
 * Consumption evidence arrived: the handed Append becomes one of the response's inputs and its ref
 * gains `readAt`. A response that already settled (the evidence raced its terminal) is upgraded too,
 * because the evidence says the model read it; its `unread` ref becomes read.
 */
export function prepareLifecycleAppendRead(
  messages: readonly StoredMessage[],
  input: LifecycleAppendReadInput,
): PreparedRead | CommitLifecycleAppendReadResult {
  if (!isValidReadInput(input)) return { kind: 'conflict', reason: 'invalid_input' };
  if (messages.length !== input.inputMessageIds.length + 1) return { kind: 'not_found' };
  if (messages.some((message) => message.threadId !== input.threadId)) {
    return { kind: 'conflict', reason: 'scope_mismatch' };
  }
  const lifecycles: LifecycleStoredMessageMetadata[] = [];
  let replayed = true;
  for (let index = 0; index < input.inputMessageIds.length; index += 1) {
    const lifecycle = messages[index]!.lifecycle;
    if (!lifecycle || lifecycle.kind === 'delivery_failure') {
      return { kind: 'conflict', reason: 'input_lifecycle_conflict' };
    }
    const refs = lifecycle.dispatchRefs ?? [];
    const matching = refs.filter((ref) => ref.targetId === input.run.targetId);
    if (matching.length !== 1 || matching[0]!.statusMessageId !== input.run.responseMessageId) {
      return { kind: 'conflict', reason: 'input_lifecycle_conflict' };
    }
    const next = readDispatchRef(matching[0]!, input.readAt);
    if (next === 'already_read') {
      lifecycles.push(lifecycle);
      continue;
    }
    replayed = false;
    lifecycles.push({
      ...lifecycle,
      dispatchRefs: refs.map((ref) => (ref.targetId === input.run.targetId ? next : ref)),
    });
  }

  const response = messages[input.inputMessageIds.length]!.lifecycle;
  if (
    response?.kind !== 'response' ||
    response.targetId !== input.run.targetId ||
    response.invocationId !== input.run.invocationId
  ) {
    return { kind: 'conflict', reason: 'response_lifecycle_conflict' };
  }
  if (response.inputEntryIds.includes(input.entryId) && containsAll(response.inputMessageIds, input.inputMessageIds)) {
    lifecycles.push(response);
    return { kind: 'prepared', lifecycles, replayed };
  }
  if (
    response.handedInputEntryIds?.includes(input.entryId) !== true ||
    !containsAll(response.handedInputMessageIds, input.inputMessageIds)
  ) {
    return { kind: 'conflict', reason: 'response_lifecycle_conflict' };
  }
  const ids = new Set(input.inputMessageIds);
  const moved = withHandedInputs(
    response,
    (response.handedInputEntryIds ?? []).filter((id) => id !== input.entryId),
    withoutIds(response.handedInputMessageIds, ids),
  );
  lifecycles.push({
    ...moved,
    inputEntryIds: [...response.inputEntryIds, input.entryId],
    inputMessageIds: [...response.inputMessageIds, ...input.inputMessageIds],
    latestInputTimelineOrderAt: Math.max(
      response.latestInputTimelineOrderAt ?? 0,
      input.readAt,
      ...messages.slice(0, input.inputMessageIds.length).map(getTimelineOrderTime),
    ),
  });
  return { kind: 'prepared', lifecycles, replayed: false };
}
