import { createHash } from 'node:crypto';
import type { WorkspaceContentSourceService } from '../../workspace/workspace-content-source.js';
import { probeImmutableMedia } from '../content-owner/published-media-probe.js';
import {
  ContentOwnerConflictError,
  ContentOwnerIdempotencyError,
  ContentOwnerNotFoundError,
  type ProjectContentOwnerService,
} from '../content-owner/service.js';
import { digestBytes } from '../content-owner/store.js';
import type { VideoProjectMediaScopeV1 } from '../content-owner/types.js';
import { sameProjectValue } from './document-mutations.js';
import {
  type AuthorizeScreeningCatSource,
  type RegisterVideoProjectScreeningInput,
  VideoProjectScreeningError,
} from './screening-types.js';
import type { VideoProjectReadPort } from './types.js';

interface ScreeningMediaDependencies {
  owner: ProjectContentOwnerService;
  projects: VideoProjectReadPort;
  workspace: Pick<WorkspaceContentSourceService, 'describe' | 'openMedia'>;
  authorizeCatSource?: AuthorizeScreeningCatSource;
  now?: () => string;
}

export async function freezeProjectScreeningMedia(
  deps: ScreeningMediaDependencies,
  input: RegisterVideoProjectScreeningInput,
  requestDigest: `sha256:${string}`,
) {
  const contentRef = `video-project-media:${createHash('sha256').update(`${input.principal.userId}\0${input.contentRef}\0${input.operationId}`).digest('hex')}`;
  const retained = await findRetainedMedia(deps, input, contentRef, requestDigest);
  if (retained) return retained;
  const source = await deps.workspace.describe({
    principal: { userId: input.principal.userId },
    locator: input.source.locator,
  });
  if (source.revision !== input.source.expectedSourceRevision) throw new VideoProjectScreeningError('media_changed');
  const opened = await deps.workspace.openMedia({
    principal: { userId: input.principal.userId },
    locator: source.locator,
    expectedRevision: input.source.expectedSourceRevision,
  });
  if (opened.contentRef !== source.contentRef || opened.mime !== 'video/mp4' || opened.media.kind !== 'video') {
    opened.stream.destroy();
    throw new VideoProjectScreeningError('invalid_screening');
  }
  const bytes = await collectSourceBytes(opened, input.source.expectedSourceRevision);
  const length = bytes.length;
  const verified = await deps.workspace.describe({
    principal: { userId: input.principal.userId },
    locator: source.locator,
  });
  if (verified.contentRef !== source.contentRef || verified.revision !== input.source.expectedSourceRevision)
    throw new VideoProjectScreeningError('media_changed');
  const scope: VideoProjectMediaScopeV1 = {
    kind: 'video-project-screening',
    ownerUserId: input.principal.userId,
    projectContentRef: input.contentRef,
    screeningId: input.id,
    input: { ...input.input, blobDigest: input.input.blobDigest as `sha256:${string}` },
    source: { ...input.source, locator: source.locator },
    sourceContentRef: source.contentRef,
    snapshotOperationId: input.operationId,
    requestDigest,
    registeredBy: input.principal.actor,
    registeredAt: deps.now?.() ?? new Date().toISOString(),
  };
  await deps.projects.authorize({ ...input, permission: 'write' });
  if (input.principal.actor.kind === 'cat') await deps.authorizeCatSource?.(input);
  try {
    const receipt = await deps.owner.importContent({
      contentRef,
      bytes,
      mediaType: 'video/mp4',
      actor: input.principal.actor,
      operationId: input.operationId,
      projectMediaScope: scope,
    });
    return { contentRef, blobDigest: receipt.blobDigest, byteLength: length, media: opened.media, scope };
  } catch (error) {
    if (!(error instanceof ContentOwnerIdempotencyError) && !(error instanceof ContentOwnerConflictError)) throw error;
    const retained = await deps.owner.describe(contentRef, 1);
    if (
      !retained.projectMediaScope ||
      retained.projectMediaScope.requestDigest !== requestDigest ||
      retained.blobDigest !== digestBytes(bytes) ||
      !sameProjectValue(retained.projectMediaScope.registeredBy, input.principal.actor)
    )
      throw error;
    return {
      contentRef,
      blobDigest: retained.blobDigest,
      byteLength: length,
      media: opened.media,
      scope: retained.projectMediaScope,
    };
  }
}

async function findRetainedMedia(
  deps: ScreeningMediaDependencies,
  input: RegisterVideoProjectScreeningInput,
  contentRef: string,
  requestDigest: `sha256:${string}`,
) {
  try {
    const existing = await deps.owner.load(contentRef, 1);
    const scope = existing.projectMediaScope;
    if (!scope || scope.requestDigest !== requestDigest || !sameProjectValue(scope.registeredBy, input.principal.actor))
      throw new ContentOwnerIdempotencyError(input.contentRef, input.operationId);
    const media = await probeImmutableMedia(existing.bytes, 'video/mp4');
    if (media.kind !== 'video') throw new VideoProjectScreeningError('invalid_screening');
    return { contentRef, blobDigest: existing.blobDigest, byteLength: existing.bytes.length, media, scope };
  } catch (error) {
    if (!(error instanceof ContentOwnerNotFoundError)) throw error;
    return null;
  }
}

async function collectSourceBytes(
  opened: import('../../workspace/workspace-content-source.js').OpenWorkspaceMediaV1,
  expectedRevision: string,
) {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of opened.stream) {
      if (!Buffer.isBuffer(chunk)) throw new VideoProjectScreeningError('invalid_screening');
      length += chunk.length;
      if (length > opened.byteLength || length > 256 * 1024 * 1024)
        throw new VideoProjectScreeningError('invalid_screening');
      chunks.push(chunk);
    }
  } finally {
    opened.stream.destroy();
  }
  const bytes = Buffer.concat(chunks, length);
  if (length !== opened.byteLength || digestBytes(bytes) !== expectedRevision)
    throw new VideoProjectScreeningError('media_changed');
  return bytes;
}
