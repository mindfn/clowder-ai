import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const messages = [
  { id: 'u1', type: 'user', content: 'retry please', timestamp: 1 },
  { id: 's1', type: 'system', variant: 'error', content: 'authentication failed', timestamp: 2 },
  { id: 'c1', type: 'connector', content: 'connector diagnosis', timestamp: 3 },
  { id: 'a1', type: 'assistant', content: 'recovered', timestamp: 4 },
] as const;
const handleSend = vi.hoisted(() => vi.fn());
const fixture = vi.hoisted(() => ({ navigator: false, readonly: false, forwardingBlocked: false }));

vi.mock('@/hooks/useThreadScopedSelectors', () => ({
  useThreadMessages: () =>
    fixture.navigator
      ? [...messages, ...messages.slice(0, 2).map((message) => ({ ...message, id: `extra-${message.id}` }))]
      : messages,
  useThreadLiveness: () => ({
    hasActive: false,
    activeInvocations: {},
    catStatuses: {},
    catInvocations: {},
    intentMode: null,
    targetCats: [],
  }),
}));

vi.mock('@/hooks/useChatHistory', () => ({
  useChatHistory: () => ({
    handleScroll: vi.fn(),
    scrollContainerRef: { current: null },
    messagesEndRef: { current: null },
    isLoadingHistory: false,
    hasMore: false,
  }),
}));

vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: () => ({ handleSend, uploadStatus: 'idle', uploadError: null }),
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], getCatById: vi.fn() }),
}));

vi.mock('@/hooks/useConnectionStatus', () => ({
  useConnectionStatus: () => ({
    api: 'degraded',
    socket: 'online',
    upstream: 'online',
    isReadonly: fixture.readonly,
    checkedAt: 0,
    forwardingBlocked: fixture.forwardingBlocked,
    updateRequired: false,
  }),
}));

vi.mock('../ThreadChatRuntimeProvider', () => ({
  useThreadChatRuntime: () => ({ socketConnected: true }),
}));

vi.mock('../../ChatMessageRow', () => ({
  ChatMessageRow: ({
    message,
    sendContext,
    confirmations,
    onEnterSelection,
    forwardingDisabled,
  }: {
    message: (typeof messages)[number];
    sendContext?: string;
    confirmations?: unknown[];
    onEnterSelection?: (id: string) => void;
    forwardingDisabled?: boolean;
  }) => (
    <article
      data-thread-chat-message-id={message.id}
      data-thread-chat-message-type={message.type}
      data-thread-chat-message-variant={'variant' in message ? message.variant : ''}
      data-send-context={sendContext}
      data-confirmation-count={confirmations?.length ?? 0}
    >
      {message.content}
      <button type="button" aria-label={`select-${message.id}`} onClick={() => onEnterSelection?.(message.id)} />
      <button type="button" aria-label={`forward-${message.id}`} disabled={forwardingDisabled} />
    </article>
  ),
}));

vi.mock('../../ChatInput', () => ({
  ChatInput: ({
    threadId,
    composerContext,
    disabled,
  }: {
    threadId: string;
    composerContext?: ReactNode;
    disabled?: boolean;
  }) => (
    <>
      <textarea aria-label={`composer-${threadId}`} disabled={disabled} />
      {composerContext}
    </>
  ),
}));
vi.mock('../../ThreadComposerContext', () => ({
  ThreadComposerContext: ({ threadId }: { threadId: string }) => (
    <span data-testid="composer-context-thread">{threadId}</span>
  ),
}));

vi.mock('../../TransferTargetPicker', () => ({
  TransferTargetPicker: ({ open, admissionBlocked }: { open: boolean; admissionBlocked: boolean }) => (
    <output data-testid="forward-picker" data-open={String(open)} data-blocked={String(admissionBlocked)} />
  ),
}));

import type { CardConfirmationEntry } from '../../rich/CardBlock';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { ThreadChatSurface } from '../ThreadChatSurface';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellPresentation('classic');
  handleSend.mockClear();
  fixture.navigator = false;
  fixture.readonly = false;
  fixture.forwardingBlocked = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  writeShellPresentation('classic');
  vi.unstubAllGlobals();
});

function manifest(scope: Element): string[] {
  return Array.from(scope.querySelectorAll('[data-thread-chat-message-id]')).map((node) =>
    [
      node.getAttribute('data-thread-chat-message-id'),
      node.getAttribute('data-thread-chat-message-type'),
      node.getAttribute('data-thread-chat-message-variant'),
      node.textContent,
    ].join('|'),
  );
}

describe('ThreadChatSurface density contract', () => {
  it('keeps composition writable while blocking the message-row prop, selection toolbar and picker', async () => {
    fixture.forwardingBlocked = true;
    await act(async () => root.render(<ThreadChatSurface threadId="thread-guard" density="full" />));
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
    expect(container.querySelector('[data-testid="connection-status-bar"]')).not.toBeNull();
    expect(container.textContent).not.toContain('输入区已切换为只读');
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="forward-a1"]')?.disabled).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="select-a1"]')?.click());
    const forward = container.querySelector<HTMLButtonElement>('button[aria-label="转发"]');
    expect(forward).not.toBeNull();
    expect(forward?.disabled).toBe(true);
    fixture.forwardingBlocked = false;
    await act(async () => root.render(<ThreadChatSurface threadId="thread-guard" density="full" />));
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="转发"]')?.disabled).toBe(false);
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="转发"]')?.click());
    expect(container.querySelector('[data-testid="forward-picker"]')?.getAttribute('data-open')).toBe('true');
    fixture.forwardingBlocked = true;
    await act(async () => root.render(<ThreadChatSurface threadId="thread-guard" density="full" />));
    expect(container.querySelector('[data-testid="forward-picker"]')?.getAttribute('data-open')).toBe('false');
    expect(container.querySelector('[data-testid="forward-picker"]')?.getAttribute('data-blocked')).toBe('true');
  });

  it('passes readonly to the composer when the deployment is known to mismatch', async () => {
    fixture.readonly = true;
    fixture.forwardingBlocked = true;
    await act(async () => root.render(<ThreadChatSurface threadId="thread-guard" density="full" />));
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true);
    expect(container.textContent).toContain('输入区已切换为只读');
  });

  it('owns the v2 reading column while retaining message DOM in classic and compact views', async () => {
    writeShellPresentation('v2');
    await act(async () => root.render(<ThreadChatSurface threadId="thread-parity" density="full" />));
    const row = container.querySelector('[data-thread-chat-message-id="a1"]');
    const column = row?.closest('[data-thread-chat-reading-column]');
    expect(column?.classList.contains('max-w-[720px]')).toBe(true);
    expect(column?.classList.contains('mx-auto')).toBe(true);
    act(() => writeShellPresentation('classic'));
    expect(container.querySelector('[data-thread-chat-message-id="a1"]')).toBe(row);
    expect(column?.className).toBe('');
    act(() => writeShellPresentation('v2'));
    await act(async () => root.render(<ThreadChatSurface threadId="thread-parity" density="compact" />));
    expect(container.querySelector('[data-thread-chat-message-id="a1"]')).toBe(row);
    expect(column?.className).toBe('');
  });
  it('wires the same conversation controls in full, compact and composer-only hosts, while classic keeps the header controls', async () => {
    writeShellPresentation('v2');
    for (const density of ['full', 'compact'] as const) {
      await act(async () => root.render(<ThreadChatSurface threadId="thread-parity" density={density} />));
      expect(container.querySelector('[data-testid="composer-context-thread"]')?.textContent).toBe('thread-parity');
    }
    const composer = container.querySelector('textarea');
    await act(async () =>
      root.render(<ThreadChatSurface threadId="thread-parity" density="compact" presentation="composer-only" />),
    );
    expect(container.querySelector('[data-testid="composer-context-thread"]')?.textContent).toBe('thread-parity');
    expect(container.querySelector('textarea')).toBe(composer);
    act(() => writeShellPresentation('classic'));
    expect(container.querySelector('[data-testid="composer-context-thread"]')).toBeNull();
    expect(container.querySelector('textarea')).toBe(composer);
  });
  it('hides the live reader navigation in composer-only presentation while preserving its message and composer nodes', async () => {
    fixture.navigator = true;
    await act(async () => root.render(<ThreadChatSurface threadId="thread-parity" density="full" />));
    expect(container.querySelector('[data-message-navigator]')).not.toBeNull();
    const message = container.querySelector('[data-thread-chat-message-id="u1"]');
    const composer = container.querySelector('textarea');
    await act(async () =>
      root.render(<ThreadChatSurface threadId="thread-parity" density="full" presentation="composer-only" />),
    );
    expect(container.querySelector('[data-message-navigator]')).toBeNull();
    expect(container.querySelector('[data-thread-chat-message-id="u1"]')).toBe(message);
    expect(container.querySelector('textarea')).toBe(composer);
    await act(async () => root.render(<ThreadChatSurface threadId="thread-parity" density="full" />));
    expect(container.querySelector('[data-message-navigator]')).not.toBeNull();
    expect(container.querySelector('[data-thread-chat-message-id="u1"]')).toBe(message);
  });

  it('keeps one mounted conversation surface and canonical composer when history becomes inert', async () => {
    await act(async () => {
      root.render(<ThreadChatSurface threadId="thread-parity" density="full" presentation="composer-only" />);
    });

    const surface = container.querySelector('[data-thread-chat-surface]');
    const history = container.querySelector('[data-thread-chat-history]');
    const firstMessage = container.querySelector('[data-thread-chat-message-id="u1"]');
    expect(history?.getAttribute('aria-hidden')).toBe('true');
    expect(history?.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('textarea[aria-label="composer-thread-parity"]')).not.toBeNull();

    await act(async () => {
      root.render(<ThreadChatSurface threadId="thread-parity" density="full" presentation="conversation" />);
    });
    expect(container.querySelector('[data-thread-chat-surface]')).toBe(surface);
    expect(container.querySelector('[data-thread-chat-message-id="u1"]')).toBe(firstMessage);
    expect(container.querySelector('[data-thread-chat-history]')?.hasAttribute('inert')).toBe(false);
  });

  it('keeps the complete semantic message manifest and composer in both densities', async () => {
    const messageConfirmations = new Map<string, CardConfirmationEntry[]>([
      ['a1', [{ id: 'confirmation-1', messageId: 'a1', status: 'confirmed', action: { kind: 'confirm' } }]],
    ]);
    await act(async () => {
      root.render(
        <div>
          <section data-density-host="full">
            <ThreadChatSurface threadId="thread-parity" density="full" messageConfirmations={messageConfirmations} />
          </section>
          <section data-density-host="compact">
            <ThreadChatSurface threadId="thread-parity" density="compact" messageConfirmations={messageConfirmations} />
          </section>
        </div>,
      );
    });

    const full = container.querySelector('[data-density-host="full"]');
    const compact = container.querySelector('[data-density-host="compact"]');
    if (!full || !compact) throw new Error('both density hosts must render');
    expect(manifest(full)).toEqual(manifest(compact));
    expect(manifest(compact)).toEqual([
      'u1|user||retry please',
      's1|system|error|authentication failed',
      'c1|connector||connector diagnosis',
      'a1|assistant||recovered',
    ]);
    expect(full?.querySelector('textarea[aria-label="composer-thread-parity"]')).not.toBeNull();
    expect(compact?.querySelector('textarea[aria-label="composer-thread-parity"]')).not.toBeNull();
    expect(full.querySelector('[data-thread-chat-message-id="a1"]')?.getAttribute('data-confirmation-count')).toBe('1');
    expect(compact.querySelector('[data-thread-chat-message-id="a1"]')?.getAttribute('data-confirmation-count')).toBe(
      '1',
    );
  });

  it('routes an interactive rich action only through the surface that rendered it', async () => {
    await act(async () => {
      root.render(
        <div>
          <section data-density-host="full">
            <ThreadChatSurface threadId="thread-parity" density="full" />
          </section>
          <section data-density-host="compact">
            <ThreadChatSurface threadId="thread-parity" density="compact" />
          </section>
        </div>,
      );
    });

    const compactContext = container
      .querySelector('[data-density-host="compact"] [data-send-context]')
      ?.getAttribute('data-send-context');
    expect(compactContext).toBeTruthy();

    act(() => {
      window.dispatchEvent(
        new CustomEvent('cat-cafe:interactive-send', {
          detail: { text: '确认', sendContext: compactContext },
        }),
      );
    });

    expect(handleSend).toHaveBeenCalledOnce();
    expect(handleSend).toHaveBeenCalledWith('确认');
  });

  it('admits a legacy unscoped command only through the matching full surface', async () => {
    await act(async () => {
      root.render(
        <div>
          <ThreadChatSurface threadId="thread-parity" density="full" acceptUnscopedInteractiveSend />
          <ThreadChatSurface threadId="thread-parity" density="compact" />
        </div>,
      );
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent('cat-cafe:interactive-send', {
          detail: { text: '投票通知', targetThreadId: 'thread-other' },
        }),
      );
    });
    expect(handleSend).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(
        new CustomEvent('cat-cafe:interactive-send', {
          detail: { text: '投票通知', targetThreadId: 'thread-parity' },
        }),
      );
    });
    expect(handleSend).toHaveBeenCalledOnce();
    expect(handleSend).toHaveBeenCalledWith('投票通知');
  });
});
