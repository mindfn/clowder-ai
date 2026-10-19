import { type CollectiveConnector, ConnectorTransportError } from '@cat-cafe/collective-connector';
import { collectiveMediaResponseHeaders, collectiveRetainedMediaRegistrationRequestSchema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CollectivePublishedMediaOwner } from '../domains/collaborative-content/collective-artifact/published-media-owner.js';
import { shareRetainedMedia } from '../domains/collaborative-content/collective-artifact/retained-media-share.js';
import { WorkspaceContentReviewError } from '../domains/collaborative-content/workspace-review/errors.js';
import { MediaOwnerError } from '../domains/video-studio/content-owner/media-errors.js';
import { ContentOwnerNotFoundError } from '../domains/video-studio/content-owner/service.js';
import { pluginAccessError, requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

const id = z.string().trim().min(1).max(256);
const selected = z
  .object({ connectionId: id, artifactId: id, ownerRevision: z.coerce.number().int().positive().safe() })
  .strict();

export interface CollectiveMediaRouteOptions {
  readonly runtime: { connector(): CollectiveConnector | undefined };
  readonly retainedMedia?: () => CollectivePublishedMediaOwner | undefined;
}

function directHuman(request: FastifyRequest, reply: FastifyReply, operation: 'read' | 'write') {
  if (
    request.headers['x-invocation-id'] ||
    request.headers['x-callback-token'] ||
    request.headers['x-agent-key-secret']
  ) {
    reply.code(401).send({ error: 'identity_required' });
    return undefined;
  }
  const access = requirePluginOwnerLocalAccess(request, operation);
  if ('error' in access) {
    reply.send(pluginAccessError(reply, access));
    return undefined;
  }
  return access.operator;
}

const unavailable = { status: 503, code: 'owner_unavailable' };
const transportFailures: Record<number, { status: number; code: string }> = {
  400: { status: 400, code: 'invalid_request' },
  401: { status: 403, code: 'access_denied' },
  403: { status: 403, code: 'access_denied' },
  409: { status: 409, code: 'conflict' },
  422: { status: 422, code: 'invalid_request' },
  429: { status: 429, code: 'busy' },
};
const ownerFailures: Record<string, { status: number; code: string }> = {
  access_denied: transportFailures[403],
  media_unavailable: unavailable,
  unsupported_content: { status: 422, code: 'unsupported_operation' },
};
function collectiveMediaRouteError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request' });
  if (error instanceof ContentOwnerNotFoundError) return reply.code(404).send({ error: 'not_found' });
  let failure = unavailable;
  if (error instanceof WorkspaceContentReviewError || error instanceof MediaOwnerError)
    failure = ownerFailures[error.code] ?? transportFailures[409];
  else if (error instanceof ConnectorTransportError) failure = transportFailures[error.statusCode ?? 0] ?? unavailable;
  return reply.code(failure.status).send({ error: failure.code });
}

/** Local session + this Cafe's existing pairing. No Service bearer or private source locator enters a media URL. */
export function registerCollectiveMediaRoutes(app: FastifyInstance, options: CollectiveMediaRouteOptions) {
  app.post('/api/plugins/collective-connector/:connectionId/artifacts/share-media/context', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const userId = directHuman(request, reply, 'read');
    if (!userId) return;
    try {
      const { connectionId } = z.object({ connectionId: id }).strict().parse(request.params);
      const input = collectiveRetainedMediaRegistrationRequestSchema
        .omit({
          serviceInstanceId: true,
          collectiveId: true,
          connectionId: true,
        })
        .parse(request.body);
      const connector = options.runtime.connector();
      if (!connector) return reply.code(503).send({ error: 'owner_unavailable' });
      return await connector.readArtifactRegistrationContext(connectionId, userId, input);
    } catch (error) {
      return collectiveMediaRouteError(reply, error);
    }
  });
  app.get('/api/plugins/collective-connector/:connectionId/artifacts/retained-media', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const userId = directHuman(request, reply, 'read');
    if (!userId) return;
    try {
      const { connectionId } = z.object({ connectionId: id }).strict().parse(request.params);
      const { after } = z.object({ after: id.optional() }).strict().parse(request.query);
      const connector = options.runtime.connector(),
        owner = options.retainedMedia?.();
      if (!connector || !owner) return reply.code(503).send({ error: 'owner_unavailable' });
      const route = await connector.getHostRoute(connectionId),
        connection = await connector.getProjection(connectionId);
      if (route?.localOwnerUserId !== userId || connection.authorityStatus !== 'connected')
        return reply.code(403).send({ error: 'access_denied' });
      return await owner.listRetained(userId, after);
    } catch (error) {
      return collectiveMediaRouteError(reply, error);
    }
  });
  app.post('/api/plugins/collective-connector/:connectionId/artifacts/share-media', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const userId = directHuman(request, reply, 'write');
    if (!userId) return;
    try {
      const { connectionId } = z.object({ connectionId: id }).strict().parse(request.params);
      const connector = options.runtime.connector(),
        media = options.retainedMedia?.();
      if (!connector || !media) return reply.code(503).send({ error: 'owner_unavailable' });
      return await shareRetainedMedia(connector, media, connectionId, userId, request.body);
    } catch (error) {
      return collectiveMediaRouteError(reply, error);
    }
  });
  app.get(
    '/api/plugins/collective-connector/:connectionId/artifacts/:artifactId/media/:ownerRevision',
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const userId = directHuman(request, reply, 'read');
      if (!userId) return;
      const controller = new AbortController();
      const abort = () => controller.abort();
      reply.raw.once('close', abort);
      try {
        const { connectionId, ...target } = selected.parse(request.params);
        const { sourceEventId } = z.object({ sourceEventId: id }).strict().parse(request.query);
        const range = z.string().min(1).max(256).optional().parse(request.headers.range);
        const connector = options.runtime.connector();
        if (!connector) return reply.code(503).send({ error: 'owner_unavailable' });
        const opened = await connector.openArtifactMedia(
          connectionId,
          userId,
          { ...target, sourceEventId, ...(range ? { range } : {}) },
          controller.signal,
        );
        for (const [name, value] of Object.entries(collectiveMediaResponseHeaders(opened.descriptor)))
          reply.header(name, value);
        return reply.code(opened.descriptor.status).send(opened.body);
      } catch (error) {
        controller.abort();
        return collectiveMediaRouteError(reply, error);
      }
    },
  );
}
