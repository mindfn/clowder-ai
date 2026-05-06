/**
 * Regression tests for background-thread recoverable error + pending callback
 * interaction (#650, PR #623 review).
 *
 * Covers:
 * 1. Recoverable error (upstream_error/tool_error) preserves pending callback
 * 2. Subsequent done drains the preserved callback
 * 3. Non-recoverable error clears pending callback
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configureDebug } from '@/debug/invocationEventDebug';
import type { ChatMessagePatch } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { resetSharedReplacedInvocations } from '../shared-replaced-invocations';
import { type BackgroundAgentMessage, handleBackgroundAgentMessage } from '../useAgentMessages';

let testBgSeq = 0;
const testBgStreamRefs = new Map<string, { id: string; threadId: string; catId: string }>();
const testBgFinalizedRefs = new Map<string, string>();
const testPendingCallbacks = new Map<string, { bubbleId: string; patch: ChatMessagePatch; threadId: string }>();
let clearDoneTimeoutCalls: string[] = [];

function simulateBgMsg(msg: BackgroundAgentMessage) {
  handleBackgroundAgentMessage(msg, {
    store: useChatStore.getState(),
    bgStreamRefs: testBgStreamRefs,
    finalizedBgRefs: testBgFinalizedRefs,
    nextBgSeq: () => testBgSeq++,
    addToast: (toast) => useToastStore.getState().addToast(toast),
    clearDoneTimeout: (threadId) => {
      if (threadId) clearDoneTimeoutCalls.push(threadId);
    },
    pendingCallbacks: testPendingCallbacks,
  });
}

const THREAD = 'thread-bg';
const CAT = 'opus';
const INV = 'inv-123';
const PENDING_KEY = `${CAT}:${INV}`;

describe('background recoverable error + pending callback (#650)', () => {
  beforeEach(() => {
    configureDebug({ enabled: false });
    useChatStore.setState({
      messages: [],
      isLoading: false,
      isLoadingHistory: false,
      hasMore: true,
      hasActiveInvocation: false,
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},
      currentGame: null,
      threadStates: {},
      viewMode: 'single',
      splitPaneThreadIds: [],
      splitPaneTargetId: null,
      currentThreadId: 'thread-active',
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
    });
    useToastStore.setState({ toasts: [] });
    testBgSeq = 0;
    testBgStreamRefs.clear();
    testBgFinalizedRefs.clear();
    testPendingCallbacks.clear();
    resetSharedReplacedInvocations();
    clearDoneTimeoutCalls = [];
  });

  function seedPendingCallback() {
    useChatStore.getState().addMessageToThread(THREAD, {
      id: 'bubble-1',
      type: 'assistant',
      catId: CAT,
      content: 'streaming...',
      timestamp: Date.now(),
      isStreaming: true,
      origin: 'stream',
      extra: { stream: { invocationId: INV } },
    });
    testPendingCallbacks.set(PENDING_KEY, {
      bubbleId: 'bubble-1',
      patch: { content: 'authoritative callback content', isStreaming: false, origin: 'callback' },
      threadId: THREAD,
    });
    useChatStore.getState().addThreadActiveInvocation(THREAD, INV, CAT, 'execute');
  }

  it('recoverable upstream_error preserves pending callback', () => {
    seedPendingCallback();

    simulateBgMsg({
      type: 'error',
      catId: CAT,
      threadId: THREAD,
      invocationId: INV,
      error: 'upstream provider timeout',
      errorCode: 'upstream_error',
      timestamp: Date.now(),
    });

    expect(testPendingCallbacks.has(PENDING_KEY)).toBe(true);
  });

  it('recoverable tool_error preserves pending callback', () => {
    seedPendingCallback();

    simulateBgMsg({
      type: 'error',
      catId: CAT,
      threadId: THREAD,
      invocationId: INV,
      error: 'tool execution failed',
      errorCode: 'tool_error',
      timestamp: Date.now(),
    });

    expect(testPendingCallbacks.has(PENDING_KEY)).toBe(true);
  });

  it('done after recoverable error drains and applies the preserved callback', () => {
    seedPendingCallback();

    simulateBgMsg({
      type: 'error',
      catId: CAT,
      threadId: THREAD,
      invocationId: INV,
      error: 'transient failure',
      errorCode: 'upstream_error',
      timestamp: Date.now(),
    });
    expect(testPendingCallbacks.has(PENDING_KEY)).toBe(true);

    simulateBgMsg({
      type: 'done',
      catId: CAT,
      threadId: THREAD,
      invocationId: INV,
      timestamp: Date.now(),
    });

    expect(testPendingCallbacks.has(PENDING_KEY)).toBe(false);
    const msgs = useChatStore.getState().getThreadState(THREAD).messages;
    const bubble = msgs.find((m) => m.id === 'bubble-1');
    expect(bubble?.content).toBe('authoritative callback content');
    expect(bubble?.origin).toBe('callback');
    expect(bubble?.isStreaming).toBe(false);
  });

  it('non-recoverable error clears pending callback', () => {
    seedPendingCallback();

    simulateBgMsg({
      type: 'error',
      catId: CAT,
      threadId: THREAD,
      invocationId: INV,
      error: 'fatal crash',
      timestamp: Date.now(),
    });

    expect(testPendingCallbacks.has(PENDING_KEY)).toBe(false);
  });

  it('final error (isFinal=true) clears pending callback', () => {
    seedPendingCallback();

    simulateBgMsg({
      type: 'error',
      catId: CAT,
      threadId: THREAD,
      invocationId: INV,
      error: 'invocation terminated',
      errorCode: 'upstream_error',
      isFinal: true,
      timestamp: Date.now(),
    });

    expect(testPendingCallbacks.has(PENDING_KEY)).toBe(false);
  });
});
