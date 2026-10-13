import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { createModuleLogger } from '../../../infrastructure/logger.js';
import { findMonorepoRoot } from '../../../utils/monorepo-root.js';
import { getDefaultUploadDir } from '../../../utils/upload-paths.js';

interface AvatarRoots {
  readonly avatars: string;
  readonly uploads: string;
}

const MAX_PUBLIC_AVATAR_LENGTH = 1_200;
const log = createModuleLogger('plugin/collective-public-avatar');
const PUBLIC_AVATAR_ENCODINGS = [
  { size: 48, quality: 45 },
  { size: 48, quality: 35 },
  { size: 40, quality: 45 },
  { size: 40, quality: 35 },
  { size: 32, quality: 45 },
  { size: 32, quality: 35 },
  { size: 32, quality: 25 },
] as const;

export function collectiveAvatarRoots(): AvatarRoots {
  return {
    avatars: join(findMonorepoRoot(), 'packages/web/public/avatars'),
    uploads: getDefaultUploadDir(process.env.UPLOAD_DIR),
  };
}

/** Portable, bounded thumbnail; no local Host URL or original upload path crosses the Service boundary. */
export async function publicCollectiveAvatar(
  value: string | undefined,
  roots: AvatarRoots,
): Promise<string | undefined> {
  const match = value?.match(/^\/(avatars|uploads)\/([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(?:png|jpe?g|webp))$/);
  if (!match) return undefined;
  const root = match[1] === 'avatars' ? roots.avatars : roots.uploads;
  try {
    const canonicalRoot = await realpath(root);
    const canonicalFile = await realpath(resolve(root, match[2] ?? ''));
    const pathFromRoot = relative(canonicalRoot, canonicalFile);
    if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
      log.warn({ avatarRef: value, reason: 'outside_public_root' }, 'Collective avatar was omitted');
      return undefined;
    }
    if ((await stat(canonicalFile)).size > 10_000_000) {
      log.warn({ avatarRef: value, reason: 'source_too_large' }, 'Collective avatar was omitted');
      return undefined;
    }
    const bytes = await readFile(canonicalFile);
    for (const candidate of PUBLIC_AVATAR_ENCODINGS) {
      const thumbnail = await sharp(bytes, { limitInputPixels: 20_000_000, failOn: 'error' })
        .rotate()
        .resize(candidate.size, candidate.size, { fit: 'cover' })
        .webp({ quality: candidate.quality })
        .toBuffer();
      const encoded = `data:image/webp;base64,${thumbnail.toString('base64')}`;
      if (encoded.length <= MAX_PUBLIC_AVATAR_LENGTH) return encoded;
    }
    log.warn({ avatarRef: value, reason: 'wire_limit' }, 'Collective avatar was omitted');
    return undefined;
  } catch (error) {
    log.warn(
      {
        avatarRef: value,
        reason: 'read_or_encode_failed',
        errorName: error instanceof Error ? error.name : typeof error,
      },
      'Collective avatar was omitted',
    );
    return undefined;
  }
}
