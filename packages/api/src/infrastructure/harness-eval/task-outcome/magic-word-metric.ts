/**
 * F257 V1 — magic word 词面出现数 (T-B §3.5 of the F257 redesign).
 *
 * The metric is a READ-ONLY projection of Event Memory (single source of truth,
 * 归一裁定 2026-06-06) — this module writes NO second store. What it does write
 * is Event Memory itself, via the T-B collection-integrity contract: the live
 * path (`void tryDetectMagicWords`) can drop hits silently, so BEFORE computing
 * the metric we re-scan the window's user-authored messages with the same pure
 * detector and backfill missing events idempotently (markEvent is atomic on
 * UNIQUE(owner, threadId, messageId, word)). Reconcile failure → the window is
 * unmeasurable. A persisted owner-scoped high-watermark records scan progress.
 *
 * 口径 (T-B): raw substring hits, unique per (message, word) — NOT interpreted
 * as governance brakes; graded 拉闸数 is a future capability outside this module.
 */

import type { EventMemoryRecord } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { MessageKeys } from '../../../domains/cats/services/stores/redis-keys/message-keys.js';
import type { IEventMemoryStore } from '../../../domains/memory/EventMemoryStore.js';
import { createModuleLogger } from '../../logger.js';
import { detectMagicWords, MAGIC_WORD_PATTERNS } from './magic-word-detector.js';

const log = createModuleLogger('magic-word-metric');

const MAGIC_WORD_WATERMARK_KEY = (ownerUserId: string) => `magic-word:reconcile-watermark:${ownerUserId}`;

/** Advance a numeric watermark only forward. */
const NUMERIC_WATERMARK_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]))
local nxt = tonumber(ARGV[1])
if (not cur) or (nxt > cur) then
  redis.call('SET', KEYS[1], ARGV[1])
  return 1
end
return 0
`;

const EXCERPT_MAX = 200;
const LIST_PAGE_SIZE = 500;

export interface MagicWordReconcileResult {
  ok: boolean;
  /** user-authored messages scanned in the window */
  scanned: number;
  /** events newly inserted by this reconcile (live path had missed them) */
  backfilled: number;
}

export type MagicWordCountsResult =
  | { unmeasurable: true; reason: 'reconcile_failed' | 'read_failed' }
  | {
      unmeasurable: false;
      window: { fromTs: number; toTs: number };
      reconcile: MagicWordReconcileResult;
      /** unique (message, word) hit count per word — T-B raw口径 */
      counts: Record<string, number>;
      total: number;
    };

interface ScannableMessage {
  id: string;
  threadId: string;
  catId: string;
  content: string;
  mentions: string;
  timestamp: string;
}

export class MagicWordMetricService {
  private readonly redis: RedisClient;
  private readonly eventMemoryStore: IEventMemoryStore;

  constructor(deps: { redis: RedisClient; eventMemoryStore: IEventMemoryStore }) {
    this.redis = deps.redis;
    this.eventMemoryStore = deps.eventMemoryStore;
  }

  private async readWindowMessages(ownerUserId: string, fromTs: number, toTs: number): Promise<ScannableMessage[]> {
    const ids = await this.redis.zrangebyscore(MessageKeys.user(ownerUserId), fromTs, toTs);
    if (ids.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      pipeline.hmget(MessageKeys.detail(id), 'id', 'threadId', 'catId', 'content', 'mentions', 'timestamp');
    }
    const results = await pipeline.exec();
    if (!results || results.length !== ids.length) {
      throw new Error('magic-word reconcile: pipeline result shape mismatch');
    }
    const messages: ScannableMessage[] = [];
    for (const entry of results) {
      const [err, value] = entry as [Error | null, Array<string | null>];
      if (err) throw err;
      const [id, threadId, catId, content, mentions, timestamp] = value;
      if (!id) continue; // expired/deleted hash — nothing to scan
      messages.push({
        id,
        threadId: threadId ?? '',
        catId: catId ?? '',
        content: content ?? '',
        mentions: mentions ?? '[]',
        timestamp: timestamp ?? '0',
      });
    }
    return messages;
  }

  private backfillMessageHits(msg: ScannableMessage, ownerUserId: string): number {
    const hits = detectMagicWords(msg.content);
    if (hits.length === 0) return 0;
    let firstMention: string | null = null;
    try {
      const parsed = JSON.parse(msg.mentions);
      firstMention = Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : null;
    } catch {
      firstMention = null;
    }
    const excerpt = msg.content.length > EXCERPT_MAX ? `${msg.content.slice(0, EXCERPT_MAX)}…` : msg.content;
    const seenWords = new Set<string>();
    let backfilled = 0;
    for (const hit of hits) {
      if (seenWords.has(hit.word)) continue; // unique per (message, word) — same as the store key
      seenWords.add(hit.word);
      const record: EventMemoryRecord = {
        type: hit.word,
        trigger: 'human_brake',
        cat: firstMention ?? 'unknown',
        threadId: msg.threadId,
        messageId: msg.id,
        // message timestamp, NOT scan time — window filters must see the hit
        // where the message actually happened
        timestamp: Number.parseInt(msg.timestamp, 10) || 0,
        summary: excerpt,
        cognitiveTransition: 'user_brake',
        relatedHarness: null,
        confidence: 'high',
      };
      const result = this.eventMemoryStore.markEvent(record, ownerUserId);
      if (result.inserted) backfilled += 1;
    }
    return backfilled;
  }

  /**
   * T-B collection-integrity contract: idempotently re-scan the window's
   * user-authored messages with the pure detector and backfill Event Memory.
   * Cat-authored messages are out of cohort (magic words are operator brakes).
   */
  async reconcileWindow(ownerUserId: string, fromTs: number, toTs: number): Promise<MagicWordReconcileResult> {
    try {
      const messages = await this.readWindowMessages(ownerUserId, fromTs, toTs);
      let scanned = 0;
      let backfilled = 0;
      for (const msg of messages) {
        if (msg.catId !== '') continue; // cat message — live path never detects these either
        scanned += 1;
        backfilled += this.backfillMessageHits(msg, ownerUserId);
      }
      await this.redis.eval(NUMERIC_WATERMARK_LUA, 1, MAGIC_WORD_WATERMARK_KEY(ownerUserId), String(toTs));
      return { ok: true, scanned, backfilled };
    } catch (error) {
      log.error({ error, ownerUserId }, 'magic-word reconcile failed');
      return { ok: false, scanned: 0, backfilled: 0 };
    }
  }

  /**
   * T-B active-V1 metric: unique (message, word) hit counts per word over a
   * reconciled window — a read-only projection of Event Memory.
   */
  async computeWordCounts(ownerUserId: string, fromTs: number, toTs: number): Promise<MagicWordCountsResult> {
    const reconcile = await this.reconcileWindow(ownerUserId, fromTs, toTs);
    if (!reconcile.ok) return { unmeasurable: true, reason: 'reconcile_failed' };

    try {
      const magicWords = new Set<string>(MAGIC_WORD_PATTERNS);
      const counts: Record<string, number> = {};
      let total = 0;
      let offset = 0;
      for (;;) {
        const page = this.eventMemoryStore.listEvents({
          ownerUserId,
          trigger: 'human_brake',
          since: fromTs,
          until: toTs,
          limit: LIST_PAGE_SIZE,
          offset,
        });
        for (const event of page) {
          if (!magicWords.has(event.type)) continue;
          counts[event.type] = (counts[event.type] ?? 0) + 1;
          total += 1;
        }
        if (page.length < LIST_PAGE_SIZE) break;
        offset += LIST_PAGE_SIZE;
      }
      return { unmeasurable: false, window: { fromTs, toTs }, reconcile, counts, total };
    } catch (error) {
      log.error({ error, ownerUserId }, 'magic-word metric read failed');
      return { unmeasurable: true, reason: 'read_failed' };
    }
  }

  /** Collection-health snapshot: how far the reconcile watermark has advanced. */
  async getWatermark(ownerUserId: string): Promise<number | null> {
    try {
      const raw = await this.redis.get(MAGIC_WORD_WATERMARK_KEY(ownerUserId));
      return raw === null ? null : Number.parseInt(raw, 10);
    } catch (error) {
      log.error({ error, ownerUserId }, 'magic-word watermark read failed');
      return null;
    }
  }
}
