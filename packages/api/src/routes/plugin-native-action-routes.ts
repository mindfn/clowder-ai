import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { toolExecutionPolicyDenial } from '../domains/cats/services/agents/invocation/tool-execution-policy.js';
import { NativePluginActionError, type NativePluginActions } from '../domains/plugin/declared/native-plugin-actions.js';
import { registerCallbackAuthHook } from './callback-auth-prehandler.js';
import { getDeletedCallbackThreadGuard } from './callback-scope-helpers.js';
import { captureTypedWaitSource } from './callback-typed-wait-source.js';

export interface PluginNativeActionRouteOptions {
  readonly actions: NativePluginActions;
  readonly registry: Pick<InvocationRegistry, 'verify' | 'verifyLatest' | 'isStartupRecoveryComplete'>;
  readonly sources: Parameters<typeof captureTypedWaitSource>[1];
  readonly threadStore?: Parameters<typeof getDeletedCallbackThreadGuard>[0];
}

const bodySchema = z.object({ method: z.string().min(1).max(256), input: z.unknown() }).strict();

/** Native plugin MCP transport; business identity never comes from tool arguments. */
export const pluginNativeActionRoutes: FastifyPluginAsync<PluginNativeActionRouteOptions> = async (app, options) => {
  registerCallbackAuthHook(app, options.registry, {
    pluginNativeActionTarget: (request) => {
      const token = request.headers['x-clowder-plugin-action-token'];
      const parsed = bodySchema.safeParse(request.body);
      return typeof token === 'string' && parsed.success
        ? options.actions.target(token, parsed.data.method)
        : undefined;
    },
  });
  app.post('/api/plugin-runtime/action', { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const invocationId = request.headers['x-invocation-id'];
    const callbackToken = request.headers['x-callback-token'];
    const token = request.headers['x-clowder-plugin-action-token'];
    if (typeof invocationId !== 'string' || typeof callbackToken !== 'string' || typeof token !== 'string') {
      return reply.status(401).send({ error: 'Native plugin invocation credentials required' });
    }
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid plugin action input' });
    const verified = await options.registry.verifyLatest(invocationId, callbackToken);
    if (!verified.ok) return reply.status(401).send({ error: 'Invocation is not current' });
    const { record } = verified;
    const deleted = await getDeletedCallbackThreadGuard(options.threadStore, record.threadId);
    if (deleted) return reply.status(deleted.statusCode).send(deleted.body);
    const source = await captureTypedWaitSource(record, options.sources);
    const target = options.actions.target(token, parsed.data.method);
    try {
      const result = await options.actions.call(token, parsed.data.method, parsed.data.input, {
        catId: record.catId,
        userId: record.userId,
        threadId: record.threadId,
        invocationId: record.invocationId,
        ...(source ? { source: Object.freeze(source) } : {}),
        assertCurrent: async () => {
          if (await getDeletedCallbackThreadGuard(options.threadStore, record.threadId)) {
            throw new NativePluginActionError(410, 'Thread is deleted');
          }
          const current = await options.registry.verifyLatest(invocationId, callbackToken);
          if (!current.ok) throw new NativePluginActionError(409, 'Invocation is no longer current');
          if (
            toolExecutionPolicyDenial(current.record.toolExecutionPolicy, 'POST /api/plugin-runtime/action', target)
          ) {
            throw new NativePluginActionError(403, 'Invocation policy denies plugin action');
          }
        },
      });
      return { result };
    } catch (error) {
      if (error instanceof NativePluginActionError)
        return reply.status(error.statusCode).send({ error: error.message });
      // Package failures may contain provider secrets; do not serialize arbitrary exception text.
      return reply.status(502).send({ error: 'Plugin action failed' });
    }
  });
};
