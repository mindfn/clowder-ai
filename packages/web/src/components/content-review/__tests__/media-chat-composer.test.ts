import { type ArtifactReviewAnchor, type ContextAttachment, type MediaContextAttachment } from '@cat-cafe/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { applyContextAttachmentDelta } from '../../durable-composer-draft-merge';
import { getContextAttachmentDraft, syncContextAttachmentDraftToStorage } from '../../thread-drafts';
import { addMediaSelectionToChat, removeMediaSelectionFromChat } from '../media-chat-composer';
import type { MediaChatTarget } from '../media-chat-selection';

const THREAD = 'thread-media-chat';
const SOURCE = {
  kind: 'workspace',
  locator: { worktreeId: 'wt-1', path: 'art/cover.png' },
  expectedSourceRevision: `sha256:${'a'.repeat(64)}`,
  reviewId: 'review-1',
  expectedReviewRevision: 3,
} as const;
const TARGET: MediaChatTarget = { title: 'cover.png', mediaType: 'image/png', source: SOURCE };
const REGION: ArtifactReviewAnchor = { kind: 'image-region', x: 10, y: 20, width: 40, height: 30 };
const POINT: ArtifactReviewAnchor = { kind: 'image-point', x: 120, y: 70 };

/** What ChatInput does with a queued insert: apply the same delta to its attachments, then persist the draft. */
function consumeLikeTheComposer(): ContextAttachment[] {
  const queued = useChatStore.getState().pendingChatInsert;
  if (!queued) return [...getContextAttachmentDraft(THREAD)];
  const next = applyContextAttachmentDelta(
    getContextAttachmentDraft(THREAD),
    queued.contextAttachments ?? [],
    new Set(queued.removeContextAttachmentIds ?? []),
  );
  syncContextAttachmentDraftToStorage(THREAD, next);
  useChatStore.getState().setPendingChatInsert(null);
  return next;
}

const media = (list: readonly ContextAttachment[]) =>
  list.filter((item): item is MediaContextAttachment => item.kind === 'media');

/** The id of the one media attachment the composer holds (stored or queued), whatever it was derived or restored as. */
const ownId = (): string => {
  const queued = useChatStore.getState().pendingChatInsert?.contextAttachments ?? [];
  const found = media([...getContextAttachmentDraft(THREAD), ...queued])[0];
  if (!found) throw new Error('no media attachment in the composer');
  return found.id;
};

/** A media attachment whose one place carries these words, built directly so a test can make a too-large collection. */
const mediaWithWords = (words: string): MediaContextAttachment[] => [
  {
    v: 1,
    id: 'media-oversized',
    kind: 'media',
    title: 'cover.png',
    mediaType: 'image/png',
    source: SOURCE,
    selections: [{ id: '1', selection: REGION, instruction: words }],
  },
];

beforeEach(() => {
  syncContextAttachmentDraftToStorage(THREAD, []);
  useChatStore.getState().setPendingChatInsert(null);
});

describe('addMediaSelectionToChat', () => {
  it('queues the first circled place as a new attachment for that conversation', () => {
    const result = addMediaSelectionToChat(THREAD, TARGET, REGION, '移除这里的字');
    expect(result.kind).toBe('added');
    const queued = useChatStore.getState().pendingChatInsert;
    expect(queued?.threadId).toBe(THREAD);
    expect(queued?.text).toBe('');
    expect(queued?.removeContextAttachmentIds).toBeUndefined();
    expect(media(queued?.contextAttachments ?? [])[0]?.selections).toEqual([
      { id: '1', selection: REGION, instruction: '移除这里的字' },
    ]);
    // Sending is the person's own act: nothing but the composer insert is touched.
    expect(queued?.imageUrls).toBeUndefined();
  });

  it('grows the same attachment in place once the composer holds the first place', () => {
    addMediaSelectionToChat(THREAD, TARGET, REGION);
    consumeLikeTheComposer();
    addMediaSelectionToChat(THREAD, TARGET, POINT, '这里加星星');
    const queued = useChatStore.getState().pendingChatInsert;
    const [attachment] = media(queued?.contextAttachments ?? []);
    expect(queued?.removeContextAttachmentIds).toEqual([attachment?.id]);
    const list = consumeLikeTheComposer();
    expect(media(list)).toHaveLength(1);
    expect(media(list)[0]?.selections.map((item) => item.id)).toEqual(['1', '2']);
    expect(media(list)[0]?.selections[1]?.instruction).toBe('这里加星星');
  });

  it('keeps both places when two are added before the composer has taken the first', () => {
    addMediaSelectionToChat(THREAD, TARGET, REGION);
    addMediaSelectionToChat(THREAD, TARGET, POINT);
    const list = consumeLikeTheComposer();
    expect(media(list)).toHaveLength(1);
    expect(media(list)[0]?.selections.map((item) => item.id)).toEqual(['1', '2']);
  });

  it('keeps what else was already queued for the composer on the same tick', () => {
    const quote: ContextAttachment = {
      v: 1,
      id: 'quote-1',
      kind: 'quote',
      text: 'hello',
      source: { kind: 'workspace_file', path: 'a.md' },
    };
    useChatStore.getState().setPendingChatInsert({ threadId: THREAD, text: '', contextAttachments: [quote] });
    addMediaSelectionToChat(THREAD, TARGET, REGION);
    const list = consumeLikeTheComposer();
    expect(list.map((item) => item.kind).sort()).toEqual(['media', 'quote']);
  });

  it('refuses another work out loud and leaves the composer exactly as it was', () => {
    addMediaSelectionToChat(THREAD, TARGET, REGION);
    consumeLikeTheComposer();
    const before = [...getContextAttachmentDraft(THREAD)];
    const other = { ...TARGET, source: { ...SOURCE, locator: { worktreeId: 'wt-1', path: 'art/other.png' } } };
    expect(addMediaSelectionToChat(THREAD, other, POINT)).toEqual({ kind: 'refused', reason: 'other_source' });
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
    expect(getContextAttachmentDraft(THREAD)).toEqual(before);
  });

  it('does not queue anything when there is no conversation to put the place into', () => {
    expect(addMediaSelectionToChat(null, TARGET, REGION)).toEqual({ kind: 'refused', reason: 'no_thread' });
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
  });
});

describe('addMediaSelectionToChat — the stored draft is never put at risk', () => {
  const bigQuote = (): ContextAttachment => ({
    v: 1,
    id: 'quote-big',
    kind: 'quote',
    text: '<'.repeat(7900),
    source: { kind: 'workspace_file', path: 'a.md' },
  });

  it('refuses a place that would make the composer too large and leaves the stored draft exactly as it was', () => {
    syncContextAttachmentDraftToStorage(THREAD, [bigQuote()]);
    expect(getContextAttachmentDraft(THREAD)).toHaveLength(1);
    expect(addMediaSelectionToChat(THREAD, TARGET, REGION, 'x'.repeat(1000))).toEqual({
      kind: 'refused',
      reason: 'too_large',
    });
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
    expect(getContextAttachmentDraft(THREAD)).toEqual([bigQuote()]);
  });

  it('is judged on what is queued but not yet taken as well as on what is stored', () => {
    useChatStore.getState().setPendingChatInsert({ threadId: THREAD, text: '', contextAttachments: [bigQuote()] });
    expect(addMediaSelectionToChat(THREAD, TARGET, REGION, 'x'.repeat(1000))).toEqual({
      kind: 'refused',
      reason: 'too_large',
    });
    // What was queued is left alone: the refusal changes nothing.
    expect(useChatStore.getState().pendingChatInsert?.contextAttachments).toEqual([bigQuote()]);
  });

  it('documents why: the draft store throws a collection past the limit away whole, not just the new part', () => {
    const tooLarge: ContextAttachment[] = [bigQuote(), ...mediaWithWords('x'.repeat(1000))];
    syncContextAttachmentDraftToStorage(THREAD, [bigQuote()]);
    syncContextAttachmentDraftToStorage(THREAD, tooLarge);
    expect(getContextAttachmentDraft(THREAD)).toEqual([]);
  });
});

describe('addMediaSelectionToChat — an attachment restored from a draft', () => {
  const restored = (
    selections: MediaContextAttachment['selections'] = [{ id: '1', selection: REGION }],
  ): MediaContextAttachment => ({
    v: 1,
    id: 'cover',
    kind: 'media',
    title: 'cover.png',
    mediaType: 'image/png',
    source: SOURCE,
    selections,
  });

  it('grows in place under its own id: one attachment afterwards, not the old one plus a second', () => {
    syncContextAttachmentDraftToStorage(THREAD, [restored()]);
    addMediaSelectionToChat(THREAD, TARGET, POINT, '这里加星星');
    expect(useChatStore.getState().pendingChatInsert?.removeContextAttachmentIds).toEqual(['cover']);
    const list = consumeLikeTheComposer();
    expect(media(list)).toHaveLength(1);
    expect(media(list)[0]?.id).toBe('cover');
    expect(media(list)[0]?.selections.map((item) => item.id)).toEqual(['1', '2']);
  });

  it('does so when the place being added meets one still queued for the same tick', () => {
    syncContextAttachmentDraftToStorage(THREAD, [restored()]);
    addMediaSelectionToChat(THREAD, TARGET, POINT);
    addMediaSelectionToChat(THREAD, TARGET, REGION);
    const list = consumeLikeTheComposer();
    expect(media(list)).toHaveLength(1);
    expect(media(list)[0]?.id).toBe('cover');
    expect(media(list)[0]?.selections.map((item) => item.id)).toEqual(['1', '2', '3']);
  });

  it('keeps its id after a place is taken away and another is added', () => {
    syncContextAttachmentDraftToStorage(THREAD, [
      restored([
        { id: '1', selection: REGION },
        { id: '2', selection: POINT },
      ]),
    ]);
    removeMediaSelectionFromChat(THREAD, 'cover', '1');
    consumeLikeTheComposer();
    addMediaSelectionToChat(THREAD, TARGET, REGION);
    const list = consumeLikeTheComposer();
    expect(media(list)).toHaveLength(1);
    expect(media(list)[0]?.id).toBe('cover');
    expect(media(list)[0]?.selections.map((item) => item.id)).toEqual(['2', '3']);
  });

  it('can still grow when the composer already holds twelve attachments, one of them this one', () => {
    const others: ContextAttachment[] = Array.from({ length: 11 }, (_, i) => ({
      v: 1,
      id: `quote-${i}`,
      kind: 'quote',
      text: 'x',
      source: { kind: 'workspace_file', path: 'a.md' },
    }));
    syncContextAttachmentDraftToStorage(THREAD, [...others, restored()]);
    expect(getContextAttachmentDraft(THREAD)).toHaveLength(12);
    const result = addMediaSelectionToChat(THREAD, TARGET, POINT);
    expect(result.kind).toBe('added');
    const list = consumeLikeTheComposer();
    expect(list).toHaveLength(12);
    expect(media(list)[0]?.selections.map((item) => item.id)).toEqual(['1', '2']);
  });
});

describe('removeMediaSelectionFromChat — which attachment owns the place', () => {
  const owned = (id: string, selections: MediaContextAttachment['selections']): MediaContextAttachment => ({
    v: 1,
    id,
    kind: 'media',
    title: 'cover.png',
    mediaType: 'image/png',
    source: SOURCE,
    selections,
  });

  it('takes a place out of the attachment that shows it when the composer holds more than one', () => {
    syncContextAttachmentDraftToStorage(THREAD, [
      owned('first', [{ id: '1', selection: REGION }]),
      owned('second', [
        { id: '1', selection: POINT },
        { id: '2', selection: REGION },
      ]),
    ]);
    removeMediaSelectionFromChat(THREAD, 'second', '1');
    const list = media(consumeLikeTheComposer());
    expect(list.map((item) => [item.id, item.selections.map((place) => place.id)])).toEqual([
      ['first', ['1']],
      ['second', ['2']],
    ]);
  });

  it('does nothing for an attachment that is not there', () => {
    syncContextAttachmentDraftToStorage(THREAD, [owned('first', [{ id: '1', selection: REGION }])]);
    removeMediaSelectionFromChat(THREAD, 'gone', '1');
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
    expect(media(getContextAttachmentDraft(THREAD))[0]?.selections).toHaveLength(1);
  });
});

describe('removeMediaSelectionFromChat', () => {
  it('takes one place out and keeps the other with its id', () => {
    addMediaSelectionToChat(THREAD, TARGET, REGION);
    addMediaSelectionToChat(THREAD, TARGET, POINT);
    consumeLikeTheComposer();
    removeMediaSelectionFromChat(THREAD, ownId(), '1');
    const list = consumeLikeTheComposer();
    expect(media(list)[0]?.selections.map((item) => item.id)).toEqual(['2']);
  });

  it('removes the whole attachment when the last place goes, never leaving the whole work behind', () => {
    addMediaSelectionToChat(THREAD, TARGET, REGION);
    consumeLikeTheComposer();
    removeMediaSelectionFromChat(THREAD, ownId(), '1');
    const queued = useChatStore.getState().pendingChatInsert;
    expect(queued?.removeContextAttachmentIds).toHaveLength(1);
    expect(media(queued?.contextAttachments ?? [])).toHaveLength(0);
    expect(media(consumeLikeTheComposer())).toHaveLength(0);
  });

  it('does nothing for a place that is not there', () => {
    addMediaSelectionToChat(THREAD, TARGET, REGION);
    consumeLikeTheComposer();
    removeMediaSelectionFromChat(THREAD, ownId(), 'nope');
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
    expect(media(getContextAttachmentDraft(THREAD))[0]?.selections).toHaveLength(1);
  });

  it('numbers the next place after a removal without reusing a survivor id', () => {
    addMediaSelectionToChat(THREAD, TARGET, REGION);
    addMediaSelectionToChat(THREAD, TARGET, POINT);
    consumeLikeTheComposer();
    removeMediaSelectionFromChat(THREAD, ownId(), '1');
    consumeLikeTheComposer();
    addMediaSelectionToChat(THREAD, TARGET, REGION);
    const list = consumeLikeTheComposer();
    expect(media(list)[0]?.selections.map((item) => item.id)).toEqual(['2', '3']);
  });
});
