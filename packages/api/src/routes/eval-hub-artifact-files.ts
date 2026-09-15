import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  isArtifactFileKey,
  SAFE_ARTIFACT_ID_PATTERN,
  SAFE_DOMAIN_SLUG_PATTERN,
} from '../infrastructure/harness-eval/artifact-store/artifact-store-layout.js';
import { readOwnerArtifactFile } from '../infrastructure/harness-eval/artifact-store/artifact-store-reader.js';

interface ArtifactFileParams {
  domainSlug: string;
  artifactId: string;
  fileKey: string;
}

/**
 * F257: opens the evidence files of a runtime verdict artifact for the Eval Hub.
 *
 * Runtime artifacts live outside every workspace, so they cannot be opened as
 * workspace files. The client names an artifact by its coordinates and a file by
 * a closed key — never by a path — and the server resolves both inside the
 * session user's own partition. Another owner's artifact is answered exactly like
 * one that does not exist.
 */
export function registerEvalHubArtifactFileRoute(app: FastifyInstance, artifactStoreRoot: string | undefined): void {
  app.get<{ Params: ArtifactFileParams }>(
    '/api/eval-hub/artifacts/:domainSlug/:artifactId/files/:fileKey',
    async (request, reply) => {
      // The owner key is a digest of the exact user id, so read it exactly as the
      // summary route and the publish principal do — no normalization of its own.
      const userId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
      if (!userId) return reply.status(401).send({ error: 'Session required' });

      const { domainSlug, artifactId, fileKey } = request.params;
      if (
        !SAFE_DOMAIN_SLUG_PATTERN.test(domainSlug) ||
        !SAFE_ARTIFACT_ID_PATTERN.test(artifactId) ||
        !isArtifactFileKey(fileKey)
      ) {
        return reply.status(400).send({ error: 'invalid_artifact_file_ref' });
      }
      if (!artifactStoreRoot) return reply.status(404).send({ error: 'artifact_not_found' });

      const file = await readOwnerArtifactFile(artifactStoreRoot, userId, { domainSlug, artifactId }, fileKey);
      if (file.status === 'not_found') return reply.status(404).send({ error: 'artifact_not_found' });
      return { fileKey, contentType: file.contentType, content: file.content, truncated: file.truncated };
    },
  );
}
