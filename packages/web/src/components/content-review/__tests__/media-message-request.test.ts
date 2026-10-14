import type { ContentModificationContextCatalogue, ContextAttachment, MediaContextAttachment } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { hasRequestFromMessage, mediaAttachmentOf, mediaRequestsForMessage } from '../media-message-request';

const media = (patch: Partial<MediaContextAttachment> = {}): MediaContextAttachment => ({
  v: 1,
  id: 'media-1',
  kind: 'media',
  title: '窄屏设计稿.png',
  mediaType: 'image/png',
  source: {
    kind: 'workspace',
    locator: { worktreeId: 'w', path: 'art/cover.png' },
    expectedSourceRevision: 'sha256:abc',
    reviewId: 'review-1',
  } as MediaContextAttachment['source'],
  selections: [
    { id: '1', selection: { kind: 'image-region', x: 1, y: 2, width: 3, height: 4 } },
    { id: '2', selection: { kind: 'image-region', x: 5, y: 6, width: 7, height: 8 } },
  ] as MediaContextAttachment['selections'],
  ...patch,
});
const quote = { v: 1, id: 'q-1', kind: 'message', title: '一条引用' } as unknown as ContextAttachment;
const block = (attachment: ContextAttachment) => ({ type: 'context_attachment' as const, attachment });

describe('mediaAttachmentOf', () => {
  it('finds the media attachment among the message blocks', () => {
    const wanted = media();
    expect(mediaAttachmentOf([{ type: 'text', text: '请处理' }, block(quote), block(wanted)])).toBe(wanted);
  });

  it('is null when the message carries no media attachment, whatever else it carries', () => {
    expect(mediaAttachmentOf(undefined)).toBeNull();
    expect(mediaAttachmentOf([])).toBeNull();
    expect(mediaAttachmentOf([{ type: 'text', text: '只有字' }, block(quote)])).toBeNull();
  });

  it('takes the first one when there are several, because one send carries one', () => {
    const first = media({ id: 'media-first' });
    expect(mediaAttachmentOf([block(first), block(media({ id: 'media-second' }))])).toBe(first);
  });
});

type RequestPatch = {
  id: string;
  sourceMessageId?: string;
  sourceKind?: 'generated_request' | 'human_message';
  createdAt?: number;
  targetCatId?: string;
};
const request = ({
  id,
  sourceMessageId,
  sourceKind = 'human_message',
  createdAt = 1,
  targetCatId = 'cat-a',
}: RequestPatch) =>
  ({
    record: {
      requestId: id,
      createdAt,
      progress: { ...(sourceMessageId ? { sourceMessageId } : {}), sourceKind },
      payload: { targetCatId },
    },
    stage: 'queued',
  }) as unknown as ContentModificationContextCatalogue['requests'][number];
const catalogue = (
  requests: ContentModificationContextCatalogue['requests'],
  contexts: Partial<ContentModificationContextCatalogue['contexts'][number]>[] = [],
) => ({ requests, contexts }) as unknown as ContentModificationContextCatalogue;
const nameOf = (catId: string) => (catId === 'cat-a' ? '花花' : undefined);

describe('mediaRequestsForMessage', () => {
  it('joins by the real Human message id, and by nothing else', () => {
    const joined = mediaRequestsForMessage(
      catalogue([
        request({ id: 'r-mine', sourceMessageId: 'message-1' }),
        request({ id: 'r-other-message', sourceMessageId: 'message-2' }),
        request({ id: 'r-no-source' }),
      ]),
      'message-1',
      media(),
      nameOf,
    );
    expect(joined.map((item) => item.requestId)).toEqual(['r-mine']);
  });

  it('ignores a request that was generated for the same id: its own message presentation owns it', () => {
    const joined = mediaRequestsForMessage(
      catalogue([request({ id: 'r-generated', sourceMessageId: 'message-1', sourceKind: 'generated_request' })]),
      'message-1',
      media(),
      nameOf,
    );
    expect(joined).toEqual([]);
  });

  it('is empty when no request has been taken yet, which says nothing about the cat', () => {
    expect(mediaRequestsForMessage(catalogue([]), 'message-1', media(), nameOf)).toEqual([]);
  });

  it('defensively lists every matching request, oldest first, tie broken by id', () => {
    // The contract gives one Human message at most one request; this only keeps odd or historical data stable.
    const joined = mediaRequestsForMessage(
      catalogue([
        request({ id: 'r-b', sourceMessageId: 'message-1', createdAt: 5 }),
        request({ id: 'r-c', sourceMessageId: 'message-1', createdAt: 9 }),
        request({ id: 'r-a', sourceMessageId: 'message-1', createdAt: 5 }),
      ]),
      'message-1',
      media(),
      nameOf,
    );
    expect(joined.map((item) => item.requestId)).toEqual(['r-a', 'r-b', 'r-c']);
  });

  it('names the cat from the owner context first, then the roster, then the id itself', () => {
    const joined = mediaRequestsForMessage(
      catalogue(
        [
          request({ id: 'r-ctx', sourceMessageId: 'message-1', targetCatId: 'cat-a', createdAt: 1 }),
          request({ id: 'r-roster', sourceMessageId: 'message-1', targetCatId: 'cat-a', createdAt: 2 }),
          request({ id: 'r-raw', sourceMessageId: 'message-1', targetCatId: 'cat-z', createdAt: 3 }),
        ],
        [{ requestIds: ['r-ctx'], targetName: '烁烁' }],
      ),
      'message-1',
      media(),
      nameOf,
    );
    expect(joined.map((item) => item.targetName)).toEqual(['烁烁', '花花', 'cat-z']);
  });

  it('carries the media title and how many places the message covered; the whole work covers none', () => {
    const [two] = mediaRequestsForMessage(
      catalogue([request({ id: 'r', sourceMessageId: 'message-1' })]),
      'message-1',
      media(),
      nameOf,
    );
    expect(two).toMatchObject({ contentTitle: '窄屏设计稿.png', placeCount: 2 });
    const [whole] = mediaRequestsForMessage(
      catalogue([request({ id: 'r', sourceMessageId: 'message-1' })]),
      'message-1',
      media({ selections: [] }),
      nameOf,
    );
    expect(whole.placeCount).toBe(0);
  });
});

describe('hasRequestFromMessage', () => {
  it('is true once a request that came from this very Human message is listed', () => {
    expect(hasRequestFromMessage(catalogue([request({ id: 'r', sourceMessageId: 'message-1' })]), 'message-1')).toBe(
      true,
    );
  });

  it('is false for no request, and for requests of other messages from the same source', () => {
    expect(hasRequestFromMessage(catalogue([]), 'message-1')).toBe(false);
    expect(hasRequestFromMessage(catalogue([request({ id: 'r', sourceMessageId: 'message-2' })]), 'message-1')).toBe(
      false,
    );
    expect(hasRequestFromMessage(catalogue([request({ id: 'r' })]), 'message-1')).toBe(false);
  });

  it('is false for a request that was generated for this message: that is not a takeover of it', () => {
    expect(
      hasRequestFromMessage(
        catalogue([request({ id: 'r', sourceMessageId: 'message-1', sourceKind: 'generated_request' })]),
        'message-1',
      ),
    ).toBe(false);
  });
});
