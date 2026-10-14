import type { MediaContextAttachment } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { syncContextAttachmentDraftToStorage } from '@/components/thread-drafts';
import { useChatStore } from '@/stores/chatStore';
import { WorkspaceContentReviewSurface } from '../WorkspaceContentReviewSurface';
import { mediaView, reviewId, revision } from './WorkspaceContentReviewSurface.fixture';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

const THREAD = 'thread-ordinary-media';
let container: HTMLDivElement;
let root: Root;

const mount = async (view = mediaView()) => {
  mocks.apiFetch.mockImplementation(async (url: string) => {
    if (url === '/api/workspace/content-reviews/prepare') return new Response(JSON.stringify(view));
    throw new Error(`unexpected route: ${url}`);
  });
  await act(async () => {
    root.render(
      <WorkspaceContentReviewSurface
        worktreeId="worktree-a"
        path="cover.png"
        sourceText=""
        sourceTextRevision=""
        onBack={vi.fn()}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
};
const byText = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes(label));
const selectWholeImage = async () => {
  await act(async () => byText('标注整张图片')?.click());
};
const addToChat = () =>
  container.querySelector<HTMLButtonElement>('[data-testid="workspace-content-review-media-add-to-chat"]');
const type = async (value: string) => {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
  if (!textarea) throw new Error('comment form is missing');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  await act(async () => textarea.dispatchEvent(new Event('input', { bubbles: true })));
};
const queued = () => useChatStore.getState().pendingChatInsert;
const queuedMedia = () =>
  (queued()?.contextAttachments ?? []).find((item): item is MediaContextAttachment => item.kind === 'media');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.apiFetch.mockReset();
  syncContextAttachmentDraftToStorage(THREAD, []);
  useChatStore.setState({ currentThreadId: THREAD, pendingChatInsert: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it('puts the circled place into the same chat composer as one media attachment, with the words typed for it', async () => {
  await mount();
  await selectWholeImage();
  await type('把角落的标志移除');
  expect(addToChat()?.disabled).toBe(false);
  await act(async () => addToChat()?.click());

  const attachment = queuedMedia();
  expect(queued()?.threadId).toBe(THREAD);
  expect(attachment).toMatchObject({
    kind: 'media',
    title: 'cover.png',
    mediaType: 'image/png',
    // The same source "请猫修改" names: the version that was reviewed, never a screenshot or a guessed Task.
    source: {
      kind: 'workspace',
      locator: { worktreeId: 'worktree-a', path: 'cover.png' },
      expectedSourceRevision: revision,
      reviewId,
    },
    selections: [
      {
        id: '1',
        selection: { kind: 'image-region', x: 0, y: 0, width: 160, height: 100 },
        instruction: '把角落的标志移除',
      },
    ],
  });
  // Adding is not sending and not saving a review comment: nothing was written to the review.
  expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  // The words and the selection belong to the chip now: the form is empty and there is nothing left to add.
  expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value ?? '').toBe('');
  expect(addToChat()).toBeNull();
});

it('offers it only when there is a circled place to add', async () => {
  await mount();
  expect(addToChat()).toBeNull();
});

it('says another work already waits in the composer, and adds nothing', async () => {
  await mount();
  syncContextAttachmentDraftToStorage(THREAD, [
    {
      v: 1,
      id: 'media-other',
      kind: 'media',
      title: 'other.png',
      mediaType: 'image/png',
      source: {
        kind: 'workspace',
        locator: { worktreeId: 'worktree-a', path: 'other.png' },
        expectedSourceRevision: revision,
        reviewId: 'other-review',
        expectedReviewRevision: 1,
      },
      selections: [{ id: '1', selection: { kind: 'image-point', x: 1, y: 1 } }],
    },
  ]);
  await selectWholeImage();
  await act(async () => addToChat()?.click());
  expect(container.textContent).toContain('输入框里已有另一幅作品的选区');
  expect(queued()).toBeNull();
  // The circle and the words are kept so nothing the person did is lost.
  expect(container.querySelector('textarea')).not.toBeNull();
});

it('says there is no conversation to add it to when none is open', async () => {
  useChatStore.setState({ currentThreadId: undefined });
  await mount();
  await selectWholeImage();
  await act(async () => addToChat()?.click());
  expect(container.textContent).toContain('请先打开一个对话');
  expect(queued()).toBeNull();
});

it('does not take a JPEG: the image path carries PNG only, and says so', async () => {
  const jpeg = mediaView();
  (jpeg.review.source as { mime: string }).mime = 'image/jpeg';
  await mount(jpeg);
  await selectWholeImage();
  await act(async () => addToChat()?.click());
  expect(container.textContent).toContain('目前只能把 PNG 图片上的圈选或点选放进对话');
  expect(queued()).toBeNull();
});

it('does not draw places that belong to another work onto this picture', async () => {
  syncContextAttachmentDraftToStorage(THREAD, [
    {
      v: 1,
      id: 'media-other',
      kind: 'media',
      title: 'other.png',
      mediaType: 'image/png',
      source: {
        kind: 'workspace',
        locator: { worktreeId: 'worktree-a', path: 'other.png' },
        expectedSourceRevision: revision,
        reviewId: 'other-review',
        expectedReviewRevision: 1,
      },
      selections: [{ id: '1', selection: { kind: 'image-point', x: 1, y: 1 } }],
    },
  ]);
  await mount();
  expect(container.querySelectorAll('[data-testid="review-pending-chat-mark"]')).toHaveLength(0);
});

it('marks the circled place on the picture with the number it has in the composer, until it is sent', async () => {
  await mount();
  expect(container.querySelectorAll('[data-testid="review-pending-chat-mark"]')).toHaveLength(0);
  await selectWholeImage();
  await act(async () => addToChat()?.click());
  // The composer takes the queued insert; here the draft is stored the way it would be.
  const attachment = queuedMedia() as MediaContextAttachment;
  await act(async () => {
    syncContextAttachmentDraftToStorage(THREAD, [attachment]);
    useChatStore.getState().setPendingChatInsert(null);
  });
  const marks = [...container.querySelectorAll('[data-testid="review-pending-chat-mark"]')];
  expect(marks.map((mark) => mark.textContent)).toEqual(['1']);
  // Sent or removed: the marks go with the chip.
  await act(async () => syncContextAttachmentDraftToStorage(THREAD, []));
  expect(container.querySelectorAll('[data-testid="review-pending-chat-mark"]')).toHaveLength(0);
});

it('keeps saving an image annotation behind explicit editing actions instead of a second primary send', async () => {
  await mount();
  await selectWholeImage();
  await type('保留我的图片批注');
  const save = container.querySelector<HTMLButtonElement>('[aria-label="保存批注"]');
  const editing = save?.closest('details');
  expect(editing).not.toBeNull();
  expect(editing?.open).toBe(false);
  expect(editing?.querySelector('summary')?.textContent).toContain('批注操作');
  expect(addToChat()?.closest('details')).toBeNull();
  expect(addToChat()?.disabled).toBe(false);
  expect(save?.disabled).toBe(false);
  expect(container.querySelector('textarea')?.value).toBe('保留我的图片批注');
  expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
});
