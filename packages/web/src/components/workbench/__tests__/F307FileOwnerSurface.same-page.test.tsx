import type { ContentModificationRecord, ContentModificationRequest } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearModificationFocus, focusModification } from '@/components/content-review/modification-focus';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import type { WorkspaceFileSave } from '@/components/workspace/workspace-file-draft';
import { useChatStore } from '@/stores/chatStore';
import { revision, view } from '../content-review/__tests__/WorkspaceContentReviewSurface.fixture';
import { F307FileOwnerSurface } from '../F307FileOwnerSurface';
import { createFileSurface } from '../real-surface-adapters';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: mocks.apiFetch }));
vi.mock('@/hooks/useWorkspaceFileChange', () => ({
  useWorkspaceFileChange: () => ({ pendingExternalSha: null, onDirtyChange: vi.fn() }),
}));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => <p data-source-line="1">{content}</p>,
}));
vi.mock('@/components/workspace/CodeViewer', () => ({
  CodeViewer: ({ editable, onSave }: { editable: boolean; onSave: WorkspaceFileSave }) => (
    <div data-testid="original-source-editor" data-editable={String(editable)}>
      {editable && (
        <button type="button" onClick={() => void onSave('saved by original editor')}>
          保存文件
        </button>
      )}
    </div>
  ),
}));
vi.mock('@/components/content-review/ContentModificationLanding', () => ({
  ContentModificationLanding: ({
    source,
    focusCandidateRef,
  }: {
    source: ContentModificationRequest['source'];
    focusCandidateRef?: string;
  }) => (
    <div
      data-testid="original-modification-landing"
      data-source={JSON.stringify(source)}
      data-candidate={focusCandidateRef}
    />
  ),
}));

let host: HTMLDivElement;
let root: Root;
const originalStore = useChatStore.getState();
const onReturn = vi.fn();
const sourceText = 'A unique source quote.';
const sha = revision.replace('sha256:', '');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  writeShellPresentation('v2');
  onReturn.mockReset();
  clearModificationFocus();
  useChatStore.setState({
    currentThreadId: 'thread-a',
    workspaceOpenRevision: 7,
    pendingChatInsert: null,
    currentProjectPath: undefined,
  });
  mocks.apiFetch.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/workspace/file?'))
      return new Response(
        JSON.stringify({
          path: 'notes.md',
          content: sourceText,
          sha256: sha,
          size: 22,
          mime: 'text/markdown',
          truncated: false,
        }),
      );
    if (url === '/api/workspace/content-reviews/prepare') return new Response(JSON.stringify(view()));
    if (url === '/api/workspace/edit-session')
      return new Response(JSON.stringify({ token: 'scoped-edit', expiresIn: 60 }));
    if (url === '/api/workspace/file' && init?.method === 'PUT')
      return new Response(JSON.stringify({ path: 'notes.md', sha256: sha }));
    throw new Error(`unexpected request: ${url}`);
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  clearModificationFocus();
  host.remove();
  useChatStore.setState(originalStore, true);
  localStorage.clear();
  vi.restoreAllMocks();
});

async function render() {
  await act(async () =>
    root.render(
      <F307FileOwnerSurface
        surface={createFileSurface({
          worktreeId: 'worktree-a',
          path: 'notes.md',
          navigationOrigin: { kind: 'workspace-home-search', query: 'notes' },
        })}
        onRequestDetach={vi.fn()}
        onReturnToNavigationOrigin={onReturn}
      />,
    ),
  );
}

async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button?.click());
}

it('keeps the original reader mounted while collaboration opens or fails, with no tools-page detour', async () => {
  let failPrepare: (value: Response) => void = () => undefined;
  const preparation = new Promise<Response>((resolve) => {
    failPrepare = resolve;
  });
  mocks.apiFetch
    .mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            path: 'notes.md',
            content: sourceText,
            sha256: sha,
            size: 22,
            mime: 'text/markdown',
            truncated: false,
          }),
        ),
    )
    .mockImplementationOnce(() => preparation);
  await render();
  const reader = host.querySelector('[data-testid="workspace-file-viewer"]');
  expect(reader, 'reading does not wait for review preparation').not.toBeNull();
  expect(reader?.textContent).toContain(sourceText);
  await act(async () => failPrepare(new Response('{}', { status: 503 })));
  expect(host.querySelector('[data-testid="workspace-file-viewer"]')).toBe(reader);
  expect(host.textContent).not.toContain('文件工具');
  expect(host.querySelector('[data-testid="workspace-content-review-text"]')).not.toBeNull();
});

it('keeps source, edit/save, listening and return in the same original file surface', async () => {
  await render();
  const reader = host.querySelector('[data-testid="workspace-file-viewer"]');
  expect(reader).not.toBeNull();
  await click('渲染');
  expect(host.querySelector('[data-testid="original-source-editor"]')?.getAttribute('data-editable')).toBe('false');
  await click('编辑');
  expect(host.querySelector('[data-testid="original-source-editor"]')?.getAttribute('data-editable')).toBe('true');
  await click('保存文件');
  const write = mocks.apiFetch.mock.calls.find(
    ([url, init]) => url === '/api/workspace/file' && init?.method === 'PUT',
  );
  expect(JSON.parse(String(write?.[1].body))).toEqual({
    worktreeId: 'worktree-a',
    path: 'notes.md',
    content: 'saved by original editor',
    baseSha256: sha,
    editSessionToken: 'scoped-edit',
  });
  expect(host.querySelector('[data-testid="workspace-file-viewer"]')).toBe(reader);
  await click('编辑中');
  await click('源码');
  expect([...host.querySelectorAll('button')].some((button) => button.textContent === '朗读')).toBe(true);
  await click('‹ 工具搜索');
  expect(onReturn).toHaveBeenCalledWith({ kind: 'workspace-home-search', query: 'notes' });
});

it('the file toolbar opens the original explicit modification flow for that exact owner/version', async () => {
  await render();
  const reader = host.querySelector('[data-testid="workspace-file-viewer"]');
  expect(reader).not.toBeNull();
  await click('请猫修改');
  const landing = host.querySelector<HTMLElement>('[data-testid="original-modification-landing"]');
  expect(landing).not.toBeNull();
  expect(JSON.parse(landing?.dataset.source ?? '{}')).toMatchObject({
    kind: 'workspace',
    locator: { worktreeId: 'worktree-a', path: 'notes.md' },
    expectedSourceRevision: revision,
  });
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
  expect(host.querySelector('[data-testid="workspace-file-viewer"]')).toBe(reader);
  expect(host.querySelectorAll('[data-testid="workspace-content-review-text"]')).toHaveLength(1);
});

it.each([
  'thread-a',
  'another-thread',
])('receipt focus stays bound to its original navigation (%s)', async (threadId) => {
  const record: ContentModificationRecord = {
    requestId: 'same-page-request',
    ownerUserId: 'operator',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    progress: {},
    payload: {
      operationId: 'same-page-operation',
      targetCatId: 'codex61-sol',
      threadId: 'thread-a',
      intent: { body: '改原文' },
      source: {
        kind: 'workspace',
        locator: { worktreeId: 'worktree-a', path: 'notes.md' },
        expectedSourceRevision: revision,
        reviewId: view().review.reviewId,
        expectedReviewRevision: 1,
      },
    },
  };
  focusModification({ record, candidateRef: 'exact-candidate', navigation: { threadId, revision: 7 } });
  await render();
  expect(host.querySelector('[data-testid="workspace-file-viewer"]')).not.toBeNull();
  const landing = host.querySelector<HTMLElement>('[data-testid="original-modification-landing"]');
  if (threadId === 'thread-a') expect(landing?.dataset.candidate).toBe('exact-candidate');
  else expect(landing).toBeNull();
});
