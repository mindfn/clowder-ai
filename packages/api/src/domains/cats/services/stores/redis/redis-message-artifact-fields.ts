/** Keep the original authority and visibility inputs; exclude prose, thinking, metadata and toolEvents. */
export const MESSAGE_ARTIFACT_FIELDS = [
  'id',
  'threadId',
  'userId',
  'catId',
  'from',
  'source',
  'lifecycle',
  'origin',
  'deliveryStatus',
  'deletedAt',
  'timestamp',
  'contentBlocks',
  'extra',
  'replyTo',
  'deliveredAt',
  'timelineOrderAt',
  'visibility',
  'whisperTo',
  'revealedAt',
  'recall',
  '_tombstone',
] as const;

export function artifactMessageHash(value: unknown): Record<string, string> | undefined {
  if (!Array.isArray(value) || value.length !== MESSAGE_ARTIFACT_FIELDS.length) return undefined;
  const result: Record<string, string> = {};
  for (const [index, field] of MESSAGE_ARTIFACT_FIELDS.entries()) {
    const raw: unknown = value[index];
    if (raw === null) continue;
    if (typeof raw !== 'string') return undefined;
    result[field] = raw;
  }
  return result;
}
