'use client';

import { useCallback, useRef } from 'react';
import { useCloudBindingChanges } from './cloud-binding-events';
import { readBoundConversationId } from './cloud-binding-recovery-operations';

interface Observation {
  ticket: number;
  conversationId: string | null;
}

/**
 * Keeps a recovery card's "which conversation is bound" true while the thread panel writes the same
 * binding (F202 h3c-1).
 *
 * Every observation of the binding takes a ticket when it starts — a full read of the card, a read of
 * the binding alone, or the card's own write — and a later-started observation is never replaced by an
 * earlier one. A change announced elsewhere is read at once, with a read that starts after any already
 * in flight; except while the card's own write is out, since that read could land before the write
 * does. Then the change is kept, the write's answer is not trusted, and the binding is read once the
 * write is over. A write that ends without an answer is read back too: it may have landed anyway.
 */
export function useRecoveryBindingSync(args: {
  threadId: string;
  targetCatId: string;
  source: string;
  show: (conversationId: string | null) => void;
}) {
  const { threadId, targetCatId, source } = args;
  const showRef = useRef(args.show);
  showRef.current = args.show;
  const ticketRef = useRef(0);
  const latestRef = useRef<Observation | null>(null);
  const ownWriteRef = useRef<{ ticket: number; changedElsewhere: boolean } | null>(null);

  const observe = useCallback((ticket: number, conversationId: string | null): boolean => {
    if (latestRef.current && latestRef.current.ticket > ticket) return false;
    latestRef.current = { ticket, conversationId };
    return true;
  }, []);

  const readBinding = useCallback(async () => {
    const ticket = ++ticketRef.current;
    const conversationId = await readBoundConversationId(threadId, targetCatId);
    if (conversationId !== undefined && observe(ticket, conversationId)) showRef.current(conversationId);
  }, [threadId, targetCatId, observe]);

  useCloudBindingChanges(threadId, source, () => {
    if (ownWriteRef.current) ownWriteRef.current.changedElsewhere = true;
    else void readBinding();
  });

  return {
    /** A full read is starting: its ticket. */
    beginRead: useCallback(() => ++ticketRef.current, []),
    /** The binding a full read with this ticket should show: its own, unless a later one has been seen. */
    settleRead: useCallback(
      (ticket: number, conversationId: string | null) =>
        observe(ticket, conversationId) ? conversationId : (latestRef.current?.conversationId ?? null),
      [observe],
    ),
    /** The card's own write is going out. */
    beginWrite: useCallback(() => {
      ownWriteRef.current = { ticket: ++ticketRef.current, changedElsewhere: false };
    }, []),
    /** The card's own write answered that `conversationId` is bound: whether to show that answer. */
    writeLanded: useCallback(
      (conversationId: string): boolean => {
        const write = ownWriteRef.current;
        ownWriteRef.current = null;
        if (!write) return true;
        if (!write.changedElsewhere) return observe(write.ticket, conversationId);
        void readBinding();
        return false;
      },
      [observe, readBinding],
    ),
    /** The card's operation is over; a write of it that never landed is read back. */
    operationEnded: useCallback(() => {
      if (!ownWriteRef.current) return;
      ownWriteRef.current = null;
      void readBinding();
    }, [readBinding]),
  };
}
