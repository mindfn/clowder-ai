/**
 * F202 Train C1 — shared fixture for the production-composition gate files.
 *
 * Extracted per fourth-round review P2: the binding/checkpoint durability cases and the
 * config/secret projection cases each need this composition, and duplicating it would push
 * both files past the 350-line hard limit.
 *
 * The per-case source coordinates for every gap live in the plan
 * (docs/plans/2026-09-19-f202-train-c1-migration-plan.md §5.1), not in these headers.
 */
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { createDormantPluginRuntimeComposition } from '../dist/domains/plugin/index.js';
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';
import { FakePluginProcessAdapter } from './plugin-external-runtime-helpers.js';

export const CONNECTOR_ID = 'feishu';
export const SIBLING_CONNECTOR_ID = 'telegram';
export const EXTERNAL_CHAT_ID = 'oc-chat-9';
export const THREAD_ID = 'thread-1';
export const DEFAULT_CAT_ID = 'codex';
export const EXTERNAL_INSTANCE = 'pi_external';

/**
 * Builds the REAL production composition and offers it the Host collaborators an IM cutover
 * needs. `DormantPluginRuntimeCompositionOptions` declares none of them today, so they are
 * silently dropped — which is exactly what case 7 measures.
 *
 * `bindingStore` is offered as an explicitly isolated durable binding authority. The
 * composition has no such seam yet; passing it keeps cases 9/11 from silently falling back to
 * projectRoot-as-persistence, which would push the implementation toward a duplicate file store.
 */
export async function productionComposition(projectRoot, overrides = {}) {
  const { processes = new FakePluginProcessAdapter(), bindingStore, packages } = overrides;
  const wakes = [];
  const broadcasts = [];
  const participants = [];
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    processes,
    ...(bindingStore === undefined ? {} : { bindingStore }),
    ...(packages === undefined ? {} : { packages }),
    now: () => 5_000,
    invokeTrigger: {
      async trigger(threadId, catId, userId, message, messageId) {
        wakes.push({ threadId, catId, userId, message, messageId });
        return 'dispatched';
      },
    },
    socketManager: {
      broadcastToRoom(room, event, data) {
        broadcasts.push({ room, event, data });
      },
    },
    threadStore: {
      async getParticipantsWithActivity() {
        return participants;
      },
    },
    getDefaultCatId: () => DEFAULT_CAT_ID,
    getMentionPatterns: () => new Map([['opus', ['@opus', '@宪宪']]]),
  });
  return { runtime, wakes, broadcasts, participants, processes };
}

export function ingressDraft(handleId, text, idempotencyKey) {
  return {
    address: { kind: 'connector_binding', handle: handleId },
    idempotencyKey,
    sourceEventId: `${CONNECTOR_ID}-evt-${idempotencyKey}`,
    payload: {
      provenance: {
        epistemicStatus: 'user_intent',
        origin: {
          kind: 'external',
          connectorId: CONNECTOR_ID,
          sourceAddress: { connectorId: CONNECTOR_ID, chatId: EXTERNAL_CHAT_ID, messageId: 'ext-msg-7' },
        },
      },
      elements: [{ elementId: 'el-1', kind: 'text', payload: { text } }],
    },
  };
}

export async function waitForSpec(processes, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (processes.specs.length === 0) {
    if (Date.now() >= deadline) throw new Error('external package was never spawned');
    await new Promise((done) => setTimeout(done, 5));
  }
  return processes.specs[0];
}
