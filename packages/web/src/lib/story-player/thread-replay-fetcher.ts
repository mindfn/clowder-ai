/**
 * F252 Phase E — Thread-level Replay Event Fetcher
 *
 * Fetches all sealed sessions for a thread and merges their events
 * into a single time-sorted stream for thread-level replay.
 *
 * AC-E2: "同一 thread 下所有 session 按时间串联"
 *
 * Note: CLI transcripts only contain assistant-side events (text, tool_use,
 * tool_result, system_info). User prompts are stored in the chat message
 * store, not in the CLI event stream. This fetcher supplements transcript
 * events with user messages from the chat history API so the replay
 * shows the complete conversation (user prompts + assistant responses).
 */

import { apiFetch } from '@/utils/api-client';
import { mergeSessionEvents } from './merge-session-events';
import type { RawTranscriptEvent } from './types';

// Re-export for convenience
export { mergeSessionEvents } from './merge-session-events';

// ---------------------------------------------------------------------------
// API interaction (integration layer)
// ---------------------------------------------------------------------------

/**
 * Fetch all session IDs for a thread.
 * Includes active/sealing sessions so the current conversation is replayable
 * — events already recorded are valid for replay even if the session is ongoing.
 */
async function fetchThreadSessionIds(threadId: string): Promise<string[]> {
  const res = await apiFetch(`/api/threads/${threadId}/sessions`);
  if (!res.ok) {
    throw new Error(`Failed to fetch thread sessions: ${res.status}`);
  }
  const data = (await res.json()) as {
    sessions?: Array<{ id: string; status: 'active' | 'sealing' | 'sealed' }>;
  };
  return (data.sessions ?? []).map((s) => s.id);
}

/**
 * Fetch all events for a single session (handles pagination).
 */
async function fetchSessionEvents(sessionId: string): Promise<RawTranscriptEvent[]> {
  const all: RawTranscriptEvent[] = [];
  let cursorEventNo: number | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const params = new URLSearchParams({ view: 'raw', limit: '200' });
    if (cursorEventNo != null) params.set('cursor', String(cursorEventNo));

    const res = await apiFetch(`/api/sessions/${sessionId}/events?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch session ${sessionId} events: ${res.status}`);
    }

    const data = (await res.json()) as {
      events: RawTranscriptEvent[];
      nextCursor?: { eventNo: number };
    };

    all.push(...data.events);
    if (!data.nextCursor) break;
    cursorEventNo = data.nextCursor.eventNo;
  }

  return all;
}

// ---------------------------------------------------------------------------
// User message supplementation
// ---------------------------------------------------------------------------

interface ChatHistoryMessage {
  id: string;
  type: string;
  catId?: string | null;
  content: string;
  timestamp: number;
  /** Effective delivery time — queued/delayed messages may differ from timestamp. */
  deliveredAt?: number;
}

/**
 * Fetch ALL user (owner) messages from the chat history API for a thread.
 * CLI transcripts don't contain user prompts — they only record the
 * assistant-side event stream. This fills the gap so the replay shows
 * the complete conversation.
 *
 * Paginates backwards using the `before` cursor (`timestamp:id`) until
 * `hasMore` is false, so long threads don't lose early user prompts.
 */
async function fetchUserMessages(threadId: string): Promise<RawTranscriptEvent[]> {
  try {
    const PAGE_SIZE = 200;
    const allUserMessages: ChatHistoryMessage[] = [];
    let before: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const params = new URLSearchParams({ threadId, limit: String(PAGE_SIZE) });
      if (before) params.set('before', before);

      const res = await apiFetch(`/api/messages?${params.toString()}`);
      if (!res.ok) break;

      const data = (await res.json()) as {
        messages?: ChatHistoryMessage[];
        hasMore?: boolean;
      };
      const messages = data.messages ?? [];
      const userMessages = messages.filter((m) => m.type === 'user' && !m.catId);
      allUserMessages.push(...userMessages);

      if (!data.hasMore || messages.length === 0) break;

      // Build cursor from the oldest message in this page (first element —
      // API returns oldest-first after internal sort). Use deliveredAt when
      // present — matches the server's cursor semantics (deliveredAt ?? timestamp)
      // so queued/delayed messages don't get skipped.
      const oldest = messages[0];
      const cursorTs = oldest.deliveredAt ?? oldest.timestamp;
      before = `${cursorTs}:${oldest.id}`;
    }

    return allUserMessages.map((m, idx) => ({
      v: 1,
      // Use deliveredAt for timeline position when available — a queued/delayed
      // prompt should appear at its delivery time, not its creation time.
      t: m.deliveredAt ?? m.timestamp,
      threadId,
      catId: '',
      sessionId: '__user__',
      cliSessionId: '__user__',
      eventNo: idx,
      event: { type: 'user', content: m.content },
    }));
  } catch {
    // Best-effort: replay works without user messages, just shows assistant side
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all events for a thread (all sessions + user messages, merged by timestamp).
 *
 * Flow:
 * 1. GET /api/threads/:threadId/sessions → list sessions
 * 2. For each session: paginate all events
 * 3. GET /api/messages → extract user (owner) messages
 * 4. Merge all + sort by timestamp + re-index eventNo
 */
export async function fetchThreadReplayEvents(threadId: string): Promise<RawTranscriptEvent[]> {
  const sessionIds = await fetchThreadSessionIds(threadId);

  // Fetch session events and user messages in parallel
  const [sessionEventSets, userEvents] = await Promise.all([
    Promise.all(sessionIds.map(fetchSessionEvents)),
    fetchUserMessages(threadId),
  ]);

  // Merge transcript events + user messages into a unified timeline
  return mergeSessionEvents([...sessionEventSets, userEvents]);
}
