'use client';

import type { QueueAwaitingReadInput } from '@cat-cafe/shared';
import { create } from 'zustand';

/**
 * F117 Phase M: inputs handed to a running cat and not read yet, per thread. They have no Queue row;
 * the authoritative `/queue` response projects them from History beside the pending rows.
 */
interface AwaitingReadState {
  rowsByThread: Record<string, readonly QueueAwaitingReadInput[]>;
  setRows: (threadId: string, rows: readonly QueueAwaitingReadInput[]) => void;
}

export const useAwaitingReadStore = create<AwaitingReadState>((set) => ({
  rowsByThread: {},
  setRows: (threadId, rows) => set((state) => ({ rowsByThread: { ...state.rowsByThread, [threadId]: rows } })),
}));

/** Only an authoritative `/queue` response replaces the rows; a response without the field keeps them. */
export function applyAwaitingReadFromQueueResponse(threadId: string, data: unknown): void {
  const rows = (data as { awaitingRead?: unknown } | null | undefined)?.awaitingRead;
  if (Array.isArray(rows)) useAwaitingReadStore.getState().setRows(threadId, rows as QueueAwaitingReadInput[]);
}
