/**
 * F309 entry 21: a just-sent image must open as a publication without a reload. The local preview
 * uses a `blob:` URL and the client clock; the send receipt carries the stored `/uploads/...` blocks
 * and the stored time, and the hook settles its copy into them.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.fn();
const mockAddMessageToThread = vi.fn();
const mockReplaceThreadMessageId = vi.fn();
const mockPatchThreadMessage = vi.fn();
const mockRevokeObjectURL = vi.fn();

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/hooks/useAgentMessages', () => ({
  useAgentMessages: () => ({ resetRefs: vi.fn() }),
}));

vi.mock('@/hooks/useChatCommands', () => ({
  useChatCommands: () => ({ processCommand: vi.fn(async () => false) }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    () => ({
      addMessageToThread: mockAddMessageToThread,
      removeThreadMessage: vi.fn(),
      replaceThreadMessageId: mockReplaceThreadMessageId,
      patchThreadMessage: mockPatchThreadMessage,
      setThreadLoading: vi.fn(),
      setThreadHasActiveInvocation: vi.fn(),
    }),
    { getState: () => ({ currentThreadId: 'thread-1', replyToMessage: null }) },
  ),
}));

import { registerComposerDraftConsumption } from '@/components/composer-draft-consumption';
import { registerComposerDraftObserver } from '@/components/composer-draft-flush-registry';
import { useSendMessage } from '@/hooks/useSendMessage';

type Send = ReturnType<typeof useSendMessage>['handleSend'];

const storedBlocks = [
  { type: 'text', text: '看图' },
  { type: 'image', url: '/uploads/1790000000000-abcd1234.png' },
];

function respond(body: unknown) {
  mockApiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => body });
}

describe('useSendMessage settles a sent message into its stored receipt', () => {
  let container: HTMLDivElement;
  let root: Root;
  let send: Send;
  let createObjectURL: typeof URL.createObjectURL;
  let revokeObjectURL: typeof URL.revokeObjectURL;

  function Harness() {
    send = useSendMessage('thread-1').handleSend;
    return null;
  }

  const image = () => new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' });

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    createObjectURL = URL.createObjectURL;
    revokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:local-preview', writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: mockRevokeObjectURL, writable: true });
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, writable: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(React.createElement(Harness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('replaces the local preview URL and client time with the stored ones', async () => {
    respond({
      status: 'processing',
      userMessageId: 'msg-1',
      userMessage: { id: 'msg-1', timestamp: 1790000000123, contentBlocks: storedBlocks },
    });

    await act(async () => {
      await send('看图', [image()]);
    });

    const optimistic = mockAddMessageToThread.mock.calls[0]?.[1];
    expect(optimistic.contentBlocks).toContainEqual({ type: 'image', url: 'blob:local-preview' });
    expect(mockReplaceThreadMessageId).toHaveBeenCalledWith('thread-1', optimistic.id, 'msg-1');
    expect(mockPatchThreadMessage).toHaveBeenCalledWith('thread-1', 'msg-1', {
      timestamp: 1790000000123,
      contentBlocks: storedBlocks,
    });
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:local-preview');
  });

  it('publishes an explicitly queued message with the stored blocks and time', async () => {
    respond({
      status: 'queued',
      userMessageId: 'msg-2',
      userMessage: { id: 'msg-2', timestamp: 1790000000456, contentBlocks: storedBlocks },
    });

    await act(async () => {
      await send('看图', [image()], undefined, undefined, 'queue');
    });

    expect(mockAddMessageToThread).toHaveBeenCalledTimes(1);
    expect(mockAddMessageToThread.mock.calls[0]?.[1]).toMatchObject({
      id: 'msg-2',
      timestamp: 1790000000456,
      contentBlocks: storedBlocks,
    });
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:local-preview');
  });

  it('keeps the local preview when the receipt does not describe this message', async () => {
    respond({ status: 'processing', userMessageId: 'msg-3' });

    await act(async () => {
      await send('看图', [image()]);
    });

    expect(mockReplaceThreadMessageId).toHaveBeenCalledTimes(1);
    expect(mockPatchThreadMessage).not.toHaveBeenCalled();
    expect(mockRevokeObjectURL).not.toHaveBeenCalled();
  });

  it('publishes the server consumption to this mounted thread before returning its accepted admission', async () => {
    const consume = vi.fn();
    const release = registerComposerDraftConsumption('thread-1', consume);
    const receipt = { threadId: 'thread-1', expectedRevision: 69, revision: 70 };
    try {
      respond({ status: 'processing', userMessageId: 'msg-consumed', composerDraftConsumption: receipt });
      await act(async () => {
        expect(await send('已接受')).toBe(true);
        expect(consume).toHaveBeenCalledWith(receipt);
      });
      consume.mockClear();
      respond({
        status: 'processing',
        userMessageId: 'msg-foreign',
        composerDraftConsumption: { ...receipt, threadId: 'other-thread' },
      });
      await act(async () => {
        await send('同页再发送');
      });
      expect(consume).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('carries the mounted composer revision in a send with images', async () => {
    const release = registerComposerDraftObserver('thread-1', () => ({ text: '看图', revision: 3, ready: true }));
    try {
      respond({ status: 'processing', userMessageId: 'image-message' });
      await act(async () => {
        await send('看图', [image()], undefined, undefined, undefined, undefined, undefined, undefined, {
          consumeComposerDraft: true,
        });
      });
      const form = mockApiFetch.mock.calls[0]?.[1]?.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expect(form.get('composerDraftRevision')).toBe('3');
      expect(form.get('threadId')).toBe('thread-1');
      expect(form.getAll('images')).toHaveLength(1);
    } finally {
      release();
    }
  });
});
