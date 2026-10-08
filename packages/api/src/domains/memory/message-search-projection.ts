import type { MessageSearchResult } from '@cat-cafe/shared';
import type { StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { isSystemUserMessage } from '../cats/services/stores/visibility.js';

export function projectMessageSearchSnippet(
  text: string,
  source: MessageSearchResult['snippet']['source'],
  query = '',
): MessageSearchResult['snippet'] {
  const matchAt = query.trim() ? text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase()) : -1;
  const start = matchAt > 160 ? Math.max(0, matchAt - 80) : 0;
  const window = text.slice(start, start + 240);
  const boundaries = [...window.matchAll(/[。！？]|[.!?](?=\s|$)|\n/g)];
  const second = boundaries[1];
  const end = Math.min(
    240,
    second && (matchAt < 0 || start + second.index >= matchAt + query.trim().length)
      ? second.index + second[0].length
      : window.length,
  );
  return { text: text.slice(start, start + end), start, end: start + end, source };
}

export function projectMessageSearchHighlights(text: string, query: string): MessageSearchResult['highlights'] {
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return [];
  const match = new RegExp(escaped, 'iu').exec(text);
  return match ? [{ start: match.index, end: match.index + match[0].length }] : [];
}

/** Stored source provenance takes precedence over a missing cat identity. */
export function projectMessageSearchSpeaker(
  message: StoredMessage & { type?: string },
): Pick<MessageSearchResult, 'speaker' | 'speakerLabel'> {
  if (isSystemUserMessage(message) || message.sourceParseFailure || message.type === 'system')
    return { speaker: 'system' };
  if (message.source?.connector || message.type === 'connector') {
    const source = message.source;
    const label = (source?.label?.trim() || source?.connector || '外部来源').slice(0, 80);
    const sender = (source?.sender?.name?.trim() || source?.sender?.id?.trim())?.slice(0, 80);
    return { speaker: 'connector', speakerLabel: sender ? `${label} · ${sender}` : label };
  }
  return { speaker: message.catId ?? 'user' };
}
