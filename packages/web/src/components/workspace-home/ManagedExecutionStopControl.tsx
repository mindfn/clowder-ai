'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { type RefObject, useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ExecutionCancelButton } from '@/components/ExecutionCancelButton';
import { executionRowCopy } from '@/components/execution-row/execution-row.shell-copy';
import { useShellCopy } from '@/components/shell/shell-copy';
import { cancelProjectedExecution } from '@/hooks/useActiveExecutionProjection';
import { useCatData } from '@/hooks/useCatData';
import { resolveCatNameplateName } from '@/lib/cat-display-name';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useToastStore } from '@/stores/toastStore';
import { executionDetailCopy } from './execution-detail.shell-copy';

/** Confirm against the frozen detail, then consume the original owner's current cancellation capability. */
export function ManagedExecutionStopControl({
  execution,
  returnFocusRef,
}: {
  execution: ActiveExecutionProjection;
  returnFocusRef: RefObject<HTMLElement>;
}) {
  const words = useShellCopy(executionDetailCopy);
  const rowWords = useShellCopy(executionRowCopy);
  const { getCatById } = useCatData({ fetch: false });
  const activity = rowWords.activity[execution.activity ?? 'command'];
  const stopLabel = getCatById(execution.catId)
    ? words.stopExecution(resolveCatNameplateName(execution.catId, getCatById), activity)
    : words.stopActivity(activity);
  const [confirming, setConfirming] = useState(false);
  const cancelable = execution.cancelability.state === 'cancelable';
  useEffect(() => {
    if (!cancelable) setConfirming(false);
  }, [cancelable]);
  const stop = async () => {
    setConfirming(false);
    const current = useActiveExecutionStore.getState().executionsByKey[activeExecutionKey(execution)];
    if (
      !current ||
      current.kind !== execution.kind ||
      current.executionId !== execution.executionId ||
      current.catId !== execution.catId ||
      current.threadId !== execution.threadId ||
      current.startedAt !== execution.startedAt ||
      current.cancelability.state !== 'cancelable'
    )
      return;
    try {
      await cancelProjectedExecution(current);
    } catch (error) {
      useToastStore.getState().addToast({
        type: 'error',
        title: words.stopFailed,
        message: error instanceof Error ? error.message : words.stopRetry,
        duration: 5000,
      });
    }
  };
  return (
    <div className="mt-3">
      <ExecutionCancelButton
        execution={execution}
        label={words.stop}
        ariaLabel={stopLabel}
        pendingLabel={words.stopping}
        nonCancelableCopy={words.blocked}
        className="home-btn shell-focusable text-xs"
        onRequestCancel={() => setConfirming(true)}
      />
      <ConfirmDialog
        open={confirming && cancelable}
        title={words.confirmStop(activity)}
        message={words.confirmMessage}
        confirmLabel={words.stop}
        cancelLabel={words.cancel}
        variant="danger"
        returnFocusRef={returnFocusRef}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void stop()}
      />
    </div>
  );
}
