import { messageMediaItemSelectorSchema, type ThreadArtifactDTO, type ThreadArtifactType } from '@cat-cafe/shared';

function encodedId(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value));
}

export function artifactObjectId(artifact: ThreadArtifactDTO): string {
  if (artifact.publicationItem) return encodedId([legacyArtifactObjectId(artifact), artifact.publicationItem]);
  return legacyArtifactObjectId(artifact);
}

/** Old persisted F232 targets did not include the selector. Resolve only when uniquely matched. */
export function legacyArtifactObjectId(artifact: ThreadArtifactDTO): string {
  return encodedId([
    artifact.type,
    artifact.ref ?? null,
    artifact.url ?? null,
    artifact.sourceMessageId,
    artifact.createdAt,
    artifact.name,
  ]);
}

const ARTIFACT_TYPES = new Set<ThreadArtifactType>(['image', 'file', 'code', 'pr', 'audio', 'video', 'widget']);
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

function parseLegacyTuple(value: unknown): ThreadArtifactDTO | null {
  if (!Array.isArray(value) || value.length !== 6) return null;
  const [type, ref, url, sourceMessageId, createdAt, name] = value;
  if (
    typeof type !== 'string' ||
    !ARTIFACT_TYPES.has(type as ThreadArtifactType) ||
    !nullableString(ref) ||
    !nullableString(url) ||
    !nullableString(sourceMessageId) ||
    typeof createdAt !== 'number' ||
    !Number.isFinite(createdAt) ||
    typeof name !== 'string'
  )
    return null;
  return {
    type: type as ThreadArtifactType,
    name,
    createdAt,
    sourceMessageId,
    catId: null,
    ...(ref !== null ? { ref } : {}),
    ...(url !== null ? { url } : {}),
  };
}

/** Shape/codec admission only: the owner catalogue still proves which actual card or content exists. */
export function parseArtifactObjectId(key: unknown): ThreadArtifactDTO | null {
  if (typeof key !== 'string') return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(key));
    let artifact = parseLegacyTuple(value);
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') {
      const legacy = parseLegacyTuple(JSON.parse(decodeURIComponent(value[0])));
      const item = messageMediaItemSelectorSchema.safeParse(value[1]);
      if (!legacy || !item.success) return null;
      artifact = { ...legacy, publicationItem: value[1] as typeof item.data };
    }
    return artifact && artifactObjectId(artifact) === key ? artifact : null;
  } catch {
    return null;
  }
}
