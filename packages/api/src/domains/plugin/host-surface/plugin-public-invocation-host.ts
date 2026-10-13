import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PluginManifest } from '@clowder-ai/plugin-contract';
import type { InvocationQueue, QueueEntry } from '../../cats/services/agents/invocation/InvocationQueue.js';
import { createInitialQueuedMessageCustody } from '../../cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { buildQueueEntry } from '../../cats/services/agents/invocation/QueuedMessageCustodyStartupQueueEntry.js';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import {
  assertPluginPublicInvocationCarrier,
  type PluginPublicInvocationCarrierV1,
  publicInvocationCarriersMatch,
} from '../../cats/services/stores/ports/plugin-public-invocation-carrier.js';
import {
  assertQueueCustodyMessageBinding,
  assertQueuedMessageCustody,
} from '../../cats/services/stores/ports/queued-message-custody.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { snapshotPluginProtocolData } from '../carrier/plugin-protocol-data.js';
import { currentPluginTransportPurpose } from '../carrier/plugin-transport-context.js';
import {
  assertPublicVerifierContribution,
  type PublicInvocationVerifierPort,
} from '../carrier/public-invocation-verifier.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';

export interface PluginPublicInvocationInput {
  readonly messageRef: `message:${string}`;
  readonly targetCatId: string;
  readonly native: { readonly contributionId: string; readonly methods: readonly string[] };
  readonly authority: { readonly ref: string; readonly revision: string };
}
export interface PluginPublicInvocationHost {
  enqueue(input: PluginPublicInvocationInput): Promise<
    Readonly<{
      messageRef: `message:${string}`;
      entryId: string;
      status: 'queued' | 'processing' | 'terminal';
    }>
  >;
}
export interface PluginPublicInvocationServices {
  readonly queue: InvocationQueue;
  resume(threadId: string, userId: string): Promise<void>;
}
interface Deps {
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
  readonly lifecycleRevision: number;
  readonly grantRevision: number;
  readonly manifest: PluginManifest;
  readonly effectiveGrants: readonly string[];
  readonly ownerUserId: string | undefined;
  readonly messages: Pick<IMessageStore, 'getById' | 'prepareQueueAdmission' | 'initializeQueueCustody'> | undefined;
  readonly threads: Pick<IThreadStore, 'get'> | undefined;
  readonly services: PluginPublicInvocationServices | undefined;
  readonly verify: PublicInvocationVerifierPort['invokePublicInvocationVerifier'];
  readonly assertCurrent: (capabilities: readonly string[]) => Promise<void>;
}
function refuse(): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Public source admission is unavailable or changed');
}
function keys(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !isDeepStrictEqual(Object.keys(value).sort(), names.sort())
  )
    refuse();
}
/** Admit an already persisted plugin message; business meaning remains in the private verifier. */
export function createPluginPublicInvocationHost(deps: Deps): PluginPublicInvocationHost {
  return Object.freeze({
    enqueue: async (input: PluginPublicInvocationInput) => {
      const value = snapshotPluginProtocolData(input);
      keys(value, ['messageRef', 'targetCatId', 'native', 'authority']);
      keys(value.native, ['contributionId', 'methods']);
      keys(value.authority, ['ref', 'revision']);
      if (
        typeof value.messageRef !== 'string' ||
        !/^message:\S{1,500}$/u.test(value.messageRef) ||
        !Array.isArray(value.native.methods)
      )
        refuse();
      const messages = deps.messages,
        threads = deps.threads,
        services = deps.services,
        owner = deps.ownerUserId;
      if (!messages || !threads || !services || !owner)
        throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host public admission unavailable');
      if (currentPluginTransportPurpose() === 'verifier' || currentPluginTransportPurpose() === 'browser') refuse();
      const id = value.messageRef.slice('message:'.length);
      const current = () => deps.assertCurrent(['thread.readContent', 'messaging.send']);
      await current();
      function source(message: StoredMessage | null): StoredMessage {
        if (
          !message ||
          message.id !== id ||
          message.userId !== owner ||
          message.catId !== null ||
          message.deletedAt ||
          message.recall ||
          message._tombstone ||
          message.sourceParseFailure ||
          message.queueCustodyAdmission ||
          !message.source?.connector ||
          message.extra?.pluginMessage?.instanceId !== deps.pluginInstanceId
        )
          refuse();
        return message;
      }
      const initial = structuredClone(source(await messages.getById(id)));
      const candidate = {
        version: 1,
        admissionId: createHash('sha256')
          .update(JSON.stringify([deps.pluginInstanceId, id]))
          .digest('hex'),
        sourceMessageId: id,
        sourcePluginRevision: initial.extra?.pluginMessage?.revision ?? 0,
        pluginInstanceId: deps.pluginInstanceId,
        packageDigest: deps.packageDigest,
        lifecycleRevision: deps.lifecycleRevision,
        grantRevision: deps.grantRevision,
        contributionId: value.native.contributionId,
        actionMethods: [...value.native.methods].sort(),
        targetCatId: value.targetCatId,
        authorityRef: value.authority.ref,
        authorityRevision: value.authority.revision,
      };
      assertPluginPublicInvocationCarrier(candidate);
      const carrier: PluginPublicInvocationCarrierV1 = candidate;
      assertPublicVerifierContribution(deps.manifest, deps.effectiveGrants, carrier);
      // Custody/delivery can advance while this call awaits; immutable message data cannot.
      function content(message: StoredMessage) {
        const {
          queueCustody: _custody,
          deliveryStatus: _delivery,
          deliveredAt: _at,
          timelineOrderAt: _order,
          ...data
        } = message;
        return data;
      }
      async function check(): Promise<StoredMessage> {
        await current();
        const thread = await threads!.get(initial.threadId);
        if (!thread || thread.createdBy !== owner || !thread.participants.some((cat) => cat === carrier.targetCatId))
          refuse();
        await current();
        const message = source(await messages!.getById(id));
        if (!isDeepStrictEqual(content(initial), content(message))) refuse();
        if (message.queueCustody) {
          // Normal completion retains custody on a delivered message. Read its
          // terminal receipt without treating it as a new queued admission.
          if (message.deliveryStatus === 'delivered' && message.queueCustody.status === 'terminal') {
            assertQueuedMessageCustody(message.queueCustody);
          } else {
            assertQueueCustodyMessageBinding(message);
          }
          if (!publicInvocationCarriersMatch(message.queueCustody.pluginPublicInvocation, carrier)) refuse();
        } else if (message.deliveryStatus !== undefined && message.deliveryStatus !== 'queued') refuse();
        return message;
      }
      await check();
      const abort = new AbortController();
      try {
        await deps.verify(deps.pluginInstanceId, carrier, {
          signal: abort.signal,
          assertCurrent: async () => {
            await check();
          },
        });
        let message = await check();
        if (!message.queueCustody) {
          const prepared = await messages.prepareQueueAdmission(id);
          if (prepared.kind !== 'prepared' && prepared.kind !== 'existing') refuse();
          message = await check();
          const entry: QueueEntry = {
            id: randomUUID(),
            threadId: message.threadId,
            userId: owner,
            ownerAuthProvenance: 'unknown',
            content: message.content,
            messageId: id,
            mergedMessageIds: [],
            source: 'connector',
            targetCats: [carrier.targetCatId],
            allTargetCats: [carrier.targetCatId],
            intent: 'execute',
            status: 'queued',
            createdAt: Date.now(),
            autoExecute: true,
            priority: 'normal',
            pluginPublicInvocation: carrier,
          };
          const initialized = await messages.initializeQueueCustody(id, createInitialQueuedMessageCustody(entry));
          if (initialized.kind !== 'initialized' && initialized.kind !== 'existing') refuse();
          message = await check();
        }
        const custody = message.queueCustody;
        if (!custody) refuse();
        // Never restore or resume an already-started child, including failed/no-replay sources.
        if (
          custody.status === 'queued' &&
          !custody.prestartRetirement &&
          Object.keys(custody.awakenedInvocationIdByCatId ?? {}).length === 0
        ) {
          services.queue.restoreDurableEntry(buildQueueEntry([message], custody.entryId));
          await services.resume(message.threadId, owner);
        }
        message = await check();
        if (!message.queueCustody) refuse();
        return Object.freeze({
          messageRef: `message:${id}` as const,
          entryId: message.queueCustody.entryId,
          status: message.queueCustody.status,
        });
      } finally {
        abort.abort();
      }
    },
  });
}
