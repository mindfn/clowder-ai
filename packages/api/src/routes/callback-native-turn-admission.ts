import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { pluginTaskCurrentnessInput } from '../domains/cats/services/agents/invocation/plugin-task-invocation-binding.js';
import { extractCallbackCredentials, requireCallbackPrincipal } from './callback-auth-prehandler.js';

/** Ordinary F317 admission retains its running check. Private effects require explicit Task scope. */
export function registerNativeTurnAdmissionRoute(
  app: FastifyInstance,
  registry?: Pick<InvocationRegistry, 'verifyLatest'>,
): void {
  app.get('/api/callbacks/native-turn-admission', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    if (principal.kind !== 'invocation') return reply.status(403).send({ error: 'invocation_required' });
    const scope = (request.query as { scope?: unknown } | undefined)?.scope;
    if (scope === undefined) return reply.status(204).send();
    if (scope !== 'plugin_task') return reply.status(400).send({ error: 'invalid_admission_scope' });
    const record = request.callbackAuth;
    const credentials = extractCallbackCredentials(request);
    if (!registry || !record?.pluginTaskBinding || !credentials || record.invocationId !== credentials.invocationId)
      return reply.status(403).send({ error: 'plugin_task_required' });
    try {
      const identity = pluginTaskCurrentnessInput(record);
      const verified = await registry.verifyLatest(credentials.invocationId, credentials.callbackToken);
      if (!verified.ok) return reply.status(401).send({ error: 'plugin_task_not_current', reason: verified.reason });
      if (
        !isDeepStrictEqual(identity, pluginTaskCurrentnessInput(verified.record)) ||
        !isDeepStrictEqual(identity, pluginTaskCurrentnessInput(record))
      )
        return reply.status(403).send({ error: 'plugin_task_identity_changed' });
      return reply.status(204).send();
    } catch {
      return reply.status(403).send({ error: 'plugin_task_admission_denied' });
    }
  });
}
