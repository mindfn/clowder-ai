/**
 * F202 Train C1 gap A — Host-derived wake for authenticated connector ingress.
 *
 * WHOSE AUTHORITY THIS IS. F288 freezes for v0 that a plugin speaking in its own voice through a
 * `thread_handle` never gains wake power from its text. External IM ingress is a different address
 * kind with a different authority: a `connector_binding` carries a Host-issued binding whose
 * `connectorId`/`externalChatId` the Host itself verified (D-4, send-service.ts stampProvenance).
 * For that ingress the Host — never the package — derives the target. Nothing here reads a
 * plugin-reported mention or wake target; the only inputs are the verified binding, the relayed
 * text, and Host-owned thread activity.
 *
 * WHY IT LIVES HERE. Today the seven IM providers get this from ConnectorRouter
 * (ConnectorRouter.ts:451-495). Migrating them onto the public SDK routes their ingress through
 * the messaging domain instead, which stamps `mentions: []` for every address kind — so without
 * this, the cutover silently removes @-mention wake from every IM channel. The three-way routing
 * below is ConnectorRouter's, reusing its own `parseMentions` rather than a second copy, so the
 * two paths cannot drift while both exist during the cutover.
 */

import { type CatId, type ConnectorSource, getConnectorDefinition } from '@cat-cafe/shared';
import { parseMentions } from '../../infrastructure/connectors/mention-parser.js';

export interface IngressThreadActivity {
  readonly catId: string;
  readonly lastMessageAt: number;
  readonly messageCount: number;
}

/**
 * The Host collaborators an authenticated ingress needs. Offered at the `createMessagingDomain`
 * assembly point; absent means the domain keeps its pre-C1 behaviour (no mentions, no wake).
 */
export interface MessagingIngressWakeDeps {
  readonly invokeTrigger: {
    trigger(threadId: string, catId: CatId, userId: string, message: string, messageId: string): Promise<unknown>;
  };
  readonly socketManager?: { broadcastToRoom(room: string, event: string, data: unknown): void };
  readonly threadStore?: {
    getParticipantsWithActivity(
      threadId: string,
    ): readonly IngressThreadActivity[] | Promise<readonly IngressThreadActivity[]>;
  };
  readonly getDefaultCatId: () => string;
  readonly getMentionPatterns: () => Map<string, string[]>;
}

/**
 * ConnectorRouter's three-way derivation, in its order (ConnectorRouter.ts:451-463):
 *   1. an explicit @-mention wins;
 *   2. otherwise the thread's most recently active participant — `messageCount > 0` filtered
 *      FIRST, then newest `lastMessageAt`, so a cat that has never spoken cannot win on recency;
 *   3. only a thread with no such activity falls back to the default cat.
 * Collapsing 2 into 3 is a user-visible regression, which is why the filter is not an optimisation.
 */
export async function deriveIngressTarget(
  deps: MessagingIngressWakeDeps,
  threadId: string,
  text: string,
): Promise<CatId> {
  const mention = parseMentions(text, deps.getMentionPatterns(), deps.getDefaultCatId() as CatId);
  if (mention.matched) return mention.targetCatId;
  if (!deps.threadStore) return mention.targetCatId;

  const participants = await deps.threadStore.getParticipantsWithActivity(threadId);
  const lastActive = [...participants]
    .filter((participant) => participant.messageCount > 0)
    .sort((left, right) => right.lastMessageAt - left.lastMessageAt)[0];
  return lastActive ? (lastActive.catId as CatId) : mention.targetCatId;
}

/** ConnectorRouter.ts connectorSourceIcon, for a connector the repository registry may not know. */
function ingressIcon(definition: ReturnType<typeof getConnectorDefinition>): string {
  if (!definition) return 'message';
  if ('src' in definition.icon && definition.icon.src) return definition.icon.src;
  return definition.icon.type === 'png' ? definition.icon.src : definition.icon.iconId;
}

function ingressSource(connectorId: string, externalChatId: string): ConnectorSource {
  const definition = getConnectorDefinition(connectorId);
  return {
    connector: connectorId,
    label: definition?.displayName ?? connectorId,
    icon: ingressIcon(definition),
    meta: { externalChatId },
  };
}

/**
 * Publishes the ingress to the thread room in ConnectorRouter's own envelope shape
 * (`connector_message` on `thread:{id}`), so a migrated provider renders identically to the
 * repository-local one it replaces.
 */
export function broadcastIngress(
  deps: MessagingIngressWakeDeps,
  input: {
    readonly threadId: string;
    readonly messageId: string;
    readonly content: string;
    readonly connectorId: string;
    readonly externalChatId: string;
    readonly timestamp: number;
  },
): void {
  deps.socketManager?.broadcastToRoom(`thread:${input.threadId}`, 'connector_message', {
    threadId: input.threadId,
    message: {
      id: input.messageId,
      type: 'connector' as const,
      content: input.content,
      source: ingressSource(input.connectorId, input.externalChatId),
      timestamp: input.timestamp,
    },
  });
}
