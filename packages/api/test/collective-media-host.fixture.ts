import { CollectiveConnector } from '@cat-cafe/collective-connector';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { CollectivePublishedMediaOwner } from '../src/domains/collaborative-content/collective-artifact/published-media-owner.js';
import { registerCollectiveConnectorRoutes } from '../src/routes/collective-connector-routes.js';

export async function mediaHostFixture(
  t: { after(fn: () => Promise<unknown>): void },
  directory: string,
  retainedMedia?: CollectivePublishedMediaOwner,
  listen: { port?: number; hostOrigin?: string; connector?: CollectiveConnector } = {},
) {
  // Exercise the published Connector implementation used by the API, with the real persisted pairing.
  const connector =
    listen.connector ?? (await CollectiveConnector.open({ dataDirectory: directory, verifyAgent: async () => false }));
  if (!listen.connector) t.after(() => connector.stopMediaReads());
  const app = Fastify();
  if (listen.hostOrigin) await app.register(cors, { origin: listen.hostOrigin, credentials: true });
  // The production session issuer supplies this principal. Never derive it from URL/body/iframe data.
  app.addHook('preHandler', async (request) => {
    const cookie = request.headers.cookie;
    if (cookie === 'test-session=reader') request.sessionUserId = 'reader-private-human';
    if (cookie === 'test-session=publisher') request.sessionUserId = 'operator';
  });
  app.get('/api/session', async (request, reply) =>
    request.sessionUserId
      ? { userId: request.sessionUserId }
      : reply.code(401).send({ error: 'fixture session required' }),
  );
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected setup operation');
  };
  const options = {
    runtime: { connector: () => connector },
    retainedMedia: () => retainedMedia,
    localService: {
      status: async () => ({ state: 'not_created' as const, serviceUrl: '', dataDirectory: '' }),
      provision: unused,
    },
    callbackRegistry: { verify: async () => ({ ok: false as const, reason: 'invalid_token' as const }) },
    resolveAgentIdentity: () => undefined,
    threadStore: { get: () => null },
    isCatAvailable: () => false,
    cats: () => [],
  };
  registerCollectiveConnectorRoutes(app, options);
  await app.listen({ host: '127.0.0.1', port: listen.port ?? 0 });
  t.after(() => app.close());
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  return { app, url: `http://127.0.0.1:${address.port}` };
}
