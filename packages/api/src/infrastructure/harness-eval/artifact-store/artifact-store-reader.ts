import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readWorkspaceFilePreview } from '../../../domains/workspace/workspace-file-read.js';
import {
  type ArtifactCoordinates,
  type ArtifactFileContentType,
  type ArtifactFileKey,
  artifactDirectory,
  artifactFileLocation,
  artifactOutputRoot,
  artifactOwnerRoot,
  bundleDirIn,
  isStrictlyInside,
  SAFE_ARTIFACT_ID_PATTERN,
  SAFE_DOMAIN_SLUG_PATTERN,
  verdictPathIn,
} from './artifact-store-layout.js';

export interface OwnerArtifactVerdict {
  coordinates: ArtifactCoordinates;
  verdictPath: string;
  bundleDir: string;
}

/**
 * Lists the published verdicts inside one owner's partition. Other owners'
 * partitions are never opened, and names that are not valid coordinates —
 * including in-flight `.staging-*` directories — are skipped.
 */
export function listOwnerArtifactVerdicts(artifactRoot: string, ownerUserId: string): OwnerArtifactVerdict[] {
  const ownerRoot = artifactOwnerRoot(artifactRoot, ownerUserId);
  if (!existsSync(ownerRoot)) return [];

  const verdicts: OwnerArtifactVerdict[] = [];
  for (const domainEntry of readdirSync(ownerRoot, { withFileTypes: true })) {
    if (!domainEntry.isDirectory() || !SAFE_DOMAIN_SLUG_PATTERN.test(domainEntry.name)) continue;
    const domainDir = join(ownerRoot, domainEntry.name);
    for (const artifactEntry of readdirSync(domainDir, { withFileTypes: true })) {
      if (!artifactEntry.isDirectory() || !SAFE_ARTIFACT_ID_PATTERN.test(artifactEntry.name)) continue;
      const coordinates = { domainSlug: domainEntry.name, artifactId: artifactEntry.name };
      const outputRoot = artifactOutputRoot(join(domainDir, artifactEntry.name));
      const verdictPath = verdictPathIn(outputRoot, coordinates.artifactId);
      if (!existsSync(verdictPath)) continue;
      verdicts.push({ coordinates, verdictPath, bundleDir: bundleDirIn(outputRoot, coordinates.artifactId) });
    }
  }
  return verdicts;
}

export type OwnerArtifactFileRead =
  | { status: 'ok'; contentType: ArtifactFileContentType; content: string; truncated: boolean }
  | { status: 'not_found' };

/**
 * Reads one named file of an artifact in the caller's own partition. An artifact
 * that belongs to another owner is indistinguishable from one that does not
 * exist, and a file that resolves outside its artifact directory is not served.
 */
export async function readOwnerArtifactFile(
  artifactRoot: string,
  ownerUserId: string,
  coordinates: ArtifactCoordinates,
  fileKey: ArtifactFileKey,
): Promise<OwnerArtifactFileRead> {
  const artifactDir = artifactDirectory(artifactRoot, ownerUserId, coordinates);
  const location = artifactFileLocation(artifactOutputRoot(artifactDir), coordinates.artifactId, fileKey);

  let realPath: string;
  try {
    const realArtifactDir = realpathSync(artifactDir);
    realPath = realpathSync(location.path);
    if (!isStrictlyInside(realArtifactDir, realPath) || !statSync(realPath).isFile()) return { status: 'not_found' };
  } catch {
    return { status: 'not_found' };
  }

  const preview = await readWorkspaceFilePreview(realPath);
  if (preview.binary) return { status: 'not_found' };
  return { status: 'ok', contentType: location.contentType, content: preview.content, truncated: preview.truncated };
}
