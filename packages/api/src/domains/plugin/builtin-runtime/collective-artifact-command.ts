import { createHash } from 'node:crypto';
import type { CollectiveConnector } from '@cat-cafe/collective-connector';
import type { CollectiveArtifactCommand } from '@cat-cafe/shared';
import type { InvocationRecord } from '../../cats/services/agents/invocation/InvocationRegistry.js';
import { collectiveContextError, verifyRef } from './collective-context-refs.js';
import type { requireCollectiveInvocationSource } from './collective-invocation-binding.js';

/** Current invocation and durable source select the resource. Callers cannot supply a Human, connection or private Task. */
export async function executeCollectiveArtifactCommand(input: {
  auth: InvocationRecord;
  contextRef: string;
  command: CollectiveArtifactCommand;
  connector: CollectiveConnector;
  resolveSource: () => ReturnType<typeof requireCollectiveInvocationSource>;
}) {
  const binding = await input.resolveSource();
  verifyRef(input.auth, input.contextRef, 'context', binding.refScope);
  const context = await input.connector.readArtifactContext(binding.source);
  const target = context.requests.find((item) => item.artifactId === input.command.artifactId);
  if (context.status !== 'available' || !target)
    throw collectiveContextError(
      'ARTIFACT_ACCESS_DENIED',
      'This invocation source has no current shared work reference',
    );
  const { artifactId: _artifactId, kind, ...command } = input.command;
  const operation = input.command.kind === 'respond' ? input.command.operationId : command;
  const requestId = `artifact-command:${createHash('sha256')
    .update(JSON.stringify([binding.source.eventId, target.artifactId, kind, operation]))
    .digest('hex')}`;
  const value = await input.connector.requestArtifactForAgent(
    binding.source,
    {
      catId: input.auth.catId,
      agentId: input.auth.catId,
      displayName: binding.displayName,
      sessionRef: input.auth.invocationId,
    },
    {
      artifactId: target.artifactId,
      sourceEventId: target.sourceEventId,
      ownerRevision: target.ownerRevision,
      action: kind === 'respond' ? 'propose' : 'read',
      requestId,
      payload: kind === 'respond' ? { ...command, kind: 'respond-modification' } : command,
    },
  );
  const fresh = await input.resolveSource();
  if (fresh.refScope !== binding.refScope)
    throw collectiveContextError('RETURN_REF_INVALID', 'Current shared work source changed during owner RPC');
  return value;
}
