import { randomUUID } from 'node:crypto';
import type { StoredMessage } from './ports/MessageStore.js';
import { isTimelinePublished } from './visibility.js';

/** Explicit persisted mention and published human reply are the only input signals. No prose classification. */
export function userMentionEvent(message: StoredMessage): 'request' | 'reply' | null {
  if (message.visibility === 'whisper' || message.deletedAt || message.recall || !isTimelinePublished(message))
    return null;
  if (message.source || message.sourceParseFailure || message.origin === 'briefing') return null;
  if (
    message.extra?.systemKind ||
    message.extra?.systemInfo ||
    message.userId === 'system' ||
    message.userId === 'scheduler'
  )
    return null;
  if (message.catId === 'system') return null;
  if (message.catId === null) return message.extra?.crossPost ? null : 'reply';
  return message.mentionsUser ? 'request' : null;
}

interface MentionState {
  ownerUserId: string;
  threadId: string;
  id: string;
  pending: boolean;
  closedThrough: string;
  candidates: Set<string>;
  restoredId: string;
  revision: number;
}
type Ref = { threadId: string; messageId: string; expectedRevision?: number };
type Saved = Ref & {
  previous: string;
  previousRestored: string;
  candidates: string[];
  closedAfter: string;
  revision: number;
};

/** Message-owned identities and versions, mirrored by the atomic Redis projection. */
export class UserMentionIndex {
  private readonly latest = new Map<string, MentionState>();
  private readonly handledRefs = new Map<string, Set<string>>();
  private readonly undo = new Map<string, { userId: string; rows: Saved[] }>();
  private readonly lastUndo = new Map<string, string>();

  revisions(userId: string): Record<string, number> {
    return Object.fromEntries(
      [...this.latest].filter(([, s]) => s.ownerUserId === userId).map(([, s]) => [s.threadId, s.revision]),
    );
  }

  lastHandling(userId: string, get: (id: string) => StoredMessage | null) {
    const undoId = this.lastUndo.get(userId);
    const action = undoId ? this.undo.get(undoId) : null;
    return action && undoId
      ? {
          undoId,
          handled: action.rows.length,
          remaining: action.rows.filter((row) =>
            this.canUndo(this.latest.get(this.key(userId, row.threadId)), row, userId, get(row.messageId)),
          ).length,
        }
      : null;
  }

  handled(userId: string, get: (id: string) => StoredMessage | null): StoredMessage[] {
    return [...(this.handledRefs.get(userId) ?? [])]
      .map(get)
      .filter((m): m is StoredMessage => m !== null && m.userId === userId && userMentionEvent(m) === 'request')
      .sort((a, b) => b.id.localeCompare(a.id));
  }

  handle(userId: string, refs: Ref[]) {
    if (!refs.length || new Set(refs.map((r) => r.threadId)).size !== refs.length) return null;
    const rows: { ref: Ref; current: MentionState }[] = [];
    for (const ref of refs) {
      const current = this.latest.get(this.key(userId, ref.threadId));
      if (!current?.pending || current.id !== ref.messageId || !this.matchesRevision(current, ref.expectedRevision))
        return null;
      rows.push({ ref, current });
    }
    const handled = this.handledRefs.get(userId) ?? new Set<string>();
    this.handledRefs.set(userId, handled);
    const saved = rows.map(({ ref, current }) => ({
      ...ref,
      previous: current.closedThrough,
      previousRestored: current.restoredId,
      candidates: [...current.candidates],
      closedAfter: '',
      revision: 0,
    }));
    for (const [i, { ref, current }] of rows.entries()) {
      handled.add(ref.messageId);
      this.closeThrough(current, ref.messageId);
      saved[i].closedAfter = current.closedThrough;
      saved[i].revision = current.revision;
    }
    const old = this.lastUndo.get(userId);
    if (old) this.undo.delete(old);
    const undoId = randomUUID();
    this.undo.set(undoId, { userId, rows: saved });
    this.lastUndo.set(userId, undoId);
    return { handled: rows.length, undoId };
  }

  undoHandling(userId: string, undoId: string, get: (id: string) => StoredMessage | null) {
    const action = this.undo.get(undoId);
    if (!action || action.userId !== userId) return null;
    this.undo.delete(undoId);
    let restored = 0;
    for (const row of action.rows) {
      const current = this.latest.get(this.key(userId, row.threadId));
      const message = get(row.messageId);
      if (!this.canUndo(current, row, userId, message)) continue;
      current.closedThrough = row.previous;
      current.restoredId = row.previousRestored;
      current.pending = true;
      current.revision++;
      for (const id of row.candidates) current.candidates.add(id);
      this.handledRefs.get(userId)?.delete(row.messageId);
      restored++;
    }
    return { restored };
  }

  private canUndo(
    current: MentionState | undefined,
    row: Saved,
    userId: string,
    message: StoredMessage | null,
  ): current is MentionState {
    return (
      !!current &&
      !current.pending &&
      current.revision === row.revision &&
      current.closedThrough === row.closedAfter &&
      current.id === row.messageId &&
      !!message &&
      message.userId === userId &&
      message.threadId === row.threadId &&
      userMentionEvent(message) === 'request'
    );
  }

  restore(
    userId: string,
    threadId: string,
    messageId: string,
    expectedRevision: number,
    get: (id: string) => StoredMessage | null,
  ): boolean {
    const state = this.latest.get(this.key(userId, threadId));
    const message = get(messageId);
    if (
      !state ||
      state.pending ||
      state.revision !== expectedRevision ||
      !this.handledRefs.get(userId)?.has(messageId) ||
      !message ||
      message.userId !== userId ||
      message.threadId !== threadId ||
      userMentionEvent(message) !== 'request'
    )
      return false;
    state.id = messageId;
    state.restoredId = messageId;
    state.pending = true;
    state.candidates.add(messageId);
    state.revision++;
    this.handledRefs.get(userId)?.delete(messageId);
    return true;
  }

  private key(userId: string, threadId: string): string {
    return JSON.stringify([userId, threadId]);
  }

  observe(message: StoredMessage): void {
    const event = userMentionEvent(message);
    if (!event) return;
    const key = this.key(message.userId, message.threadId);
    const current = this.latest.get(key) ?? {
      ownerUserId: message.userId,
      threadId: message.threadId,
      id: '',
      pending: false,
      closedThrough: '',
      candidates: new Set<string>(),
      restoredId: '',
      revision: 0,
    };
    this.latest.set(key, current);
    if (message.id <= current.closedThrough) return;
    if (event === 'request') {
      if (!current.candidates.has(message.id)) current.revision++;
      current.candidates.add(message.id);
    } else this.closeThrough(current, message.id);
    if (current.id >= message.id) return;
    current.id = message.id;
    current.pending = event === 'request';
  }

  list(userId: string, get: (id: string) => StoredMessage | null): StoredMessage[] {
    const messages: StoredMessage[] = [];
    for (const current of this.latest.values()) {
      if (!current.pending || current.ownerUserId !== userId) continue;
      let found: StoredMessage | null = null;
      for (const id of [...current.candidates].sort().reverse()) {
        const message = get(id);
        if (
          (id > current.closedThrough || id === current.restoredId) &&
          message?.userId === userId &&
          userMentionEvent(message) === 'request'
        ) {
          found = message;
          break;
        }
        current.candidates.delete(id);
      }
      current.id = found?.id ?? current.closedThrough;
      current.pending = found !== null;
      if (found) messages.push(found);
    }
    return messages.sort((a, b) => b.id.localeCompare(a.id));
  }

  resolve(userId: string, threadId: string, expectedMessageId: string, expectedRevision?: number): boolean {
    const current = this.latest.get(this.key(userId, threadId));
    if (!current?.pending || current.id !== expectedMessageId || !this.matchesRevision(current, expectedRevision))
      return false;
    const handled = this.handledRefs.get(userId) ?? new Set<string>();
    this.handledRefs.set(userId, handled);
    handled.add(expectedMessageId);
    this.closeThrough(current, expectedMessageId);
    return true;
  }

  private matchesRevision(current: MentionState, revision?: number): boolean {
    return revision === undefined ? current.restoredId === '' : revision === current.revision;
  }

  private closeThrough(current: MentionState, id: string): void {
    if (current.id <= id || current.restoredId === current.id) current.pending = false;
    if (id > current.closedThrough) current.closedThrough = id;
    current.restoredId = '';
    current.revision++;
    for (const candidate of current.candidates)
      if (candidate <= current.closedThrough) current.candidates.delete(candidate);
  }
}
