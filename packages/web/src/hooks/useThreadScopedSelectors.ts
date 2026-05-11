/**
 * F173 Phase C — Thread-scoped selectors.
 *
 * Read-side components migrate from direct flat-state reads
 * (`useChatStore((s) => s.messages)` / `s.hasActiveInvocation`) to these
 * selectors so that:
 *
 *   1. Flat-vs-thread-scoped becomes a writer/mirror concern, not a reader
 *      concern. Phase A's mirror invariant guarantees consistency at write
 *      time; consumers never need to know whether they're reading flat or
 *      threadStates[tid].
 *   2. Phase C's hydration rewrite can swap the source (e.g. unify on
 *      `threadStates` and demote flat to a derived signal) without touching
 *      every consumer.
 *
 * Pure selector functions are exported for unit testing; React hooks wrap
 * them with `useChatStore` + `useShallow` to control re-renders.
 */
import { useShallow } from 'zustand/react/shallow';
import { getBubbleInvocationId } from '@/debug/bubbleIdentity';
import type { CatInvocationInfo, CatStatusType, ChatMessage } from '@/stores/chat-types';
import { type ChatState, useChatStore } from '@/stores/chatStore';

/** Inert defaults returned when threadId is null or has no entry. Frozen so
 *  callers can't accidentally mutate a shared singleton. */
const EMPTY_MESSAGES: readonly ChatMessage[] = Object.freeze([]);
const EMPTY_CAT_STATUSES: Readonly<Record<string, CatStatusType>> = Object.freeze({});
const EMPTY_ACTIVE_INVOCATIONS: Readonly<Record<string, { catId: string; mode: string; startedAt?: number }>> =
  Object.freeze({});
const EMPTY_TARGET_CATS: readonly string[] = Object.freeze([]);
const EMPTY_CAT_INVOCATIONS: Readonly<Record<string, CatInvocationInfo>> = Object.freeze({});

export interface ThreadLiveness {
  hasActive: boolean;
  catStatuses: Record<string, CatStatusType>;
  activeInvocations: Record<string, { catId: string; mode: string; startedAt?: number }>;
  catInvocations: Record<string, CatInvocationInfo>;
  intentMode: 'execute' | 'ideate' | null;
  targetCats: string[];
}

const DEFAULT_LIVENESS: ThreadLiveness = {
  hasActive: false,
  catStatuses: EMPTY_CAT_STATUSES as Record<string, CatStatusType>,
  activeInvocations: EMPTY_ACTIVE_INVOCATIONS as Record<string, { catId: string; mode: string; startedAt?: number }>,
  catInvocations: EMPTY_CAT_INVOCATIONS as Record<string, CatInvocationInfo>,
  intentMode: null,
  targetCats: EMPTY_TARGET_CATS as string[],
};

/** Deduplicate transient assistant messages that share the same (catId,
 *  invocationId) — but ONLY when the entire group is transient (all streaming
 *  or draft-prefixed). If any finalized message shares the key, no dedup runs
 *  for that group — it may be a legitimate A→B→A re-entry where the same cat
 *  speaks multiple times under one outer invocation. */
function deduplicateTransientMessages(messages: ChatMessage[]): ChatMessage[] {
  const isTransient = (m: ChatMessage) => m.isStreaming || m.id.startsWith('draft-');
  const keyOf = new Map<string, number[]>();
  let hasDup = false;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.type !== 'assistant' || !msg.catId) continue;
    const invId = getBubbleInvocationId(msg);
    if (!invId) continue;
    const key = `${msg.catId}:${invId}`;
    const arr = keyOf.get(key);
    if (arr) { arr.push(i); hasDup = true; } else { keyOf.set(key, [i]); }
  }
  if (!hasDup) return messages;
  const drop = new Set<number>();
  for (const indices of keyOf.values()) {
    if (indices.length < 2) continue;
    if (indices.some((i) => !isTransient(messages[i]!))) continue;
    let bestIdx = indices[0]!;
    let bestLen = 0;
    for (const idx of indices) {
      const m = messages[idx]!;
      const len = m.content.length + (m.thinking?.length ?? 0);
      if (len >= bestLen) { bestLen = len; bestIdx = idx; }
    }
    for (const idx of indices) { if (idx !== bestIdx) drop.add(idx); }
  }
  if (drop.size === 0) return messages;
  return messages.filter((_, i) => !drop.has(i));
}

/** Pure selector — returns the messages array for a thread, preferring the
 *  flat slice when threadId is current (to keep reference equality with the
 *  source-of-truth and avoid cross-thread dup). */
export function selectThreadMessages(state: ChatState, threadId: string | null): ChatMessage[] {
  if (!threadId) return EMPTY_MESSAGES as ChatMessage[];
  const raw =
    threadId === state.currentThreadId || !state.currentThreadId
      ? (state.messages ?? (EMPTY_MESSAGES as ChatMessage[]))
      : (state.threadStates?.[threadId]?.messages ?? (EMPTY_MESSAGES as ChatMessage[]));
  return deduplicateTransientMessages(raw);
}

/** Pure selector — returns liveness fields for a thread. Defensively
 *  falls back to inert defaults for any field the (test) state may have
 *  omitted. Production state from `useChatStore` always has all fields,
 *  but unit-test mocks routinely partial-init it; selector must not throw.
 *
 *  When the current-thread branch matches (or `currentThreadId` is missing
 *  in a partial test mock), reads the flat slice — this preserves the Phase
 *  A mirror invariant: flat is always a valid mirror of the current thread,
 *  so reading it for "the current thread" is identical to reading from
 *  threadStates. */
export function selectThreadLiveness(state: ChatState, threadId: string | null): ThreadLiveness {
  if (!threadId) return DEFAULT_LIVENESS;
  // Current-thread path. Also taken when `currentThreadId` is absent
  // (incomplete test mocks) — flat is the only authoritative source then.
  if (threadId === state.currentThreadId || !state.currentThreadId) {
    return {
      hasActive: state.hasActiveInvocation ?? false,
      catStatuses: state.catStatuses ?? DEFAULT_LIVENESS.catStatuses,
      activeInvocations: state.activeInvocations ?? DEFAULT_LIVENESS.activeInvocations,
      catInvocations: state.catInvocations ?? DEFAULT_LIVENESS.catInvocations,
      intentMode: state.intentMode ?? null,
      targetCats: state.targetCats ?? DEFAULT_LIVENESS.targetCats,
    };
  }
  const ts = state.threadStates?.[threadId];
  if (!ts) return DEFAULT_LIVENESS;
  return {
    hasActive: ts.hasActiveInvocation ?? false,
    catStatuses: ts.catStatuses ?? DEFAULT_LIVENESS.catStatuses,
    activeInvocations: ts.activeInvocations ?? DEFAULT_LIVENESS.activeInvocations,
    catInvocations: ts.catInvocations ?? DEFAULT_LIVENESS.catInvocations,
    intentMode: ts.intentMode ?? null,
    targetCats: ts.targetCats ?? DEFAULT_LIVENESS.targetCats,
  };
}

/** React hook — thread-scoped messages. Drop-in for `useChatStore((s) => s.messages)`
 *  but routes through threadStates for non-current threads. */
export function useThreadMessages(threadId: string | null): ChatMessage[] {
  return useChatStore((s) => selectThreadMessages(s, threadId));
}

/** React hook — thread-scoped liveness. Wrapped with `useShallow` because
 *  the selector returns a synthesized object on every call; without shallow
 *  every store mutation would rerender consumers even when liveness is
 *  unchanged. */
export function useThreadLiveness(threadId: string | null): ThreadLiveness {
  return useChatStore(useShallow((s) => selectThreadLiveness(s, threadId)));
}
