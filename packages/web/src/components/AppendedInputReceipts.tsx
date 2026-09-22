'use client';

import { useState } from 'react';
import type { ChatMessage } from '@/stores/chat-types';
import { focusLineageMessage } from '@/utils/focusLineageMessage';

const RECEIPT_ROW_HEIGHT_PX = 28;
const COLLAPSED_VISIBLE_ROWS = 3.5;

export function projectAppendedInputReceipts(
  response: ChatMessage,
  timelineMessages: readonly ChatMessage[],
): readonly ChatMessage[] {
  if (
    response.lifecycle?.kind !== 'response' ||
    response.lifecycle.inputEntryIds.length < 2 ||
    response.lifecycle.inputMessageIds.length < 2
  ) {
    return [];
  }
  const startedAt = response.lifecycle.startedAt;
  const byId = new Map(timelineMessages.map((message) => [message.id, message]));
  return response.lifecycle.inputMessageIds.slice(1).flatMap((messageId) => {
    const source = byId.get(messageId);
    return source && source.timestamp > startedAt ? [source] : [];
  });
}

function formatReceiptTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const part = (value: number) => String(value).padStart(2, '0');
  return `${part(date.getMonth() + 1)}/${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

function sourceLabel(message: ChatMessage, coCreatorName: string, getCatLabel: (catId: string) => string): string {
  switch (message.from?.kind) {
    case 'user':
      return coCreatorName;
    case 'agent':
      return getCatLabel(message.from.catId);
    case 'external':
      return message.from.sender?.name ?? message.source?.label ?? message.from.connectorId;
    case 'plugin':
      return message.source?.label ?? message.from.instanceId;
    case 'system':
      return message.from.service;
    default:
      return message.catId ? getCatLabel(message.catId) : coCreatorName;
  }
}

interface AppendedInputReceiptsProps {
  response: ChatMessage;
  timelineMessages: readonly ChatMessage[];
  coCreatorName: string;
  getCatLabel: (catId: string) => string;
}

export function AppendedInputReceipts({
  response,
  timelineMessages,
  coCreatorName,
  getCatLabel,
}: AppendedInputReceiptsProps) {
  const [expanded, setExpanded] = useState(false);
  const appendedInputs = projectAppendedInputReceipts(response, timelineMessages);
  if (appendedInputs.length === 0) return null;
  const renderedInputs = [...appendedInputs].reverse();
  const canExpand = renderedInputs.length > Math.floor(COLLAPSED_VISIBLE_ROWS);
  const collapsed = canExpand && !expanded;
  const collapsedHeight = RECEIPT_ROW_HEIGHT_PX * COLLAPSED_VISIBLE_ROWS;
  const fadeStart = RECEIPT_ROW_HEIGHT_PX * Math.floor(COLLAPSED_VISIBLE_ROWS);

  return (
    <section
      data-testid="appended-input-receipts"
      aria-label="补充消息"
      className="mt-2 border-t border-cafe px-1 pt-2 text-xs text-cafe-secondary"
    >
      <div className="font-semibold text-cafe-muted">补充消息</div>
      <ol
        data-testid="appended-input-list"
        data-collapsed={collapsed ? 'true' : 'false'}
        className="mt-1 overflow-hidden"
        style={
          collapsed
            ? {
                maxHeight: `${collapsedHeight}px`,
                WebkitMaskImage: `linear-gradient(to bottom, black 0, black ${fadeStart}px, transparent ${collapsedHeight}px)`,
                maskImage: `linear-gradient(to bottom, black 0, black ${fadeStart}px, transparent ${collapsedHeight}px)`,
              }
            : undefined
        }
      >
        {renderedInputs.map((source) => {
          const content = source.content.trim() || '（无文字内容）';
          return (
            <li
              key={source.id}
              data-appended-input-id={source.id}
              title={`${sourceLabel(source, coCreatorName, getCatLabel)} · ${formatReceiptTimestamp(source.timestamp)}\n${content}`}
              className="flex h-7 min-w-0 items-center gap-1.5"
            >
              <span className="shrink-0 font-medium">{sourceLabel(source, coCreatorName, getCatLabel)}:</span>
              <span className="w-72 max-w-[35vw] shrink truncate">{content}</span>
              <button
                type="button"
                className="shrink-0 font-medium text-[var(--color-cocreator-primary)] hover:underline"
                onClick={() => focusLineageMessage(source.id)}
              >
                查看原文
              </button>
            </li>
          );
        })}
      </ol>
      {canExpand && (
        <button
          type="button"
          aria-expanded={expanded}
          className="mt-1 block w-full text-center font-medium text-cafe-muted hover:text-cafe-secondary"
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? '收起' : `展开全部（${renderedInputs.length}）`}
        </button>
      )}
    </section>
  );
}
