'use client';

import type { MessageFrom, QueueAwaitingReadInput } from '@cat-cafe/shared';
import { AvatarImageWithFallback } from './AvatarImageWithFallback';

interface AwaitingReadRowsProps {
  rows: readonly QueueAwaitingReadInput[];
  ownerName: string;
  ownerAvatar?: string;
  resolveCatName: (catId: string) => string;
  resolveCatAvatar: (catId: string) => string | undefined;
}

function sourceLabel(from: MessageFrom, ownerName: string, resolveCatName: (catId: string) => string): string {
  switch (from.kind) {
    case 'agent':
      return resolveCatName(from.catId);
    case 'user':
      return ownerName;
    case 'external':
      return from.sender?.name ?? 'Connector';
    case 'plugin':
      return 'Plugin';
    case 'system':
      return from.service;
  }
}

/**
 * F117 Phase M: inputs already handed to a running cat whose model has not read them yet. They have
 * left the Queue — the carrier holds them, so there is nothing to reorder, withdraw or steer — and
 * they move under that cat's reply, with their read time, once it reads them.
 */
export function AwaitingReadRows({
  rows,
  ownerName,
  ownerAvatar,
  resolveCatName,
  resolveCatAvatar,
}: AwaitingReadRowsProps) {
  if (rows.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 p-1" data-testid="queue-awaiting-read" aria-label="等待读取">
      {rows.map((row) => {
        const catName = resolveCatName(row.targetId);
        const avatar =
          row.from.kind === 'agent'
            ? resolveCatAvatar(row.from.catId)
            : row.from.kind === 'user'
              ? ownerAvatar
              : undefined;
        return (
          <li
            key={`${row.messageId}:${row.targetId}`}
            data-awaiting-read-message={row.messageId}
            data-awaiting-read-target={row.targetId}
            className="flex items-start gap-2 px-3 py-2 rounded-lg opacity-80"
            title={`已交给${catName}，等待读取；读到后会移到回复下面`}
          >
            <AvatarImageWithFallback src={avatar} alt="" className="h-5 w-5 shrink-0 rounded-full object-cover" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="font-medium text-cafe-secondary">
                  {sourceLabel(row.from, ownerName, resolveCatName)}
                </span>
                <span className="text-micro text-cafe-muted">等待读取 → {catName}</span>
              </div>
              <p className="truncate text-xs text-cafe-secondary">{row.content.trim() || '（无文字内容）'}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
