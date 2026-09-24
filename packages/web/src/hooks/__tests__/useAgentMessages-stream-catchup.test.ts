import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentMessages } from '@/hooks/useAgentMessages';

type TestMessage = {
  id: string;
  type: string;
  catId?: string;
  content: string;
  isStreaming?: boolean;
  timestamp: number;
};

const mockAddMessage = vi.fn();
const mockSetLoading = vi.fn();
const mockSetHasActiveInvocation = vi.fn();
const mockRemoveActiveInvocation = vi.fn((invocationId: string) => {
  delete storeState.activeInvocations[invocationId];
});
const mockSetIntentMode = vi.fn();
const mockSetCatStatus = vi.fn();
const mockClearCatStatuses = vi.fn();
const mockClearAllActiveInvocations = vi.fn();
const mockSetCatInvocation = vi.fn();
const mockRequestStreamCatchUp = vi.fn();

const mockAddMessageToThread = vi.fn();
const mockClearThreadActiveInvocation = vi.fn();
const mockResetThreadInvocationState = vi.fn();
const mockSetThreadMessageStreaming = vi.fn();
const mockGetThreadState = vi.fn((): { messages: TestMessage[] } => ({ messages: [] }));

const storeState = {
  messages: [] as TestMessage[],
  activeInvocations: {} as Record<string, { catId: string }>,
  addMessage: mockAddMessage,
  setLoading: mockSetLoading,
  setHasActiveInvocation: mockSetHasActiveInvocation,
  removeActiveInvocation: mockRemoveActiveInvocation,
  clearAllActiveInvocations: mockClearAllActiveInvocations,
  setIntentMode: mockSetIntentMode,
  setCatStatus: mockSetCatStatus,
  clearCatStatuses: mockClearCatStatuses,
  setCatInvocation: mockSetCatInvocation,
  requestStreamCatchUp: mockRequestStreamCatchUp,

  addMessageToThread: mockAddMessageToThread,
  clearThreadActiveInvocation: mockClearThreadActiveInvocation,
  resetThreadInvocationState: mockResetThreadInvocationState,
  setThreadMessageStreaming: mockSetThreadMessageStreaming,
  getThreadState: mockGetThreadState,
  currentThreadId: 'thread-1',
};

let captured: ReturnType<typeof useAgentMessages> | undefined;

vi.mock('@/stores/chatStore', () => {
  const useChatStoreMock = Object.assign(() => storeState, { getState: () => storeState });
  return {
    useChatStore: useChatStoreMock,
  };
});

function Harness() {
  captured = useAgentMessages();
  return null;
}

describe('useAgentMessages stream catch-up (Bug C safety net)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    captured = undefined;
    storeState.messages = [];
    storeState.activeInvocations = {};
    storeState.currentThreadId = 'thread-1';
    mockAddMessage.mockClear();
    mockSetLoading.mockClear();
    mockSetHasActiveInvocation.mockClear();
    mockRemoveActiveInvocation.mockClear();
    mockSetIntentMode.mockClear();
    mockSetCatStatus.mockClear();
    mockClearCatStatuses.mockClear();
    mockClearAllActiveInvocations.mockClear();
    mockSetCatInvocation.mockClear();
    mockRequestStreamCatchUp.mockClear();

    mockAddMessageToThread.mockClear();
    mockClearThreadActiveInvocation.mockClear();
    mockResetThreadInvocationState.mockClear();
    mockSetThreadMessageStreaming.mockClear();
    mockGetThreadState.mockClear();
    mockGetThreadState.mockImplementation(() => ({ messages: [] }));
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it('requests catch-up when the active thread times out before done(isFinal)', () => {
    vi.useFakeTimers();

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.resetTimeout();
    });

    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000);
    });

    expect(mockRequestStreamCatchUp).toHaveBeenCalledWith('thread-1');
  });

  it('requests catch-up when a background thread times out before done(isFinal)', () => {
    vi.useFakeTimers();
    mockGetThreadState.mockImplementation(() => ({
      messages: [
        {
          id: 'assistant-bg',
          type: 'assistant',
          catId: 'opus',
          content: 'still running',
          isStreaming: true,
          timestamp: Date.now(),
        },
      ],
    }));

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.resetTimeout();
    });

    storeState.currentThreadId = 'thread-2';

    act(() => {
      vi.advanceTimersByTime(5 * 60 * 1000);
    });

    expect(mockRequestStreamCatchUp).toHaveBeenCalledWith('thread-1');
  });
});
