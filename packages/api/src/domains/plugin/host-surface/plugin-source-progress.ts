import { isDelivered, type StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import {
  assertQueueCustodyMessageBinding,
  assertQueuedMessageCustody,
} from '../../cats/services/stores/ports/queued-message-custody.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { PluginSourceFact } from './plugin-source-facts-host.js';

export interface PluginQueueProgress {
  readonly status: 'queued' | 'processing' | 'terminal';
  readonly allTargetCats: readonly string[];
  readonly handledByCatIds: readonly string[];
  readonly failedByCatIds: readonly string[];
  readonly seenByCatIds: readonly string[];
  readonly bodyExposures?: readonly { readonly targetCatId: string }[];
  readonly targetOutcomeByCatId?: Readonly<Record<string, { readonly handledAt: number }>>;
}

/** Owner display facts only: no message body, invocation credentials or authority. */
export type PluginSourceProgressFact = Omit<PluginSourceFact, 'content'> & {
  readonly queueCustody?: PluginQueueProgress;
};

export function projectPluginQueueProgress(message: StoredMessage, userId: string): PluginQueueProgress | undefined {
  const refuse = (): never => {
    throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Plugin source progress is unavailable');
  };
  if (!isDelivered(message) && message.deliveryStatus !== 'queued') refuse();
  const custody = message.queueCustody;
  if (!custody) {
    assertQueueCustodyMessageBinding(message);
    if (message.queueCustodyAdmission && message.queueCustodyAdmission.ownerUserId !== userId) refuse();
    return undefined;
  }
  // Append binding validates queued rows only. The real delivery transition retains
  // terminal custody on delivered rows, so validate its canonical schema separately.
  assertQueuedMessageCustody(custody);
  if (
    message.catId !== null ||
    custody.ownerUserId !== userId ||
    message.queueCustodyAdmission ||
    (message.deliveryStatus !== 'queued' && (!isDelivered(message) || custody.status !== 'terminal'))
  )
    refuse();
  const carrier = custody.pluginPublicInvocation;
  if (
    carrier &&
    (carrier.sourceMessageId !== message.id ||
      carrier.pluginInstanceId !== message.extra?.pluginMessage?.instanceId ||
      carrier.sourcePluginRevision !== message.extra?.pluginMessage?.revision)
  )
    refuse();
  return {
    status: custody.status,
    allTargetCats: custody.allTargetCats,
    handledByCatIds: custody.handledByCatIds,
    failedByCatIds: custody.failedByCatIds,
    seenByCatIds: custody.seenByCatIds,
    ...(custody.bodyExposures === undefined
      ? {}
      : {
          bodyExposures: custody.bodyExposures.map(({ targetCatId }) => ({ targetCatId })),
        }),
    ...(custody.targetOutcomeByCatId === undefined
      ? {}
      : {
          targetOutcomeByCatId: Object.fromEntries(
            Object.entries(custody.targetOutcomeByCatId).map(([catId, outcome]) => [
              catId,
              { handledAt: outcome.handledAt },
            ]),
          ),
        }),
  };
}
