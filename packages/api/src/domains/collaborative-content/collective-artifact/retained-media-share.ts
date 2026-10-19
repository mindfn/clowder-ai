import { type CollectiveConnector, ConnectorTransportError } from '@cat-cafe/collective-connector';
import { artifactIdentity } from '@cat-cafe/collective-service';
import { collectiveRetainedMediaShareSchema } from '@cat-cafe/shared';
import type { CollectivePublishedMediaOwner } from './published-media-owner.js';

export const retainedMediaShareSchema = collectiveRetainedMediaShareSchema;

/** The browser selects an existing retained object. F138 supplies its exact tuple and actual owner receipt. */
export async function shareRetainedMedia(
  connector: CollectiveConnector,
  media: CollectivePublishedMediaOwner,
  connectionId: string,
  userId: string,
  unsafe: unknown,
) {
  const input = retainedMediaShareSchema.parse(unsafe);
  const connection = await connector.getProjection(connectionId);
  const route = await connector.getHostRoute(connectionId);
  if (connection.authorityStatus !== 'connected' || !connection.authorizedHumanId || route?.localOwnerUserId !== userId)
    throw new ConnectorTransportError('The local Human does not own this Cafe', 403, 'ARTIFACT_ACCESS_DENIED');
  const { serviceInstanceId, collectiveId } = connection;
  const artifactId = artifactIdentity(serviceInstanceId, collectiveId, input.contentRef);
  const asset = await media.prepareShare({
    contentRef: input.contentRef,
    ownerRevision: input.ownerRevision,
    scope: {
      serviceInstanceId,
      collectiveId,
      artifactId,
      sourceEventId: input.sourceEventId,
      custodyRevision: input.expectedCustodyRevision ?? 1,
    },
    principal: { userId, actor: { kind: 'human', actorId: userId } },
  });
  const { contentRef: _selected, ownerRevision: _version, ...publicInput } = input;
  return connector.registerArtifact(connectionId, userId, {
    ...publicInput,
    contentRef: asset.contentRef,
    ownerRevision: asset.ownerRevision,
    mediaType: asset.mediaType,
    blobDigest: asset.blobDigest,
    receiptRef: asset.ownerReceiptRef,
  });
}
