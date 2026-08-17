import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({
    state: 'idle',
    transcript: '',
    partialTranscript: '',
    error: null,
    duration: 0,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
  }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: () => ({
    targetCats: ['codex', 'gemini'],
    catStatuses: { codex: 'streaming', gemini: 'pending' },
    catInvocations: {},
  }),
}));

import { ChatInputActionButton } from '@/components/ChatInputActionButton';

describe('Stop event payload regression', () => {
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
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('ChatInputActionButton stop click passes typed control and gesture provenance', () => {
    const onStop = vi.fn();

    act(() => {
      root.render(
        React.createElement(ChatInputActionButton, {
          onTranscript: vi.fn(),
          onSend: vi.fn(),
          onStop,
          disabled: true,
          hasActiveInvocation: true,
          hasText: false,
        }),
      );
    });

    const stopBtn = container.querySelector('button[aria-label="Stop generation"]');
    expect(stopBtn).toBeTruthy();

    act(() => {
      stopBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop.mock.calls[0]).toEqual([
      {
        sourceControl: 'chat_input_action',
        gesture: 'pointer',
        trustedGesture: false,
      },
    ]);
  });

  it('ParallelStatusBar remains diagnostic instead of duplicating whole-thread Stop', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const source = await readFile(join(import.meta.dirname, '..', 'ParallelStatusBar.tsx'), 'utf-8');

    expect(source).not.toContain('parallel-stop-button');
    expect(source).not.toContain("'parallel_status_bar'");
  });
});
