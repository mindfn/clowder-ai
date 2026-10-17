import type {
  ContentModificationContextCatalogue,
  ContextAttachment,
  MediaContextAttachment,
  MessageContent,
} from '@cat-cafe/shared';

/** One request a cat took over from a sent media message, with the words the chat line needs. */
export interface MediaRequestJoin {
  requestId: string;
  /** Who is working on it, in the words the person knows the cat by. */
  targetName: string;
  /** The picture's own title, as it stood in the attachment the person sent. */
  contentTitle: string;
  /** How many places the message covered; the whole work covers none. */
  placeCount: number;
}

const isMedia = (attachment: ContextAttachment): attachment is MediaContextAttachment => attachment.kind === 'media';

/** One send carries one media attachment; when a message somehow has several, the first one speaks for it. */
export function mediaAttachmentOf(blocks: readonly MessageContent[] | undefined): MediaContextAttachment | null {
  for (const block of blocks ?? []) {
    if (block.type === 'context_attachment' && isMedia(block.attachment)) return block.attachment;
  }
  return null;
}

type CatalogueRequest = ContentModificationContextCatalogue['requests'][number];

/**
 * Whether this request is the takeover of this exact Human message: the owner's own `record.progress` says it came from
 * a Human message with this id. A request that was generated for the same id belongs to that message's own
 * presentation, so it is not one.
 */
const isTakeoverOf = ({ record }: CatalogueRequest, messageId: string) =>
  record.progress.sourceKind === 'human_message' && record.progress.sourceMessageId === messageId;

/** The owner holds at most one request per Human message, so once this is true there is nothing left to discover. */
export function hasRequestFromMessage(catalogue: ContentModificationContextCatalogue, messageId: string): boolean {
  return catalogue.requests.some((request) => isTakeoverOf(request, messageId));
}

/**
 * The request taken over from this exact Human message, joined through the owner's own record; nothing is written onto
 * the message. The contract gives one message at most one request (a second cat taking it over reuses it), so this is
 * one entry; it stays a list, oldest first, only so that odd or historical data renders stably instead of throwing.
 */
export function mediaRequestsForMessage(
  catalogue: ContentModificationContextCatalogue,
  messageId: string,
  attachment: MediaContextAttachment,
  resolveCatName: (catId: string) => string | undefined,
): MediaRequestJoin[] {
  return catalogue.requests
    .filter((request) => isTakeoverOf(request, messageId))
    .sort((a, b) => a.record.createdAt - b.record.createdAt || a.record.requestId.localeCompare(b.record.requestId))
    .map(({ record }) => ({
      requestId: record.requestId,
      targetName:
        // The persisted target id owns identity; its current roster name outranks a generic context label.
        resolveCatName(record.payload.targetCatId) ??
        catalogue.contexts.find((context) => context.requestIds.includes(record.requestId))?.targetName ??
        record.payload.targetCatId,
      contentTitle: attachment.title,
      placeCount: attachment.selections.length,
    }));
}
