import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { useChatStore } from '@/stores/chatStore';
import { ThreadWorksPanelV2 } from '../ThreadWorksPanelV2';

const data = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: '', apiFetch: data.fetch }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => ({ nickname: '小太阳·砚砚' }) }) }));
const items: ThreadArtifactDTO[] = [
  {
    type: 'file',
    name: 'Delivered.md',
    catId: 'codex61-sol',
    createdAt: 300,
    sourceMessageId: 'published-md',
    publicationItem: { kind: 'rich-file', blockId: 'md' },
    url: '/uploads/delivered.md',
  },
  { type: 'pr', name: 'Exact PR', catId: 'codex61-sol', createdAt: 200, sourceMessageId: null, ref: 'org/repo#10' },
];
let host: HTMLDivElement;
let root: Root;
const open = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellLanguage('en');
  data.fetch.mockReset();
  open.mockReset();
  useChatStore.setState({ currentThreadId: 'work-source', messages: [], threadStates: {} });
  data.fetch.mockImplementation(async () =>
    Response.json({
      threadId: 'work-source',
      artifacts: items,
      workLineage: 'resolved',
      view: 'works',
      complete: true,
      total: 2,
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it('uses the named source read and opens a complete document DTO with the original list view', async () => {
  await act(async () => root.render(<ThreadWorksPanelV2 threadId="work-source" onSelectArtifact={open} />));
  expect(data.fetch.mock.calls[0][0]).toBe('/api/threads/work-source/artifacts?view=works');
  expect(host.querySelector('h2')?.textContent).toBe('Works');
  expect(host.textContent).toContain('2 works');
  expect(host.textContent).not.toContain('Unknown version');
  const card = host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]');
  await act(async () => card?.click());
  expect(open).toHaveBeenCalledExactlyOnceWith(items[0], {
    kind: 'artifact-list',
    threadId: 'work-source',
    view: { scope: 'thread', filter: 'all', query: '', grouping: 'time', catFilter: null, collapsed: [] },
  });
});
it('incomplete source reads show neither a precise count nor a false empty state', async () => {
  data.fetch.mockImplementation(async () =>
    Response.json({ artifacts: [], workLineage: 'unavailable', view: 'works', complete: false }),
  );
  await act(async () => root.render(<ThreadWorksPanelV2 threadId="work-source" onSelectArtifact={open} />));
  expect(host.textContent).toContain('the count is not confirmed');
  expect(host.textContent).not.toContain('0 works');
  expect(host.textContent).not.toContain('No works match');
});

it('a mounted Works list rereads delivered materials and owner versions without token polling', async () => {
  await act(async () => root.render(<ThreadWorksPanelV2 threadId="work-source" onSelectArtifact={open} />));
  data.fetch.mockImplementation(async () =>
    Response.json({
      threadId: 'work-source',
      artifacts: [...items, { ...items[0], name: 'Newly delivered.pdf', sourceMessageId: 'new-publication' }],
      workLineage: 'resolved',
      view: 'works',
      complete: true,
      total: 3,
    }),
  );
  await act(async () => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated')));
  expect(host.textContent).toContain('3 works');
  expect(host.textContent).toContain('Newly delivered.pdf');
  const message = {
    id: 'new-publication',
    type: 'assistant' as const,
    content: 'stream',
    timestamp: 400,
    isStreaming: true,
  };
  await act(async () => useChatStore.setState({ messages: [message], hasActiveInvocation: true }));
  const catalogueReads = () =>
    data.fetch.mock.calls.filter(([path]) => path === '/api/threads/work-source/artifacts?view=works').length;
  const reads = catalogueReads();
  await act(async () => useChatStore.setState({ messages: [{ ...message, content: 'another token' }] }));
  expect(catalogueReads()).toBe(reads);
  await act(async () =>
    useChatStore.setState({ messages: [{ ...message, isStreaming: false }], hasActiveInvocation: false }),
  );
  expect(catalogueReads()).toBe(reads + 1);
  expect(host.textContent).toContain('3 works');
});

it('standalone global Works opens another conversation artifact through the current host owner', async () => {
  const crossThread = { ...items[0], threadId: 'another-thread', threadTitle: 'Original conversation' };
  data.fetch.mockImplementation(async () =>
    Response.json({ artifacts: [crossThread], workLineage: 'resolved', view: 'works', complete: true, total: 1 }),
  );
  const previous = useChatStore.getState().workspaceOpenRevision;
  await act(async () =>
    root.render(
      <ThreadWorksPanelV2
        threadId="work-source"
        initialView={{ scope: 'global', filter: 'all', query: '', grouping: 'none', catFilter: null, collapsed: [] }}
      />,
    ),
  );
  const card = host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]');
  expect(card).not.toBeNull();
  await act(async () => card?.click());
  expect(useChatStore.getState().workspaceOpenRevision).toBe(previous + 1);
  expect(useChatStore.getState().workspaceOpenRequest?.threadId).toBe('work-source');
  expect(useChatStore.getState().workspaceOpenRequest?.target).toMatchObject({
    kind: 'artifact',
    artifact: { threadId: 'another-thread' },
  });
});
