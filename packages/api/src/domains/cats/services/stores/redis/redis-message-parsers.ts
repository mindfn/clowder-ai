/**
 * Redis message field parsers — 从 RedisMessageStore 拆出的纯函数
 *
 * F23: 拆分以减少 RedisMessageStore.ts 行数
 */

import type { CatId, ConnectorSource, MessageContent, RichMessageExtra } from '@cat-cafe/shared';
import { isValidRoutingAttemptBatch, type RoutingAttemptBatch } from '../../agents/routing/routing-attempt.js';
import type { MessageMetadata } from '../../types.js';
import {
  type MessageProvenance,
  PROVENANCE_AUTHORS,
  PROVENANCE_OBSERVATIONS,
  type StoredMessage,
  type StoredToolEvent,
} from '../ports/MessageStore.js';

/**
 * F257 V1 (sol R3 P1-1, three-state sol R4 P1-1c): writer-declared provenance
 * read path. 'absent' (legacy message written before the contract) and
 * 'malformed' (field present but corrupt — storage/writer fault) are DIFFERENT
 * facts: legacy messages honestly predate every cohort, while a malformed
 * declaration means the window's cohort membership is unknowable and metric
 * consumers must report the window unmeasurable instead of silently shrinking
 * the cohort.
 */
export type ProvenanceFieldParse =
  | { state: 'absent' }
  | { state: 'malformed' }
  | { state: 'present'; provenance: MessageProvenance };

export function parseProvenanceField(raw: string | undefined | null): ProvenanceFieldParse {
  if (raw === undefined || raw === null) return { state: 'absent' };
  try {
    const parsed = JSON.parse(raw) as {
      author?: unknown;
      routed?: unknown;
      observation?: unknown;
      sourceRef?: unknown;
    };
    if (!parsed || typeof parsed !== 'object') return { state: 'malformed' };
    if (!(PROVENANCE_AUTHORS as readonly unknown[]).includes(parsed.author)) return { state: 'malformed' };
    if (typeof parsed.routed !== 'boolean') return { state: 'malformed' };
    if (!(PROVENANCE_OBSERVATIONS as readonly unknown[]).includes(parsed.observation)) {
      return { state: 'malformed' };
    }
    if (
      parsed.observation === 'derived' &&
      (typeof parsed.sourceRef !== 'string' || parsed.sourceRef.trim().length === 0)
    ) {
      return { state: 'malformed' };
    }
    if (parsed.observation === 'original' && parsed.sourceRef !== undefined) return { state: 'malformed' };
    return {
      state: 'present',
      provenance: {
        author: parsed.author as MessageProvenance['author'],
        routed: parsed.routed,
        observation: parsed.observation as MessageProvenance['observation'],
        ...(parsed.observation === 'derived' ? { sourceRef: parsed.sourceRef as string } : {}),
      },
    };
  } catch {
    return { state: 'malformed' };
  }
}

export type PersistedMessageInvalidReason =
  | 'required_field_missing'
  | 'coordinate_mismatch'
  | 'malformed_timestamp'
  | 'malformed_delivered_at'
  | 'malformed_deleted_at'
  | 'malformed_tombstone'
  | 'malformed_mentions'
  | 'malformed_source'
  | 'malformed_routing_fact'
  | 'malformed_provenance'
  | 'author_cat_id_conflict'
  | 'author_source_conflict'
  | 'routing_fact_missing'
  | 'routing_fact_unexpected'
  | 'tombstone_payload_present';

export interface ParsedPersistedMessageRecord {
  id: string;
  threadId: string;
  userId: string;
  catId: CatId | null;
  content: string;
  mentions: readonly CatId[];
  timestamp: number;
  deliveredAt?: number;
  /** owner/thread timeline coordinate: delivery position when delivered, send position otherwise */
  effectiveOrderAt: number;
  source?: ConnectorSource;
  routingFact?: RoutingAttemptBatch;
  deletedAt?: number;
}

export type PersistedMessageRecordParse =
  | { state: 'missing' }
  | { state: 'legacy'; record: ParsedPersistedMessageRecord }
  | { state: 'deleted'; deletion: 'soft' | 'hard'; record: ParsedPersistedMessageRecord }
  | { state: 'invalid'; reason: PersistedMessageInvalidReason }
  | { state: 'present'; record: ParsedPersistedMessageRecord; provenance: MessageProvenance };

/**
 * Canonical read-side mirror of assertProvenanceConsistent(). Exact metrics
 * consume this whole-record validator instead of independently interpreting a
 * subset of fields. A missing hash is distinct from a hash that legitimately
 * predates provenance; present-but-empty fields are corruption, not legacy.
 */
export function parsePersistedMessageRecord(fields: {
  expectedId: string;
  expectedOwnerUserId: string;
  expectedTimelineScore: string;
  id: string | undefined | null;
  threadId: string | undefined | null;
  userId: string | undefined | null;
  catId: string | undefined | null;
  content: string | undefined | null;
  mentions: string | undefined | null;
  timestamp: string | undefined | null;
  deliveredAt: string | undefined | null;
  deletedAt: string | undefined | null;
  deletedBy: string | undefined | null;
  tombstone: string | undefined | null;
  source: string | undefined | null;
  routingFact: string | undefined | null;
  provenance: string | undefined | null;
}): PersistedMessageRecordParse {
  const rawValues = [
    fields.id,
    fields.threadId,
    fields.userId,
    fields.catId,
    fields.content,
    fields.mentions,
    fields.timestamp,
    fields.deliveredAt,
    fields.deletedAt,
    fields.deletedBy,
    fields.tombstone,
    fields.source,
    fields.routingFact,
    fields.provenance,
  ];
  if (rawValues.every((value) => value === undefined || value === null)) return { state: 'missing' };
  if (
    typeof fields.id !== 'string' ||
    fields.id.length === 0 ||
    typeof fields.threadId !== 'string' ||
    fields.threadId.length === 0 ||
    typeof fields.userId !== 'string' ||
    fields.userId.length === 0 ||
    typeof fields.catId !== 'string' ||
    typeof fields.content !== 'string' ||
    typeof fields.mentions !== 'string' ||
    typeof fields.timestamp !== 'string'
  ) {
    return { state: 'invalid', reason: 'required_field_missing' };
  }

  if (fields.id !== fields.expectedId || fields.userId !== fields.expectedOwnerUserId) {
    return { state: 'invalid', reason: 'coordinate_mismatch' };
  }

  if (!/^(0|[1-9]\d*)$/.test(fields.timestamp)) {
    return { state: 'invalid', reason: 'malformed_timestamp' };
  }
  const timestamp = Number(fields.timestamp);
  const timelineScore = Number(fields.expectedTimelineScore);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !Number.isFinite(timelineScore)) {
    return { state: 'invalid', reason: 'malformed_timestamp' };
  }

  const deliveredAtPresent = fields.deliveredAt !== undefined && fields.deliveredAt !== null;
  if (deliveredAtPresent && !/^(0|[1-9]\d*)$/.test(fields.deliveredAt ?? '')) {
    return { state: 'invalid', reason: 'malformed_delivered_at' };
  }
  const deliveredAt = deliveredAtPresent ? Number(fields.deliveredAt) : undefined;
  if (deliveredAt !== undefined && (!Number.isSafeInteger(deliveredAt) || deliveredAt < 0)) {
    return { state: 'invalid', reason: 'malformed_delivered_at' };
  }
  const effectiveOrderAt = deliveredAt ?? timestamp;
  if (effectiveOrderAt !== timelineScore) return { state: 'invalid', reason: 'coordinate_mismatch' };

  const deletedAtPresent = fields.deletedAt !== undefined && fields.deletedAt !== null;
  if (deletedAtPresent && !/^(0|[1-9]\d*)$/.test(fields.deletedAt ?? '')) {
    return { state: 'invalid', reason: 'malformed_deleted_at' };
  }
  const deletedAt = deletedAtPresent ? Number(fields.deletedAt) : undefined;
  if (deletedAt !== undefined && (!Number.isSafeInteger(deletedAt) || deletedAt < 0)) {
    return { state: 'invalid', reason: 'malformed_deleted_at' };
  }
  const tombstonePresent = fields.tombstone !== undefined && fields.tombstone !== null;
  const deletedByPresent = fields.deletedBy !== undefined && fields.deletedBy !== null;
  if (tombstonePresent && fields.tombstone !== '1') {
    return { state: 'invalid', reason: 'malformed_tombstone' };
  }
  if (
    (deletedAtPresent && (typeof fields.deletedBy !== 'string' || fields.deletedBy.length === 0)) ||
    (!deletedAtPresent && (deletedByPresent || tombstonePresent))
  ) {
    return { state: 'invalid', reason: tombstonePresent ? 'malformed_tombstone' : 'malformed_deleted_at' };
  }

  let mentions: readonly CatId[];
  try {
    const parsedMentions: unknown = JSON.parse(fields.mentions);
    if (!Array.isArray(parsedMentions) || !parsedMentions.every((mention) => typeof mention === 'string')) {
      return { state: 'invalid', reason: 'malformed_mentions' };
    }
    mentions = parsedMentions as unknown as readonly CatId[];
  } catch {
    return { state: 'invalid', reason: 'malformed_mentions' };
  }

  const sourcePresent = fields.source !== undefined && fields.source !== null;
  const source = sourcePresent ? safeParseConnectorSource(fields.source ?? undefined) : undefined;
  if (sourcePresent && !source) return { state: 'invalid', reason: 'malformed_source' };

  const factPresent = fields.routingFact !== undefined && fields.routingFact !== null;
  const routingFact = factPresent ? safeParseRoutingFact(fields.routingFact ?? undefined) : undefined;
  if (factPresent && !routingFact) return { state: 'invalid', reason: 'malformed_routing_fact' };

  const record: ParsedPersistedMessageRecord = {
    id: fields.id,
    threadId: fields.threadId,
    userId: fields.userId,
    catId: fields.catId ? (fields.catId as CatId) : null,
    content: fields.content,
    mentions,
    timestamp,
    ...(deliveredAt !== undefined ? { deliveredAt } : {}),
    effectiveOrderAt,
    ...(source ? { source } : {}),
    ...(routingFact ? { routingFact } : {}),
    ...(deletedAt !== undefined ? { deletedAt } : {}),
  };
  if (deletedAt !== undefined) {
    if (tombstonePresent) {
      if (
        fields.content !== '' ||
        mentions.length !== 0 ||
        (fields.routingFact !== undefined && fields.routingFact !== null) ||
        (fields.provenance !== undefined && fields.provenance !== null)
      ) {
        return { state: 'invalid', reason: 'tombstone_payload_present' };
      }
      return { state: 'deleted', deletion: 'hard', record };
    }
    return { state: 'deleted', deletion: 'soft', record };
  }
  const parsed = parseProvenanceField(fields.provenance);
  if (parsed.state === 'absent') {
    return factPresent ? { state: 'invalid', reason: 'routing_fact_unexpected' } : { state: 'legacy', record };
  }
  if (parsed.state === 'malformed') return { state: 'invalid', reason: 'malformed_provenance' };

  const catIdPresent = typeof fields.catId === 'string' && fields.catId.length > 0;
  if (
    ((parsed.provenance.author === 'user' || parsed.provenance.author === 'external_user') && catIdPresent) ||
    (parsed.provenance.author === 'cat' && !catIdPresent)
  ) {
    return { state: 'invalid', reason: 'author_cat_id_conflict' };
  }
  if (
    (parsed.provenance.author === 'user' && sourcePresent) ||
    (parsed.provenance.author === 'external_user' && !sourcePresent)
  ) {
    return { state: 'invalid', reason: 'author_source_conflict' };
  }

  if (parsed.provenance.routed && !factPresent) return { state: 'invalid', reason: 'routing_fact_missing' };
  if (!parsed.provenance.routed && factPresent) return { state: 'invalid', reason: 'routing_fact_unexpected' };
  return { state: 'present', record, provenance: parsed.provenance };
}

/**
 * Hydration projection of parseProvenanceField for StoredMessage surfaces
 * (UI/API reads): both 'absent' and 'malformed' hydrate as "no trusted
 * declaration" (undefined). Metric/reconcile consumers MUST NOT use this —
 * they consume parsePersistedMessageRecord so whole-record contradictions
 * surface as unmeasurable windows.
 */
export function hydrateProvenance(raw: string | undefined | null): MessageProvenance | undefined {
  const parsed = parseProvenanceField(raw);
  return parsed.state === 'present' ? parsed.provenance : undefined;
}

/**
 * F257 V1: embedded RoutingDecisionFact payload (schema: routing-attempt.ts,
 * semantics: T-A §3.4). Full structural validation (sol R1 P1-3) — a payload
 * failing any field check returns undefined so consumers count it as
 * malformed instead of partially aggregating it.
 */
export function safeParseRoutingFact(raw: string | undefined): RoutingAttemptBatch | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isValidRoutingAttemptBatch(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function safeParseMentions(raw: string | undefined): readonly CatId[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function safeParseToolEvents(raw: string | undefined): readonly StoredToolEvent[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function safeParseContentBlocks(raw: string | undefined): readonly MessageContent[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** F022+F052: Parse extra field (contains rich blocks, stream metadata, cross-post origin) */
export function safeParseExtra(raw: string | undefined):
  | {
      rich?: RichMessageExtra;
      // F194 Phase Z9 hotfix: stream now carries dual id (parent + per-cat-turn).
      // Frontend `getBubbleInvocationId` uses turnInvocationId for bubble identity
      // (falls back to invocationId / parent only for legacy records).
      stream?: { invocationId: string; turnInvocationId?: string };
      crossPost?: {
        sourceThreadId: string;
        sourceInvocationId?: string;
        effectClass?: 'fyi' | 'coordinate' | 'investigate' | 'assign_work';
      };
      scheduler?: {
        hiddenTrigger?: boolean;
        toast?: {
          type: 'success' | 'error' | 'info';
          title: string;
          message: string;
          duration: number;
          lifecycleEvent: 'registered' | 'paused' | 'resumed' | 'deleted' | 'succeeded' | 'failed' | 'missed_window';
        };
      };
      targetCats?: string[];
      isExplicitPost?: boolean;
      tracing?: { traceId: string; spanId: string; parentSpanId?: string };
      systemKind?: 'a2a_routing' | 'context_briefing';
      // F257 #4 (sol R1 P1-2): preserve signature lint through Redis round-trip.
      signatureLint?: { signed: boolean };
    }
  | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;

    const result: {
      rich?: RichMessageExtra;
      stream?: { invocationId: string; turnInvocationId?: string };
      crossPost?: {
        sourceThreadId: string;
        sourceInvocationId?: string;
        effectClass?: 'fyi' | 'coordinate' | 'investigate' | 'assign_work';
      };
      scheduler?: {
        hiddenTrigger?: boolean;
        toast?: {
          type: 'success' | 'error' | 'info';
          title: string;
          message: string;
          duration: number;
          lifecycleEvent: 'registered' | 'paused' | 'resumed' | 'deleted' | 'succeeded' | 'failed' | 'missed_window';
        };
      };
      targetCats?: string[];
      isExplicitPost?: boolean;
      tracing?: { traceId: string; spanId: string; parentSpanId?: string };
      systemKind?: 'a2a_routing' | 'context_briefing';
      a2aRouting?: { fromCatId?: string; targetCatId?: string; invocationId?: string };
      signatureLint?: { signed: boolean };
    } = {};
    let hasField = false;

    // Validate rich sub-field shape
    if (parsed.rich && typeof parsed.rich === 'object' && parsed.rich.v === 1 && Array.isArray(parsed.rich.blocks)) {
      result.rich = parsed.rich as RichMessageExtra;
      hasField = true;
    }

    // Validate stream sub-field shape (#80: draft dedup key)
    // F194 Phase Z9 hotfix: preserve turnInvocationId (per-cat-turn id, written
    // by Z9 backend stamping). Pre-hotfix parser rebuilt only { invocationId },
    // silently stripping turnInvocationId → frontend bubble identity fell back
    // to parent → multi-turn same-cat under shared parent collapsed (R13/R14).
    if (parsed.stream && typeof parsed.stream === 'object' && typeof parsed.stream.invocationId === 'string') {
      result.stream = {
        invocationId: parsed.stream.invocationId,
        ...(typeof parsed.stream.turnInvocationId === 'string'
          ? { turnInvocationId: parsed.stream.turnInvocationId }
          : {}),
      };
      hasField = true;
    }

    // F52: Validate crossPost sub-field shape
    if (
      parsed.crossPost &&
      typeof parsed.crossPost === 'object' &&
      typeof parsed.crossPost.sourceThreadId === 'string'
    ) {
      const validEffectClasses = new Set(['fyi', 'coordinate', 'investigate', 'assign_work']);
      result.crossPost = {
        sourceThreadId: parsed.crossPost.sourceThreadId,
        ...(typeof parsed.crossPost.sourceInvocationId === 'string'
          ? { sourceInvocationId: parsed.crossPost.sourceInvocationId }
          : {}),
        // F246 Phase B: preserve effectClass through Redis round-trip
        ...(typeof parsed.crossPost.effectClass === 'string' && validEffectClasses.has(parsed.crossPost.effectClass)
          ? { effectClass: parsed.crossPost.effectClass as 'fyi' | 'coordinate' | 'investigate' | 'assign_work' }
          : {}),
      };
      hasField = true;
    }

    // #481: Preserve scheduler sub-field (hiddenTrigger, toast) through Redis round-trip
    if (parsed.scheduler && typeof parsed.scheduler === 'object') {
      const sched: NonNullable<typeof result.scheduler> = {};
      if (parsed.scheduler.hiddenTrigger === true) sched.hiddenTrigger = true;
      if (parsed.scheduler.toast && typeof parsed.scheduler.toast === 'object') {
        sched.toast = parsed.scheduler.toast;
      }
      result.scheduler = sched;
      hasField = true;
    }

    // #481: Preserve targetCats sub-field through Redis round-trip
    if (Array.isArray(parsed.targetCats)) {
      result.targetCats = parsed.targetCats;
      hasField = true;
    }

    if (parsed.isExplicitPost === true) {
      result.isExplicitPost = true;
      hasField = true;
    }

    if (parsed.systemKind === 'a2a_routing' || parsed.systemKind === 'context_briefing') {
      result.systemKind = parsed.systemKind;
      hasField = true;
    }

    // F257 #4 (sol R1 P1-2): preserve signature lint verdict through Redis round-trip.
    if (
      parsed.signatureLint &&
      typeof parsed.signatureLint === 'object' &&
      typeof parsed.signatureLint.signed === 'boolean'
    ) {
      result.signatureLint = { signed: parsed.signatureLint.signed };
      hasField = true;
    }

    if (parsed.a2aRouting && typeof parsed.a2aRouting === 'object') {
      const routing: NonNullable<typeof result.a2aRouting> = {};
      if (typeof parsed.a2aRouting.fromCatId === 'string') routing.fromCatId = parsed.a2aRouting.fromCatId;
      if (typeof parsed.a2aRouting.targetCatId === 'string') routing.targetCatId = parsed.a2aRouting.targetCatId;
      if (typeof parsed.a2aRouting.invocationId === 'string') routing.invocationId = parsed.a2aRouting.invocationId;
      result.a2aRouting = routing;
      hasField = true;
    }

    // F153-F: Preserve tracing pointer sub-field through Redis round-trip.
    // Stored as compact keys (t/s/p) to stay within AC-F6 100-byte budget.
    if (parsed.tracing && typeof parsed.tracing === 'object') {
      const tr = parsed.tracing;
      const t = tr.t ?? tr.traceId;
      const s = tr.s ?? tr.spanId;
      const p = tr.p ?? tr.parentSpanId;
      if (typeof t === 'string' && typeof s === 'string') {
        result.tracing = {
          traceId: t,
          spanId: s,
          ...(typeof p === 'string' ? { parentSpanId: p } : {}),
        };
        hasField = true;
      }
    }

    return hasField ? result : undefined;
  } catch {
    return undefined;
  }
}

/**
 * F153-F: Serialize extra field with compact tracing keys (t/s/p)
 * to stay within AC-F6 100-byte budget per pointer.
 */
export function serializeExtra(extra: NonNullable<StoredMessage['extra']>): string {
  const { tracing, ...rest } = extra;
  if (!tracing) return JSON.stringify(extra);
  const compact: Record<string, string> = { t: tracing.traceId, s: tracing.spanId };
  if (tracing.parentSpanId) compact.p = tracing.parentSpanId;
  return JSON.stringify({ ...rest, tracing: compact });
}

/** F097: Parse connector source field */
export function safeParseConnectorSource(raw: string | undefined): ConnectorSource | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.connector === 'string' &&
      typeof parsed.label === 'string' &&
      typeof parsed.icon === 'string'
    ) {
      return parsed as ConnectorSource;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function safeParseMetadata(raw: string | undefined): MessageMetadata | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.provider === 'string' &&
      typeof parsed.model === 'string'
    ) {
      return parsed as MessageMetadata;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
