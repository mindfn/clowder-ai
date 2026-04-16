/**
 * Unified callback auth preHandler (#476)
 *
 * Extracts X-Invocation-Id + X-Callback-Token from HTTP headers,
 * verifies via InvocationRegistry, and decorates request.callbackAuth.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { EXPIRED_CREDENTIALS_ERROR } from './callback-errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    callbackAuth?: InvocationRecord;
  }
}

interface CallbackAuthRegistry {
  verify(invocationId: string, callbackToken: string): InvocationRecord | null;
}

/** Register the callbackAuth decoration + preHandler on a Fastify instance. */
export function registerCallbackAuthHook(app: FastifyInstance, registry: CallbackAuthRegistry): void {
  app.decorateRequest('callbackAuth', undefined);
  app.addHook('preHandler', async (request: FastifyRequest) => {
    const invocationId = firstHeaderValue(request.headers['x-invocation-id']);
    const callbackToken = firstHeaderValue(request.headers['x-callback-token']);
    if (!invocationId || !callbackToken) return;
    const record = registry.verify(invocationId, callbackToken);
    if (record) {
      request.callbackAuth = record;
    }
  });
}

/** Require callbackAuth on the request — returns record or sends 401. */
export function requireCallbackAuth(request: FastifyRequest, reply: FastifyReply): InvocationRecord | null {
  if (request.callbackAuth) return request.callbackAuth;
  reply.status(401);
  reply.send(EXPIRED_CREDENTIALS_ERROR);
  return null;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (Array.isArray(value)) return value[0] || undefined;
  return undefined;
}
