import { isDeepStrictEqual } from 'node:util';
import type { InvocationRecord } from '../../cats/services/agents/invocation/InvocationRegistry.js';
import { collectiveContextError } from './collective-context-refs.js';
import type { CollectiveCurrentContext } from './collective-current-context.js';

/** One existing authority boundary shared by tools and the server's public-reply close reader. */
export async function requireCollectiveInvocationSource(
  auth: InvocationRecord,
  resolvePublic: CollectiveCurrentContext['resolvePublic'],
  resolvePrivate: (auth: InvocationRecord) => ReturnType<CollectiveCurrentContext['resolvePrivate']>,
) {
  if (auth.collectiveWorkBinding) {
    const binding = await resolvePrivate(auth);
    if (!binding) throw collectiveContextError('OWNER_ADMISSION_UNAVAILABLE', 'Current Task binding changed');
    return {
      ...binding,
      resultKey: binding.work.resultKey,
      refScope: `${binding.sourceRef}:work:${binding.work.task.id}:${binding.work.revision}:result:${binding.work.resultRevision}:execution:${binding.work.executionRevision}:${binding.work.executionRef ?? binding.work.authorityRef}`,
      workRef: { subjectRef: `task:work:${binding.work.task.id}`, revision: binding.work.revision },
      authority: 'owner_admitted_work' as const,
    };
  }
  if (
    !auth.executionGrant ||
    auth.ownerAuthProvenance !== 'unknown' ||
    auth.toolExecutionPolicy?.mode !== 'collective_participation'
  ) {
    throw collectiveContextError(
      'NOT_COLLECTIVE_ORIGIN',
      'Invocation has no direct Collective origin or admitted Task source',
    );
  }
  const binding = await resolvePublic(auth);
  if (!binding || !isDeepStrictEqual(binding.grant, auth.executionGrant))
    throw collectiveContextError('RETURN_UNAVAILABLE', 'Invocation source changed');
  return {
    ...binding,
    resultKey: 'request',
    refScope: binding.sourceRef,
    authority: 'public_participation' as const,
  };
}
