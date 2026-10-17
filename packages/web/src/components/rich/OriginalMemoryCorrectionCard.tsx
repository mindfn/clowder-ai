'use client';
import type { ApprovalHubItem, RichCardBlock } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApprovalHostContext, PERMISSIVE_APPROVAL_HOST } from '@/components/ApprovalHost';
import { MemoryCorrectionApprovalCard } from '@/components/memory/page/MemoryCorrectionApprovalCard';
import { memoryCorrectionCopy } from '@/components/memory/page/memory-correction.shell-copy';
import {
  correctionPublicationCandidate,
  readPublishedCorrection,
} from '@/components/memory/page/read-correction-approval';
import { readCorrectionResult } from '@/components/memory/page/read-correction-result';
import { describeReconcile } from '@/components/shell/mailbox/approval-reconcile';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellLanguage } from '@/components/shell/shell-language';
import { UNIFIED_ATTENTION_INVALIDATION_EVENTS } from '@/components/shell/use-unified-attention';

/** A Chat card is a locator. Canonical publication membership and original owner memory supply its contents and writer. */
export function OriginalMemoryCorrectionCard({
  block,
  coordinate,
}: {
  block: RichCardBlock;
  coordinate?: { threadId: string; messageId: string };
}) {
  const t = useShellCopy(memoryCorrectionCopy),
    language = useShellLanguage();
  const [item, setItem] = useState<ApprovalHubItem | null>(null),
    [line, setLine] = useState<string | null>(null);
  const [checking, setChecking] = useState(true),
    [writing, setWriting] = useState(false);
  const current = useRef<ApprovalHubItem | null>(null),
    generation = useRef(0);
  const threadId = coordinate?.threadId,
    messageId = coordinate?.messageId;
  const refresh = useCallback(async () => {
    const round = ++generation.current;
    current.current = null;
    setChecking(true);
    setLine(null);
    try {
      const next = threadId && messageId ? await readPublishedCorrection(block, { threadId, messageId }) : null;
      let resultLine: string | null = null;
      if (!next && threadId && messageId) {
        const proposalId = correctionPublicationCandidate(block);
        if (proposalId) {
          const result = await readCorrectionResult(proposalId, { threadId, messageId });
          if (result)
            resultLine = describeReconcile(
              { kind: 'decided', terminal: result.terminal },
              {
                language,
                ownerUserId: result.ownerUserId,
                originalEffect: result.effect ? 'memory-corrected' : undefined,
              },
            ).line;
        }
      }
      if (round !== generation.current) return;
      current.current = next;
      setItem(next);
      setLine(resultLine);
    } catch {
      if (round === generation.current) setItem(null);
    } finally {
      if (round === generation.current) setChecking(false);
    }
  }, [block, threadId, messageId, language]);
  useEffect(() => {
    void refresh();
    const invalidate = () => {
      void refresh();
    };
    for (const event of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.addEventListener(event, invalidate);
    return () => {
      ++generation.current;
      current.current = null;
      for (const event of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.removeEventListener(event, invalidate);
    };
  }, [refresh]);
  return (
    <ApprovalHostContext.Provider
      value={{
        ...PERMISSIVE_APPROVAL_HOST,
        presentation: 'mailbox',
        writesLocked: !item || checking || writing,
        authorizeWrite: () => Boolean(current.current && !writing),
        reportRequest: (event) => {
          setWriting(event.phase === 'start');
          if (event.phase === 'end') void refresh();
        },
      }}
    >
      {item ? (
        <MemoryCorrectionApprovalCard item={item} />
      ) : (
        <p data-testid={line ? 'memory-correction-chat-result' : undefined} className="text-sm text-cafe-muted">
          {line ?? (checking ? t.checking : t.unavailable)}
        </p>
      )}
      {!item ? (
        <button
          type="button"
          className="shell-focusable rounded px-2 py-1 text-xs"
          onClick={() => {
            void refresh();
          }}
        >
          {t.reread.事件}
        </button>
      ) : null}
    </ApprovalHostContext.Provider>
  );
}
