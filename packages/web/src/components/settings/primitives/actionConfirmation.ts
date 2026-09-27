'use client';

import { useCallback } from 'react';
import { useOptionalConfirm } from '../../useConfirm';

/**
 * F202 W2-3 h1: an action whose manifest declares `confirm` must be confirmed by the owner before
 * every invocation, in the shared Console dialog rather than a browser prompt. A row's own
 * `confirm` may replace the wording, or ask where the action declares none, but it never removes
 * the step. With no dialog available the confirmation fails closed and nothing is invoked.
 */
export function useActionConfirmation() {
  const confirm = useOptionalConfirm();
  return useCallback(
    async (label: string, declared?: string, rowWording?: string): Promise<boolean> => {
      const message = rowWording ?? declared;
      if (message === undefined) return true;
      if (!confirm) return false;
      return confirm({ title: label, message, variant: 'danger' });
    },
    [confirm],
  );
}
