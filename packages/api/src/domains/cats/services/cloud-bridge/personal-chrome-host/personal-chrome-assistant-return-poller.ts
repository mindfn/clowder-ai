import type {
  CloudAssistantReturnIngestInput,
  CloudAssistantReturnIngestOutcome,
} from '../cloud-assistant-return-ingest.js';
import type { PersonalChromeAssistantReturnCursor } from './assistant-return-cursor.js';
import type { IPersonalChromeAssistantReturnAdapter } from './personal-chrome-host-transport.js';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
/**
 * While the Host Adapter is unavailable (not installed, or its helper is not running) the poller
 * backs off exponentially from twice the poll interval up to this cap, instead of retrying — and
 * logging — every second on every Host where ChatGPT Pro is not installed. The first answer resets it.
 */
const MAX_UNAVAILABLE_BACKOFF_MS = 60_000;

function isHostUnavailable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'HOST_UNAVAILABLE';
}

interface AssistantReturnIngestPort {
  ingest(input: CloudAssistantReturnIngestInput): Promise<CloudAssistantReturnIngestOutcome>;
}

interface AssistantReturnPollerLogger {
  debug?(context: object, message: string): void;
  warn(context: object, message: string): void;
}

export class PersonalChromeAssistantReturnPoller {
  private timer: NodeJS.Timeout | undefined;
  private draining = false;
  private resumeAfter: PersonalChromeAssistantReturnCursor | undefined;
  /** Consecutive HOST_UNAVAILABLE answers; zero while the adapter is reachable. */
  private unavailableStreak = 0;
  private nextAttemptAt = 0;

  constructor(
    private readonly deps: {
      readonly adapter: IPersonalChromeAssistantReturnAdapter;
      readonly ingestService: AssistantReturnIngestPort;
      readonly logger: AssistantReturnPollerLogger;
      readonly grantPersistence: 'durable' | 'ephemeral';
      readonly pollIntervalMs?: number;
      readonly now?: () => number;
    },
  ) {
    const interval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isInteger(interval) || interval < 50) {
      throw new Error('personal Chrome assistant return poll interval must be an integer of at least 50ms');
    }
  }

  start(): void {
    if (this.timer) return;
    void this.drainOnce();
    this.timer = setInterval(() => void this.drainOnce(), this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async drainOnce(): Promise<void> {
    if (this.draining) return;
    if (this.unavailableStreak > 0 && this.now() < this.nextAttemptAt) return;
    this.draining = true;
    try {
      const pending = await this.deps.adapter.list_assistant_returns(this.resumeAfter);
      if (this.unavailableStreak > 0) {
        this.unavailableStreak = 0;
        this.deps.logger.debug?.({}, '[F247] personal Chrome Host Adapter answered; assistant return polling resumed');
      }
      const item = pending[0];
      if (!item) {
        this.resumeAfter = undefined;
        return;
      }
      const outcome = await this.deps.ingestService.ingest({
        sourceMessageId: item.sourceMessageId,
        content: item.content,
      });
      if (outcome.status === 'retry') {
        return;
      }
      if (
        outcome.status === 'rejected' &&
        outcome.reason === 'grant_not_found' &&
        this.deps.grantPersistence === 'ephemeral'
      ) {
        this.resumeAfter = {
          conversationId: item.conversationId,
          sourceMessageId: item.sourceMessageId,
          assistantMessageId: item.assistantMessageId,
        };
        return;
      }
      if (outcome.status === 'rejected') {
        this.deps.logger.warn(
          {
            conversationId: item.conversationId,
            sourceMessageId: item.sourceMessageId,
            assistantMessageId: item.assistantMessageId,
            reason: outcome.reason,
          },
          '[F247] rejected a browser-observed assistant final outside the server-authorized source boundary',
        );
      }
      await this.deps.adapter.ack_assistant_return(item.conversationId, item.sourceMessageId, item.assistantMessageId);
      this.resumeAfter = undefined;
    } catch (error) {
      const detail = { error: error instanceof Error ? { name: error.name, message: error.message } : String(error) };
      if (isHostUnavailable(error)) {
        this.unavailableStreak += 1;
        const interval = this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        const backoff = Math.min(MAX_UNAVAILABLE_BACKOFF_MS, interval * 2 ** this.unavailableStreak);
        this.nextAttemptAt = this.now() + backoff;
        // Only the change of state is worth a line; the repeats are the expected steady state.
        if (this.unavailableStreak === 1) {
          this.deps.logger.debug?.(
            detail,
            `[F247] personal Chrome Host Adapter unavailable; assistant return polling backs off to one check per ${MAX_UNAVAILABLE_BACKOFF_MS / 1_000}s until it answers`,
          );
        }
        return;
      }
      this.deps.logger.debug?.(detail, '[F247] personal Chrome assistant return poll deferred');
    } finally {
      this.draining = false;
    }
  }
}
