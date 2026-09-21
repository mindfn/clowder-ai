import { type ConnectorSource, type MessageContent, MessageContentsSchema } from '@cat-cafe/shared';
import type { IdentityContribution, MessageDraft, PluginManifest } from '@clowder-ai/plugin-contract';
import type { IConnectorThreadBindingStore } from '../../infrastructure/connectors/ConnectorThreadBindingStore.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import { MessagingError } from '../messaging/contract/host-types.js';
import { validateDraft } from '../messaging/contract/validate.js';
import type { MessagingService } from '../messaging/messaging-service.js';
import {
  createUnavailablePluginMessagingSubscriptionHost,
  type PluginMessagingSubscriptionHost,
} from './plugin-messaging-subscription-host.js';

const SEND_KEYS = new Set([
  'threadId',
  'draftAudience',
  'idempotencyKey',
  'sourceEventId',
  'replyTo',
  'payload',
  'wake',
  'sender',
  'contentBlocks',
  'identity',
  'url',
  'meta',
]);
const MAX_SOURCE_URL_LENGTH = 2_048;
const MAX_SOURCE_META_BYTES = 16_384;
const MAX_SOURCE_META_DEPTH = 20;
const MAX_SOURCE_META_VALUES = 2_000;
const HOST_SOURCE_META_KEYS = new Set(['externalChatId']);

export type PluginMessagingSendInput = Omit<MessageDraft, 'address'> & {
  readonly threadId: string;
  readonly wake?: 'auto' | { readonly catId: string };
  readonly sender?: { readonly id: string; readonly name?: string };
  readonly contentBlocks?: readonly MessageContent[];
  readonly identity?: string;
  readonly url?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
};

export interface PluginMessagingHost extends PluginMessagingSubscriptionHost {
  send(input: PluginMessagingSendInput): Promise<{ readonly messageId: string; readonly threadId: string }>;
}

export interface PluginMessagingHostDeps {
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly ownerUserId: string;
  readonly effectiveGrants: readonly string[];
  readonly manifest: PluginManifest;
  readonly threadStore: IThreadStore;
  readonly bindingStore: IConnectorThreadBindingStore;
  readonly messaging: MessagingService;
  readonly subscriptions?: PluginMessagingSubscriptionHost;
}

export function createUnavailablePluginMessagingHost(): PluginMessagingHost {
  const subscriptions = createUnavailablePluginMessagingSubscriptionHost().host;
  return {
    ...subscriptions,
    async send() {
      throw new MessagingError('PERMISSION', 'Host messaging services are unavailable');
    },
  };
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw new MessagingError('VALIDATION', `${field} must be 1..${maximum} non-whitespace-trimmed characters`);
  }
  return value;
}

function senderOf(value: unknown): { readonly id: string; readonly name?: string } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MessagingError('VALIDATION', 'sender must be an object');
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== 'id' && key !== 'name')) {
    throw new MessagingError('VALIDATION', 'sender contains unsupported fields');
  }
  return {
    id: boundedString(candidate.id, 'sender.id', 500),
    ...(candidate.name === undefined ? {} : { name: boundedString(candidate.name, 'sender.name', 200) }),
  };
}

function wakeOf(value: unknown): PluginMessagingSendInput['wake'] {
  if (value === undefined || value === 'auto') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MessagingError('VALIDATION', 'wake must be auto or { catId }');
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== 1 || !Object.hasOwn(candidate, 'catId')) {
    throw new MessagingError('VALIDATION', 'wake must contain only catId');
  }
  return { catId: boundedString(candidate.catId, 'wake.catId', 200) };
}

function sourceUrlOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const raw = boundedString(value, 'url', MAX_SOURCE_URL_LENGTH);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new MessagingError('VALIDATION', 'url must be an absolute http(s) URL');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    throw new MessagingError('VALIDATION', 'url must be an absolute http(s) URL without credentials');
  }
  return raw;
}

interface SourceMetaValidationState {
  readonly seen: WeakSet<object>;
  values: number;
}

function validateSourceMetaObject(candidate: object, depth: number, state: SourceMetaValidationState): void {
  if (state.seen.has(candidate)) throw new MessagingError('VALIDATION', 'meta must not contain cycles');
  state.seen.add(candidate);
  if (Array.isArray(candidate)) {
    for (const item of candidate) validateSourceMetaValue(item, depth + 1, state);
    return;
  }
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MessagingError('VALIDATION', 'meta must contain only plain JSON objects');
  }
  for (const [key, item] of Object.entries(candidate)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new MessagingError('VALIDATION', `meta key ${key} is reserved`);
    }
    validateSourceMetaValue(item, depth + 1, state);
  }
}

function validateSourceMetaValue(candidate: unknown, depth: number, state: SourceMetaValidationState): void {
  state.values += 1;
  if (state.values > MAX_SOURCE_META_VALUES || depth > MAX_SOURCE_META_DEPTH) {
    throw new MessagingError('VALIDATION', 'meta exceeds the Host complexity limit');
  }
  if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return;
  if (typeof candidate === 'number') {
    if (!Number.isFinite(candidate)) throw new MessagingError('VALIDATION', 'meta numbers must be finite');
    return;
  }
  if (typeof candidate !== 'object') throw new MessagingError('VALIDATION', 'meta must contain only JSON values');
  validateSourceMetaObject(candidate, depth, state);
}

function sourceMetaOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MessagingError('VALIDATION', 'meta must be a JSON object');
  }
  validateSourceMetaValue(value, 0, { seen: new WeakSet<object>(), values: 0 });
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SOURCE_META_BYTES) {
    throw new MessagingError('VALIDATION', `meta must be at most ${MAX_SOURCE_META_BYTES} UTF-8 bytes`);
  }
  const cloned = JSON.parse(serialized) as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(cloned)) {
    if (HOST_SOURCE_META_KEYS.has(key)) {
      throw new MessagingError('VALIDATION', `meta.${key} is owned by the Host`);
    }
  }
  return cloned;
}

function externalIdentity(
  manifest: PluginManifest,
  declared: ReadonlyMap<string, IdentityContribution>,
  origin: Extract<NonNullable<MessageDraft['payload']['provenance']['origin']>, { kind: 'external' }>,
  requestedIdentityId: string | undefined,
): { readonly connector: string; readonly identity: IdentityContribution } {
  const contribution = (manifest.contributions ?? []).find(
    (candidate) => candidate.type === 'connector' && candidate.id === origin.connectorId,
  );
  if (!contribution || contribution.type !== 'connector') {
    throw new MessagingError('PERMISSION', `connector ${origin.connectorId} is not declared by this plugin`);
  }
  const identity = declared.get(contribution.identityRef);
  if (!identity) throw new MessagingError('VALIDATION', 'connector identity declaration is missing');
  if (requestedIdentityId !== undefined && identity.id !== requestedIdentityId) {
    throw new MessagingError(
      'VALIDATION',
      `connector ${origin.connectorId} does not use identity ${requestedIdentityId}`,
    );
  }
  return { connector: contribution.id, identity };
}

function authoredIdentity(
  declared: ReadonlyMap<string, IdentityContribution>,
  requestedIdentityId: string | undefined,
): { readonly connector: string; readonly identity: IdentityContribution } {
  const all = [...declared.values()];
  const identity =
    requestedIdentityId === undefined ? (all.length === 1 ? all[0] : undefined) : declared.get(requestedIdentityId);
  if (!identity) {
    const message =
      requestedIdentityId === undefined
        ? 'plugin-authored messages require exactly one declared identity'
        : `identity ${requestedIdentityId} is not declared`;
    throw new MessagingError('VALIDATION', message);
  }
  return { connector: identity.id, identity };
}

function identities(manifest: PluginManifest): ReadonlyMap<string, IdentityContribution> {
  return new Map(
    (manifest.contributions ?? [])
      .filter((contribution): contribution is IdentityContribution => contribution.type === 'identity')
      .map((identity) => [identity.id, identity]),
  );
}

function identitySource(
  manifest: PluginManifest,
  origin: MessageDraft['payload']['provenance']['origin'],
  sender: { readonly id: string; readonly name?: string } | undefined,
  requestedIdentityId: string | undefined,
  url: string | undefined,
  meta: Readonly<Record<string, unknown>> | undefined,
): ConnectorSource {
  const declared = identities(manifest);
  const selected =
    origin?.kind === 'external'
      ? externalIdentity(manifest, declared, origin, requestedIdentityId)
      : authoredIdentity(declared, requestedIdentityId);
  const sourceMeta = {
    ...(meta ?? {}),
    ...(origin?.kind === 'external' && origin.sourceAddress !== undefined
      ? { externalChatId: origin.sourceAddress.chatId }
      : {}),
  };
  return {
    connector: selected.connector,
    label: selected.identity.displayName,
    icon: selected.identity.icon ?? 'message',
    ...(url === undefined ? {} : { url }),
    ...(Object.keys(sourceMeta).length === 0 ? {} : { meta: sourceMeta }),
    ...(sender === undefined ? {} : { sender }),
  };
}

function recordOf(input: PluginMessagingSendInput): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MessagingError('VALIDATION', 'messaging.send input must be an object');
  }
  const record = input as unknown as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !SEND_KEYS.has(key));
  if (extra.length > 0)
    throw new MessagingError('VALIDATION', `messaging.send has unsupported fields: ${extra.join(', ')}`);
  return record;
}

export function createPluginMessagingHost(input: PluginMessagingHostDeps): PluginMessagingHost {
  return {
    ...(input.subscriptions ?? createUnavailablePluginMessagingSubscriptionHost().host),
    async send(value) {
      if (!input.effectiveGrants.includes('messaging.send')) {
        throw new MessagingError('PERMISSION', `${input.pluginId} lacks messaging.send`);
      }
      const record = recordOf(value);
      const threadId = boundedString(record.threadId, 'threadId', 500);
      const thread = await input.threadStore.get(threadId);
      if (!thread) throw new MessagingError('NOT_FOUND', `thread ${threadId} does not exist`);
      const bindings = await input.bindingStore.getByThread(threadId);
      const hasPluginBinding = bindings.some(
        (binding) => binding.connectorId === input.pluginId && binding.userId === input.ownerUserId,
      );
      if (
        thread.createdBy !== input.ownerUserId &&
        thread.pluginOwnership?.pluginInstanceId !== input.pluginInstanceId &&
        !hasPluginBinding
      ) {
        throw new MessagingError('PERMISSION', `${input.pluginId} cannot send to thread ${threadId}`);
      }

      const sender = senderOf(record.sender);
      const wake = wakeOf(record.wake);
      const requestedIdentityId =
        record.identity === undefined ? undefined : boundedString(record.identity, 'identity', 200);
      const sourceUrl = sourceUrlOf(record.url);
      const sourceMeta = sourceMetaOf(record.meta);
      const rawOrigin = (record.payload as { provenance?: { origin?: { kind?: unknown } } } | undefined)?.provenance
        ?.origin;
      const validated = validateDraft({
        address:
          rawOrigin?.kind === 'external'
            ? { kind: 'connector_binding', handle: 'internal-validation' }
            : { kind: 'thread_handle', handle: 'internal-validation' },
        ...(record.draftAudience === undefined ? {} : { draftAudience: record.draftAudience }),
        idempotencyKey: record.idempotencyKey,
        ...(record.sourceEventId === undefined ? {} : { sourceEventId: record.sourceEventId }),
        ...(record.replyTo === undefined ? {} : { replyTo: record.replyTo }),
        payload: record.payload,
      });
      const origin = validated.payload.provenance.origin;
      if (origin?.kind === 'plugin' && origin.instanceId !== input.pluginInstanceId) {
        throw new MessagingError('PERMISSION', 'declared plugin origin does not match the calling instance');
      }
      if (
        origin?.kind === 'external' &&
        origin.sourceAddress !== undefined &&
        origin.sourceAddress.connectorId !== origin.connectorId
      ) {
        throw new MessagingError('PERMISSION', 'sourceAddress.connectorId does not match the declared connector');
      }
      const contentBlocks = record.contentBlocks;
      if (contentBlocks !== undefined && !Array.isArray(contentBlocks)) {
        throw new MessagingError('VALIDATION', 'contentBlocks must be an array');
      }
      const parsedContentBlocks =
        contentBlocks === undefined ? undefined : MessageContentsSchema.safeParse(contentBlocks);
      if (parsedContentBlocks !== undefined && !parsedContentBlocks.success) {
        throw new MessagingError('VALIDATION', 'contentBlocks failed Host validation');
      }
      const source = identitySource(input.manifest, origin, sender, requestedIdentityId, sourceUrl, sourceMeta);
      const scope = {
        canSend: true,
        canSubscribe: input.effectiveGrants.includes('message.event.subscribe'),
      };
      let address: MessageDraft['address'];
      if (origin?.kind === 'external') {
        const sourceAddress = origin.sourceAddress;
        if (!sourceAddress) throw new MessagingError('VALIDATION', 'external origin requires sourceAddress');
        const binding = await input.bindingStore.getByExternal(input.pluginId, sourceAddress.chatId);
        if (!binding || binding.userId !== input.ownerUserId || binding.threadId !== threadId) {
          throw new MessagingError(
            'PERMISSION',
            `external chat ${sourceAddress.chatId} is not bound to thread ${threadId}`,
          );
        }
        const handle = await input.messaging.ensureConnectorBindingHandle({
          pluginInstanceId: input.pluginInstanceId,
          threadId,
          userId: input.ownerUserId,
          scope,
          connectorId: origin.connectorId,
          externalChatId: sourceAddress.chatId,
        });
        address = { kind: 'connector_binding', handle: handle.handleId };
      } else {
        const handle = await input.messaging.ensureThreadHandle({
          pluginInstanceId: input.pluginInstanceId,
          threadId,
          userId: input.ownerUserId,
          scope,
        });
        address = { kind: 'thread_handle', handle: handle.handleId };
      }

      const draft = { ...validated, address };
      const receipt = await input.messaging.sendFromHost({ pluginInstanceId: input.pluginInstanceId }, draft, {
        source,
        ...(parsedContentBlocks === undefined
          ? {}
          : { contentBlocks: parsedContentBlocks.data as readonly MessageContent[] }),
        ...(sender === undefined ? {} : { sender }),
        ...(wake === undefined ? {} : { wake }),
      });
      return { messageId: receipt.messageId, threadId: receipt.threadId };
    },
  };
}
