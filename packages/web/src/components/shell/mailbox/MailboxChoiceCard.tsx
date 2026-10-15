import type { UnifiedAttentionChoiceRequest } from '@cat-cafe/shared';
import { RuntimeInteractionCard } from '../../rich/RuntimeInteractionCard';
import { useShellCopy } from '../shell-copy';
import { mailboxRuntimeCopy } from './mailbox-runtime.shell-copy';

/** The original F306 card and writer, with the containing read's owner and exact producer version. */
export function MailboxChoiceCard({
  choice,
  ownerUserId,
  readCurrent,
}: {
  choice: UnifiedAttentionChoiceRequest;
  ownerUserId: string;
  readCurrent: boolean;
}) {
  const copy = useShellCopy(mailboxRuntimeCopy);
  return (
    <RuntimeInteractionCard
      messageId={choice.cardRef.messageId}
      block={{
        kind: 'card',
        v: 1,
        id: choice.cardRef.blockId,
        title: choice.title,
        meta: { kind: 'runtime_interaction', interactionId: choice.interactionId },
      }}
      host={{ ownerUserId, revision: choice.revision, cardRef: choice.cardRef, readCurrent }}
      copy={copy}
    />
  );
}
