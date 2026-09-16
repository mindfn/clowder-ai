/**
 * Redis key patterns for summary storage.
 * All keys share the cat-cafe: prefix set by the Redis client.
 */

export const SummaryKeys = {
  /** Hash with summary details: summary:{summaryId} */
  detail: (id: string) => `summary:${id}`,

  /** Per-thread summary list sorted set: summaries:thread:{threadId} */
  thread: (threadId: string) => `summaries:thread:${threadId}`,
} as const;
