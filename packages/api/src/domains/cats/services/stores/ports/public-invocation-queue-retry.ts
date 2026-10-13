import { snapshotPluginProtocolData } from '../../../../plugin/carrier/plugin-protocol-data.js';
import { assertPluginPublicInvocationCarrier } from './plugin-public-invocation-carrier.js';
import type { QueuedMessageCustody } from './queued-message-custody.js';

export function isPublicOutputNoReplayReason(reason: unknown): boolean {
  return reason === 'public_output_abandoned' || reason === 'public_output_conflict';
}

/** Retry authority comes from durable history, not the disposable live Queue maps. */
export function isPublicInvocationRetryForbidden(custody: QueuedMessageCustody, targetCatId: string): boolean {
  try {
    const selected: Record<string, unknown> = {};
    for (const key of [
      'sourceCategory',
      'pluginPublicInvocation',
      'seenInvocationIdByCatId',
      'awakenedInvocationIdByCatId',
      'bodyExposures',
      'targetAttempts',
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(custody, key);
      if (key in custody && (!descriptor || !('value' in descriptor))) return true;
      if (descriptor?.value !== undefined) selected[key] = descriptor.value;
    }
    const data = snapshotPluginProtocolData(selected) as Pick<
      QueuedMessageCustody,
      | 'sourceCategory'
      | 'pluginPublicInvocation'
      | 'seenInvocationIdByCatId'
      | 'awakenedInvocationIdByCatId'
      | 'bodyExposures'
      | 'targetAttempts'
    >;
    // A Task execution has one child. A new attempt requires a new Host execution receipt.
    if (data.sourceCategory === 'plugin_task')
      return Boolean(
        data.targetAttempts?.length ||
          data.bodyExposures?.length ||
          Object.keys(data.awakenedInvocationIdByCatId ?? {}).length ||
          Object.keys(data.seenInvocationIdByCatId ?? {}).length,
      );
    if (
      data.targetAttempts?.some(
        (attempt) => attempt.targetCatId === targetCatId && isPublicOutputNoReplayReason(attempt.terminalReason),
      )
    )
      return true;
    if (!('pluginPublicInvocation' in custody)) return false;
    assertPluginPublicInvocationCarrier(data.pluginPublicInvocation);
    if (data.pluginPublicInvocation.targetCatId !== targetCatId) return true;
    return (
      data.seenInvocationIdByCatId?.[targetCatId] !== undefined ||
      data.awakenedInvocationIdByCatId?.[targetCatId] !== undefined ||
      (data.bodyExposures ?? []).some((item) => item.targetCatId === targetCatId) ||
      (data.targetAttempts ?? []).some((item) => item.targetCatId === targetCatId && item.invocationId !== undefined)
    );
  } catch {
    // Malformed persisted identity cannot authorize a new execution.
    return true;
  }
}
