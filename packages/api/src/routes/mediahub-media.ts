/**
 * MediaHub Media Static File Route
 * Serves generated media (video, images) from mediahub outputs directory.
 * F138 Phase 4A (AC-4Ad)
 */

import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync } from 'fastify';

export interface MediahubMediaRoutesOptions {
  mediaDir: string;
}

export const mediahubMediaRoutes: FastifyPluginAsync<MediahubMediaRoutesOptions> = async (app, opts) => {
  await app.register(fastifyStatic, {
    root: resolve(opts.mediaDir),
    prefix: '/api/mediahub/media/',
    decorateReply: false,
  });
};
