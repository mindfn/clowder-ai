import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryOwnerSourceCoordinate, MemoryOwnerSourceResponse } from '@cat-cafe/shared';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveThreadMessageVisibility } from '../domains/cats/services/stores/visibility.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import type { StoredProfileMemoryEntry } from '../domains/memory/profile/ProfileMemoryLifecycleStore.js';

export interface ProfileMemorySourceReaders {
  threadStore: Pick<IThreadStore, 'get' | 'list'>;
  messageStore: Pick<IMessageStore, 'getById'>;
}

interface ProfileProvenanceCoordinate {
  threadId?: string;
  messageId?: string;
  occurredAt: number | null;
}

export async function readProfileMemorySource(
  entry: StoredProfileMemoryEntry,
  ownerUserId: string,
  readers: ProfileMemorySourceReaders,
): Promise<MemoryOwnerSourceResponse> {
  const provenance = listTargetProvenance(entry);
  if (provenance.length === 0) return { status: 'not_recorded', sources: [] };
  const sources: MemoryOwnerSourceCoordinate[] = [];
  for (const coordinate of provenance) {
    const source = await projectCoordinate(coordinate, ownerUserId, readers);
    if (source && !sources.some((item) => sourceKey(item) === sourceKey(source))) sources.push(source);
  }
  return sources.length > 0 ? { status: 'ready', sources } : { status: 'unavailable', sources: [] };
}

function listTargetProvenance(entry: StoredProfileMemoryEntry): ProfileProvenanceCoordinate[] {
  const provenanceDir = join(entry.profileDir, 'provenance');
  if (!existsSync(provenanceDir)) return [];
  const result: ProfileProvenanceCoordinate[] = [];
  for (const file of readdirSync(provenanceDir, { withFileTypes: true })) {
    if (!file.isFile()) continue;
    const path = join(provenanceDir, file.name);
    let content: string;
    let modifiedAt: number;
    try {
      content = readFileSync(path, 'utf8');
      modifiedAt = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const fields = parseMetadata(content);
    if (fields.target !== entry.targetPath) continue;
    const threadId = fields.signalSourceThread ?? fields.thread;
    const messageId = fields.signalSourceMessage;
    result.push({
      ...(threadId ? { threadId } : {}),
      ...(messageId ? { messageId } : {}),
      occurredAt: Number.isFinite(modifiedAt) ? modifiedAt : null,
    });
  }
  return result;
}

function parseMetadata(content: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of content.split('\n')) {
    if (line.startsWith('## ')) break;
    const match = /^- ([A-Za-z][A-Za-z0-9]*): (.+)$/.exec(line);
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}

async function projectCoordinate(
  coordinate: ProfileProvenanceCoordinate,
  ownerUserId: string,
  readers: ProfileMemorySourceReaders,
): Promise<MemoryOwnerSourceCoordinate | null> {
  if (!coordinate.threadId) {
    return { label: '画像更新记录', occurredAt: coordinate.occurredAt, canOpen: false };
  }
  const thread = await readers.threadStore.get(coordinate.threadId);
  if (!thread || thread.deletedAt || !(await canReadThread(thread, ownerUserId, readers.threadStore))) return null;
  if (!coordinate.messageId) {
    return { label: thread.title?.trim() || '画像更新记录', occurredAt: coordinate.occurredAt, canOpen: false };
  }
  const message = await readers.messageStore.getById(coordinate.messageId);
  if (!message || message.threadId !== thread.id || message.deletedAt) return null;
  if (!resolveThreadMessageVisibility({ includeQueuedUserMessages: true }, ownerUserId)(message)) return null;
  return {
    label: thread.title?.trim() || '画像来源',
    occurredAt: message.timestamp,
    canOpen: true,
    threadId: thread.id,
    messageId: message.id,
  };
}

async function canReadThread(
  thread: Awaited<ReturnType<IThreadStore['get']>> & {},
  ownerUserId: string,
  store: Pick<IThreadStore, 'list'>,
): Promise<boolean> {
  if (canAccessThread(thread, ownerUserId)) return true;
  return thread.createdBy === 'system' && (await store.list(ownerUserId)).some((item) => item.id === thread.id);
}

function sourceKey(source: MemoryOwnerSourceCoordinate): string {
  return `${source.threadId ?? ''}\0${source.messageId ?? ''}\0${source.label}`;
}
