import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as Message } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ChatMessage } from '../ChatMessage';
import { freshnessNoticeCopy } from '../freshness-notice.shell-copy';
import { checkShellCopyParity } from '../shell/__tests__/shell-copy-parity-check';
import { writeShellLanguage } from '../shell/shell-language';
import { writeShellPresentation } from '../shell/shell-presentation';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(() => new Promise(() => undefined)) }));

const original: Message = {
  id: 'published-answer',
  type: 'assistant',
  catId: 'codex-astra',
  content: 'The original answer remains available.',
  timestamp: 1,
  extra: {
    freshnessSupplement: {
      type: 'freshness_supplement',
      supplementId: 'f254-supplement:published-answer:1',
      lineageId: 'published-answer',
      originalMessageId: 'published-answer',
      threadId: 'thread-failure',
      catId: 'codex-astra',
      seq: 1,
      status: 'failed',
      requiredCount: 1,
      terminalReason: 'read_only_policy_unavailable',
      updatedAt: 2,
    },
  },
};
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetCoCreatorConfigCacheForTest();
  primeCoCreatorConfigCache({ name: 'You', aliases: [], mentionPatterns: ['@co-creator'] });
  useChatStore.setState({ currentThreadId: 'thread-failure', messages: [original], threads: [] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.localStorage.clear();
  resetCoCreatorConfigCacheForTest();
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it.each([
  'zh',
  'en',
] as const)('shows the failed step and readable reason in %s without hover or tool expansion', (language) => {
  writeShellPresentation('v2');
  writeShellLanguage(language);
  // This is the canonical history payload, not an ephemeral error event.
  const hydrated = JSON.parse(JSON.stringify(original)) as Message;
  act(() => root.render(<ChatMessage message={hydrated} getCatById={() => undefined} />));
  const notice = host.querySelector('[data-testid="freshness-supplement-status"]');
  expect(notice?.getAttribute('role')).toBe('alert');
  expect(notice?.textContent).toContain(language === 'zh' ? '新消息补读失败' : 'New-message check failed');
  expect(notice?.textContent).toContain(
    language === 'zh' ? '不支持安全的只读检查' : 'cannot enforce a read-only check',
  );
  expect(notice?.textContent).not.toContain('read_only_policy_unavailable');
  expect(host.textContent).toContain(original.content);
});

it('keeps the failure visible after a mounted language change and a fresh history render', () => {
  writeShellPresentation('v2');
  writeShellLanguage('zh');
  act(() => root.render(<ChatMessage message={original} getCatById={() => undefined} />));
  act(() => writeShellLanguage('en'));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('cannot enforce a read-only check');
  act(() => root.unmount());
  root = createRoot(host);
  act(() =>
    root.render(<ChatMessage message={JSON.parse(JSON.stringify(original)) as Message} getCatById={() => undefined} />),
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('New-message check failed');
});

it('uses a readable fallback when a failed check has no reason, and retains classic Chinese', () => {
  writeShellPresentation('classic');
  writeShellLanguage('en');
  const withoutReason = JSON.parse(JSON.stringify(original)) as Message;
  delete withoutReason.extra?.freshnessSupplement?.terminalReason;
  act(() => root.render(<ChatMessage message={withoutReason} getCatById={() => undefined} />));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('暂时无法取得失败原因');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('这条回复已保留');
});

it('has matching localized public messages', () => {
  expect(checkShellCopyParity(freshnessNoticeCopy)).toEqual([]);
});
