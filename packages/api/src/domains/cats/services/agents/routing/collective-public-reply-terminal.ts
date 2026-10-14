import type { TurnCustodyWakeProvenance } from '../../../../ball-custody/TurnCustodyProjectionService.js';
import type { CollectiveCurrentContext } from '../../../../plugin/builtin-runtime/collective-current-context.js';
import type { StoredMessage } from '../../stores/ports/MessageStore.js';
import type { InvocationRegistry } from '../invocation/InvocationRegistry.js';

/** Consumer seam: authority read failures keep the existing stop gate blocked. */
export async function readCollectivePublicReplyTerminal(input: {
  executionScope?: string;
  wake: TurnCustodyWakeProvenance;
  invocationId?: string;
  source?: StoredMessage | null;
  userId: string;
  threadId: string;
  catId: string;
  registry?: Pick<InvocationRegistry, 'peekRecord'>;
  collectiveContext?: () => CollectiveCurrentContext | undefined;
}) {
  if (
    input.executionScope !== 'collective-participation' ||
    input.wake.kind !== 'legacy' ||
    input.wake.reason !== 'carrier_missing' ||
    !input.invocationId ||
    input.source?.source?.connector !== 'collective'
  )
    return undefined;
  try {
    const auth = await input.registry?.peekRecord(input.invocationId);
    if (
      !auth ||
      auth.userId !== input.userId ||
      auth.threadId !== input.threadId ||
      auth.catId !== input.catId ||
      auth.originTriggerMessageId !== input.source.id
    )
      return undefined;
    return await input.collectiveContext?.()?.readAcceptedPublicReply(auth);
  } catch {
    return undefined;
  }
}
