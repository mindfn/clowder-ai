import { readMessageOutputLayout } from '@cat-cafe/shared';
import { getBubbleInvocationId } from '@/debug/bubbleIdentity';
import type { ChatMessage } from './chat-types';

/** Optional native-only metadata cannot lend proof to callbacks or another child. */
export function withoutUnprovenOutputLayout(record: ChatMessage): ChatMessage {
  if (!record.extra?.outputLayout) return record;
  const layout = readMessageOutputLayout(record.extra.outputLayout);
  const allowed =
    record.type === 'assistant' &&
    record.origin === 'stream' &&
    !record.extra.isExplicitPost &&
    layout !== undefined &&
    layout.owner.catId === record.catId &&
    layout.owner.turnInvocationId === getBubbleInvocationId(record) &&
    layout.contentRevision.length === record.content.length;
  if (allowed) return record;
  const extra = { ...record.extra };
  delete extra.outputLayout;
  return { ...record, extra };
}

export function outputLayoutForCanonicalBubble(records: ChatMessage[], projected: ChatMessage) {
  if (projected.origin !== 'stream' || projected.extra?.isExplicitPost) return undefined;
  const child = getBubbleInvocationId(projected);
  // Exact body identity only; never rebuild offsets by searching for substrings.
  for (const record of [...records].reverse()) {
    const layout = readMessageOutputLayout(record.extra?.outputLayout);
    if (
      layout &&
      record.content === projected.content &&
      layout.owner.catId === projected.catId &&
      layout.owner.turnInvocationId === child
    )
      return layout;
  }
  return undefined;
}
