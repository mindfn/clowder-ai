'use client';

import type { ReplyPreview } from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { tintOf } from '@/lib/hex-color';
import { resolveMessageSender } from '@/lib/resolve-sender';
import { focusLineageMessage } from '@/utils/focusLineageMessage';
import { SenderAvatar } from './SenderAvatar';

interface ReplyPillProps {
  replyPreview: ReplyPreview;
  replyToId: string;
  getCatById: (id: string) => CatData | undefined;
}

/**
 * F121: Reply pill badge — shows "↩ @猫名: 摘要" in breed color.
 * DirectionPill 同款药丸风格，click scrolls to original message.
 */
export function ReplyPill({ replyPreview, replyToId, getCatById }: ReplyPillProps) {
  const coCreator = useCoCreatorConfig();
  const { content, deleted } = replyPreview;

  const sender = resolveMessageSender(replyPreview, getCatById, coCreator);
  const senderLabel = deleted ? '' : sender.label;
  const previewText = deleted ? '消息已删除' : content;

  const handleClick = () => {
    focusLineageMessage(replyToId);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="text-micro font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap max-w-[200px] truncate cursor-pointer hover:opacity-80 transition-opacity"
      style={{ backgroundColor: tintOf(sender.color, '20'), color: sender.textColor }}
      title={deleted ? '消息已删除' : `${senderLabel}: ${content}`}
    >
      {!deleted && <SenderAvatar sender={sender} className="inline-block h-3 w-3" />}↩ {senderLabel}
      {senderLabel && !deleted ? ': ' : ''}
      {previewText}
    </button>
  );
}
