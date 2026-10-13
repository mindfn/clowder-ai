import type { UnifiedAttentionItemV1, UnifiedAttentionSourceRead } from '@cat-cafe/shared';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';

export interface UserMentionTodoRead {
  items: UnifiedAttentionItemV1[];
  state: UnifiedAttentionSourceRead;
  recentCount?: number;
  counts?: { today: number; week: number; earlier: number; handled: number };
  period?: UserMentionPeriod;
}

export type UserMentionPeriod = 'recent' | 'today' | 'week' | 'earlier' | 'handled';
export interface MentionReadOptions {
  cutover: number;
  now: number;
  period: UserMentionPeriod;
  threads?: {
    get(
      id: string,
    ):
      | { createdBy?: string; title?: string | null }
      | null
      | Promise<{ createdBy?: string; title?: string | null } | null>;
  };
}

/** Shared by the list and bulk preview. The week is rolling, so Monday never hides weekend requests. */
export function classifyUserMentionPeriod(
  timestamp: number,
  cutover: number,
  now: number,
): 'today' | 'week' | 'earlier' {
  if (timestamp < cutover || timestamp < now - 7 * 86400000) return 'earlier';
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return timestamp >= today.getTime() ? 'today' : 'week';
}

export async function readUserMentionTodos(
  messages: Pick<IMessageStore, 'listUserMentionRequests'> &
    Partial<Pick<IMessageStore, 'listHandledUserMentions' | 'getUserMentionStateRevisions'>>,
  userId: string,
  options?: MentionReadOptions,
): Promise<UserMentionTodoRead> {
  const startedAt = Date.now();
  try {
    const source = await messages.listUserMentionRequests(userId);
    const handled = options && messages.listHandledUserMentions ? await messages.listHandledUserMentions(userId) : [];
    const revisions = messages.getUserMentionStateRevisions ? await messages.getUserMentionStateRevisions(userId) : {};
    const group = (m: (typeof source)[number]) =>
      classifyUserMentionPeriod(m.timestamp, options?.cutover ?? 0, options?.now ?? Date.now());
    const counts = { today: 0, week: 0, earlier: 0, handled: handled.length };
    for (const m of source) {
      const value = group(m);
      if (value === 'earlier') counts.earlier++;
      else {
        counts.week++;
        if (value === 'today') counts.today++;
      }
    }
    const selected = !options
      ? source
      : options.period === 'handled'
        ? handled
        : source.filter((m) =>
            options.period === 'recent' || options.period === 'week'
              ? group(m) !== 'earlier'
              : group(m) === options.period,
          );
    const items: UnifiedAttentionItemV1[] = selected.map((message) => {
      if (message.userId !== userId || !message.catId || !message.mentionsUser)
        throw new Error('Invalid request owner');
      return {
        decisionRef:
          options?.period === 'handled'
            ? `user-mention-handled:${message.threadId}:${message.id}`
            : `user-mention:${message.threadId}`,
        kind: 'user_mention',
        summary: '对话中的请求',
        userMention: {
          threadId: message.threadId,
          threadTitle: message.threadId,
          ...(options?.period === 'handled' ? { handled: true } : {}),
          expectedRevision: revisions[message.threadId] ?? 0,
          messageId: message.id,
          catId: message.catId,
          content: message.content,
          timestamp: message.timestamp,
        },
        linkedNeedsMe: [],
      };
    });
    return {
      items,
      ...(options ? { counts, recentCount: counts.week, period: options.period } : {}),
      state: {
        status: 'available',
        coverage: 'explicit_user_mentions',
        exhaustiveness: 'complete',
        startedAt,
        observedAt: Date.now(),
      },
    };
  } catch {
    return {
      items: [],
      state: {
        status: 'unavailable',
        coverage: 'explicit_user_mentions',
        exhaustiveness: 'unknown',
        startedAt,
        observedAt: Date.now(),
      },
    };
  }
}
