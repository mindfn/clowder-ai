import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as Message } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ChatMessage } from '../ChatMessage';

vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: vi.fn(async () => new Response('{}')) }));

describe('actual response renders one failure with folded diagnostics', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeAll(() => Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true }));
  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    primeCoCreatorConfigCache({ name: 'lang', aliases: [], mentionPatterns: [] });
    useChatStore.setState({ currentThreadId: 'thread', messages: [], threads: [], isLoadingThreads: false });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetCoCreatorConfigCacheForTest();
  });

  // Unknown provider reason codes can arrive over the wire; exercise that boundary too.
  const cli = (reasonCode: string): NonNullable<Message['extra']> =>
    JSON.parse(
      JSON.stringify({
        cliDiagnostics: {
          reasonCode,
          publicSummary: 'provider exit cause',
          publicHint: 'check credentials',
          debugRef: { command: 'codex', exitCode: 1, signal: null, invocationId: 'turn' },
        },
      }),
    );
  const timeout = { timeoutDiagnostics: { silenceDurationMs: 1846576, processAlive: true, invocationId: 'turn' } };
  it.each([
    ['classified CLI', cli('auth_failed'), 'cli'],
    ['unknown CLI', cli('future_reason'), 'cli'],
    ['timeout', timeout, 'timeout'],
  ] as const)('%s preserves details while the response owns the failure', (_name, extra, kind) => {
    const message: Message = {
      id: 'response',
      type: 'assistant',
      catId: 'opus',
      content: '',
      timestamp: 1,
      extra,
      lifecycle: {
        kind: 'response',
        orderKey: '1:response',
        invocationId: 'turn',
        targetId: 'opus',
        inputEntryIds: ['entry'],
        inputMessageIds: ['source'],
        status: 'failed',
        startedAt: 1,
        completedAt: 2,
      },
    };
    act(() => root.render(<ChatMessage message={message} threadId="thread" getCatById={() => undefined} />));
    expect(container.textContent?.match(/回复失败/g)).toHaveLength(1);
    expect(container.querySelector('[data-testid="cli-diagnostics-banner"]')).toBeNull();
    expect(container.querySelector('[data-testid="diagnostics-panel"]')).toBeNull();
    const toggle = container.querySelector(
      `[data-testid="${kind === 'cli' ? 'cli-diagnostics-toggle' : 'diagnostics-toggle'}"]`,
    ) as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    act(() => toggle.click());
    expect(container.textContent).toContain('turn');
    if (kind === 'cli') {
      expect(container.textContent).toContain('provider exit cause');
      expect(container.textContent).toContain('check credentials');
    } else expect(container.textContent).toContain('1846576ms');
    expect(container.textContent?.match(/回复失败/g)).toHaveLength(1);
  });

  it('a standalone admission failure still shows its only error banner', () => {
    const message: Message = {
      id: 'admission-failure',
      type: 'system',
      variant: 'error',
      catId: 'opus',
      content: 'admission rejected',
      timestamp: 1,
      extra: cli('auth_failed'),
    };
    act(() => root.render(<ChatMessage message={message} threadId="thread" getCatById={() => undefined} />));
    expect(container.querySelector('[data-testid="cli-diagnostics-banner"]')?.textContent).toContain(
      'provider exit cause',
    );
  });
});
