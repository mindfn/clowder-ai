import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplayChatMessage } from '@/lib/story-player/replay-chat-bridge';
import { ReplayMessageList } from '../ReplayMessageList';

const codexCat = {
  id: 'codex',
  displayName: '缅因猫',
  variantLabel: 'GPT-5.5',
  color: { primary: '#7c3aed', secondary: '#ede9fe' },
  mentionPatterns: ['@codex'],
  clientId: 'openai',
  defaultModel: 'gpt-5.5',
  avatar: '',
  roleDescription: '',
  personality: '',
};

vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { displayName: string; variantLabel?: string }) =>
    cat.variantLabel ? `${cat.displayName}（${cat.variantLabel}）` : cat.displayName,
  useCatData: () => ({
    cats: [codexCat],
    getCatById: (id: string) => (id === codexCat.id ? codexCat : undefined),
  }),
}));

describe('ReplayMessageList chat bubble styling', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders assistant replay messages through the normal ChatMessage appearance contract', () => {
    const message: ReplayChatMessage = {
      id: 'replay_codex_1',
      type: 'assistant',
      catId: 'codex',
      content: '这是一条回放消息',
      timestamp: 1710000000000,
      isStreaming: false,
    };

    act(() => {
      root.render(<ReplayMessageList messages={[message]} autoScroll={false} />);
    });
    const html = container.innerHTML;

    expect(html).toContain('缅因猫（GPT-5.5）');
    expect(html).toMatch(/background-color:\s*var\(--color-codex-surface\)/);
    expect(html).toMatch(/color:\s*var\(--cat-msg-text\)/);
    expect(html).not.toContain('--cat-msg-bg');
  });
});
