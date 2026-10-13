import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import type { workspaceV3Copy } from './workspace-v3.shell-copy';

/** Read only true owner coordinates; absence of a version adds no placeholder. */
export function artifactCardMetadata(
  artifact: ThreadArtifactDTO,
  author: string,
  t: typeof workspaceV3Copy.zh,
): string {
  const revision = artifact.work?.ownerRevision;
  const current = artifact.work?.currentOwnerRevision;
  const version =
    typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0 ? t.version(revision) : null;
  const historical =
    version && typeof current === 'number' && Number.isSafeInteger(current) && current > (revision ?? 0);
  const date = new Date(artifact.createdAt);
  const time = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return [author, version, historical ? t.historicalVersion : null, time].filter(Boolean).join(' · ');
}
