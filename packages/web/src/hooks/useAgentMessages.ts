'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import type { ActiveContext, OpenThreadRows, TimeoutDiagnosticsStash } from './agent-messages/active-context';
import { handleActiveAgentMessage } from './agent-messages/active-handler';
import { handleBackgroundAgentMessage } from './agent-messages/background-handler';
import { processThreadSeq } from './agent-messages/thread-seq';
import type { AgentMsg } from './agent-messages/types';
import { reconcileTimedOutInvocations } from './invocation-timeout-reconciliation';

export { consumeBackgroundSystemInfo, handleBackgroundAgentMessage } from './agent-messages/background-handler';
export { processThreadSeq, type ThreadSeqAction } from './agent-messages/thread-seq';
export type {
  AgentMsg,
  BackgroundAgentMessage,
  BackgroundStoreLike,
  BackgroundToastInput,
  HandleBackgroundMessageOptions,
} from './agent-messages/types';

/** Timeout for done(isFinal): this much silence hands the thread to timeout reconciliation. */
const DONE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Socket `agent_message` dispatch for every thread (F173 KD-1). The open thread and background
 * threads keep separate entries; both write each event only into the message it names
 * (`named-message-writer`) — no client-side bubble identity exists.
 *
 * Returns:
 * - handleAgentMessage: socket event handler
 * - resetTimeout / clearDoneTimeout: done-timeout watchdog
 */
export function useAgentMessages() {
  const resolveCatName = useCatNameResolver();
  const actions = useChatStore(
    useShallow((s) => ({
      addMessage: s.addMessage,
      patchMessage: s.patchMessage,
      removeMessage: s.removeMessage,
      setLoading: s.setLoading,
      setHasActiveInvocation: s.setHasActiveInvocation,
      addActiveInvocation: s.addActiveInvocation,
      removeActiveInvocation: s.removeActiveInvocation,
      setIntentMode: s.setIntentMode,
      setCatStatus: s.setCatStatus,
      clearCatStatuses: s.clearCatStatuses,
      setCatInvocation: s.setCatInvocation,
      replaceThreadTargetCats: s.replaceThreadTargetCats,
    })),
  );

  // Open-thread system rows use the flat writers. Every caller runs synchronously behind the
  // open-thread dispatch gate in handleAgentMessage, so the flat list is the event's thread.
  const rows = useMemo<OpenThreadRows>(
    () => ({
      rows: () => useChatStore.getState().messages,
      addRow: actions.addMessage,
      patchRow: actions.patchMessage,
      removeRow: actions.removeMessage,
    }),
    [actions],
  );

  /** Counter for ids of background rows and tool events (never message identity). */
  const bgSeqRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Which thread the current timeout guard belongs to. */
  const timeoutThreadRef = useRef<string | null>(null);
  const timeoutDiagnosticsRef = useRef(new Map<string, Record<string, unknown>>());

  /** Start or restart the done-timeout watchdog for the open thread. */
  const resetTimeout = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    const timeoutThreadId = useChatStore.getState().currentThreadId;
    timeoutThreadRef.current = timeoutThreadId;
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      timeoutThreadRef.current = null;
      if (timeoutThreadId) void reconcileTimedOutInvocations(timeoutThreadId);
    }, DONE_TIMEOUT_MS);
  }, []);

  /** Clear the watchdog (done/error isFinal); a background thread's completion clears only its own. */
  const clearDoneTimeout = useCallback((threadId?: string) => {
    if (threadId && timeoutThreadRef.current && timeoutThreadRef.current !== threadId) return;
    if (!timeoutRef.current) return;
    clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    timeoutThreadRef.current = null;
  }, []);

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      timeoutThreadRef.current = null;
    },
    [],
  );

  const timeoutDiagnostics = useMemo<TimeoutDiagnosticsStash>(
    () => ({
      set: (threadId, catId, diagnostics) => {
        timeoutDiagnosticsRef.current.set(`${threadId}::${catId}`, diagnostics);
      },
      take: (threadId, catId) => {
        const key = `${threadId}::${catId}`;
        const diagnostics = timeoutDiagnosticsRef.current.get(key) ?? null;
        timeoutDiagnosticsRef.current.delete(key);
        return diagnostics;
      },
    }),
    [],
  );

  const handleAgentMessage = useCallback(
    (msg: AgentMsg) => {
      const store = useChatStore.getState();
      const isOpenThread = Boolean(msg.threadId && store.currentThreadId && msg.threadId === store.currentThreadId);
      // F183 Phase C: sequence gaps request a history catch-up before any dispatch.
      processThreadSeq(msg, store);

      if (msg.threadId && !isOpenThread) {
        handleBackgroundAgentMessage(
          { ...msg, threadId: msg.threadId, timestamp: msg.timestamp ?? Date.now() },
          {
            store,
            nextBgSeq: () => bgSeqRef.current++,
            addToast: (toast) => useToastStore.getState().addToast(toast),
            resolveCatName,
            clearDoneTimeout,
          },
        );
        return;
      }

      // Any open-thread event (or a legacy event without threadId) keeps the watchdog alive.
      resetTimeout();
      const ctx: ActiveContext = { actions, rows, resolveCatName, clearDoneTimeout, timeoutDiagnostics };
      handleActiveAgentMessage(msg, ctx);
    },
    [actions, rows, resolveCatName, resetTimeout, clearDoneTimeout, timeoutDiagnostics],
  );

  return { handleAgentMessage, resetTimeout, clearDoneTimeout };
}
