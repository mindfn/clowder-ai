import { isDeepStrictEqual } from 'node:util';
import type { CollectiveConnector } from '@cat-cafe/collective-connector';
import type { QueueCollectivePublicReplyWitness } from '@cat-cafe/shared';
import type { InvocationRecord } from '../../cats/services/agents/invocation/InvocationRegistry.js';
import type { requireCollectiveInvocationSource } from './collective-invocation-binding.js';

/** Read existing owner facts only: never prepares an operation, syncs or trusts provider DTOs. */
export async function readAcceptedPublicReply(
  auth: InvocationRecord,
  readBinding: () => ReturnType<typeof requireCollectiveInvocationSource>,
  readOperation: CollectiveConnector['readPublicReply'],
): Promise<QueueCollectivePublicReplyWitness | undefined> {
  const sourceMessageId = auth.originTriggerMessageId;
  if (!sourceMessageId || auth.collectiveWorkBinding || auth.executionGrant?.kind !== 'collective-participation')
    return undefined;
  try {
    const binding = await readBinding();
    if (binding.authority !== 'public_participation') return undefined;
    const operation = readOperation(binding.source, binding.sourceRef);
    if (
      operation?.status !== 'accepted' ||
      !operation.acceptedEventId?.trim() ||
      operation.agent?.catId !== auth.catId ||
      operation.agent.agentId !== auth.catId ||
      operation.sourceRef !== binding.sourceRef ||
      operation.workPurpose ||
      !isDeepStrictEqual(operation.replySource, binding.source)
    )
      return undefined;
    return {
      kind: 'collective_public_reply',
      sourceMessageId,
      sourceEventId: binding.source.eventId,
      acceptedEventId: operation.acceptedEventId,
    };
  } catch {
    // Revocation, changed grant/revision, missing source or unavailable authority remain blocked.
    return undefined;
  }
}
