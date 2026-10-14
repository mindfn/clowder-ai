import type { CatId } from '@cat-cafe/shared';
import type { ConnectorTriggerPolicy } from '../../email/ConnectorInvokeTrigger.js';

/**
 * F167: a Repo Inbox wake delivers an F168 community case; it is not an F167 protocol ball.
 * Its obligations (first response, canonical case, routing) belong to the F168 community ledger
 * and patrol, so F167 must not create a second protocol ball for the wake. This category declares
 * that ownership boundary; it does not claim webhook event ingestion has already completed, since
 * that path is deliberately best-effort and may run after the trigger.
 * Ruling: thread_mp3ab0r9xqxrkrc5#0001790911847173-000222-db2d26fe.
 */
export interface RepoInboxWakePolicy {
  readonly sourceCategory: 'repo_inbox';
}

export const REPO_INBOX_WAKE_POLICY = Object.freeze({
  sourceCategory: 'repo_inbox',
}) satisfies RepoInboxWakePolicy & ConnectorTriggerPolicy;

/** Wake port for both Repo Inbox producers. The policy is required so neither entry can drop it. */
export interface RepoInboxWakeTrigger {
  trigger(
    threadId: string,
    catId: CatId,
    userId: string,
    message: string,
    messageId: string,
    contentBlocks: undefined,
    policy: RepoInboxWakePolicy,
  ): unknown;
}
