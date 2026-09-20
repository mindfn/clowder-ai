/**
 * F202 Train C1 — the half of the cutover that mints the address.
 *
 * `SendService.send()` addresses a handle whose `threadId` was fixed at issuance; it never
 * creates a thread and never writes a connector binding. An IM first contact has neither, and
 * nothing in the running process ever called `issueConnectorBindingHandle` — which is why the
 * wake path this train already landed is unreachable today. This is the missing front half:
 * external conversation → thread + binding + handle → canonical admission.
 *
 * WHY THE BINDING IS NOT BOOKKEEPING. Outbound delivery keys off a different store than
 * messaging handles: `OutboundDeliveryHook.deliver()` reads `bindingStore.getByThread(threadId)`
 * and returns silently when empty. A provider moved onto the public SDK without this would keep
 * admitting inbound messages while every cat reply stopped being delivered.
 *
 * PORT DIRECTION. Every type here is Host-owned and this module imports nothing from
 * `@clowder-ai/plugin-sdk`: the Host defines the port, the SDK wraps it. The field names mirror
 * the connector contract (`externalConversationId`, `providerMessageId`, `sender`,
 * `conversation`) so both sides remain checkable against one shape without the Host depending
 * on the author-facing package.
 */

/** One inbound message as the Host accepts it, independent of which platform produced it. */
export interface HostConnectorInbound {
  readonly connectorId: string;
  readonly externalConversationId: string;
  /** The platform's own message id — the Host's idempotency key for this admission. */
  readonly providerMessageId: string;
  readonly text: string;
  readonly sender?: { readonly id: string; readonly name?: string };
  readonly conversation?: { readonly type: 'direct' | 'group'; readonly title?: string };
}

export interface ConnectorBindingRecord {
  readonly connectorId: string;
  readonly externalChatId: string;
  readonly threadId: string;
  readonly userId: string;
}

export interface ConnectorIngressDeps {
  readonly messaging: {
    issueConnectorBindingHandle(input: {
      pluginInstanceId: string;
      threadId: string;
      userId: string;
      scope: { canSend: boolean; canSubscribe: boolean };
      connectorId: string;
      externalChatId: string;
    }): Promise<{ handleId: string }>;
    send(ctx: { pluginInstanceId: string }, draft: unknown): Promise<{ messageId: string; threadId: string }>;
  };
  readonly bindings: {
    getByExternal(connectorId: string, externalChatId: string): Promise<ConnectorBindingRecord | null>;
    bind(
      connectorId: string,
      externalChatId: string,
      threadId: string,
      userId: string,
    ): Promise<ConnectorBindingRecord>;
  };
  readonly threads: {
    create(userId: string, title: string, projectPath?: string): Promise<{ id: string }> | { id: string };
  };
  readonly defaultUserId: string;
  readonly projectPath?: string;
  /** Human label for the platform; defaults to the raw connector id. */
  readonly connectorLabel?: (connectorId: string) => string;
  /**
   * The instance a connector speaks as. Stable per connector so the send ledger's
   * `(instanceId, idempotencyKey)` claim dedupes a provider redelivery. A real plugin instance
   * id is supplied once the package owns the connector; the default covers the Host-run period.
   */
  readonly instanceIdFor?: (connectorId: string) => string;
}

export interface ConnectorAdmission {
  readonly threadId: string;
  readonly messageId: string;
}

/** Mirrors ConnectorRouter's titles so a migrated conversation is not visibly renamed. */
function deriveTitle(input: HostConnectorInbound, label: string): string {
  if (input.conversation?.type === 'group') {
    const name = input.conversation.title || input.externalConversationId.slice(-8);
    return `${label}群聊 · ${name}`;
  }
  return `${label} DM`;
}

export class ConnectorIngress {
  private readonly deps: ConnectorIngressDeps;
  /**
   * One handle per conversation, cached for the process lifetime. The handle records themselves
   * are durable; this only avoids minting a fresh one per message. A restart mints one more for
   * the conversation, which is harmless — both address the same thread and binding.
   */
  private readonly handleByConversation = new Map<string, string>();

  constructor(deps: ConnectorIngressDeps) {
    this.deps = deps;
  }

  private label(connectorId: string): string {
    return this.deps.connectorLabel?.(connectorId) ?? connectorId;
  }

  private instanceId(connectorId: string): string {
    return this.deps.instanceIdFor?.(connectorId) ?? `connector:${connectorId}`;
  }

  /** Resolve the conversation's thread, creating the thread and its binding on first contact. */
  private async resolveBinding(input: HostConnectorInbound): Promise<ConnectorBindingRecord> {
    const existing = await this.deps.bindings.getByExternal(input.connectorId, input.externalConversationId);
    if (existing) return existing;

    const thread = await this.deps.threads.create(
      this.deps.defaultUserId,
      deriveTitle(input, this.label(input.connectorId)),
      this.deps.projectPath,
    );
    return this.deps.bindings.bind(input.connectorId, input.externalConversationId, thread.id, this.deps.defaultUserId);
  }

  private async resolveHandle(binding: ConnectorBindingRecord): Promise<string> {
    const key = `${binding.connectorId}:${binding.externalChatId}`;
    const cached = this.handleByConversation.get(key);
    if (cached) return cached;

    const { handleId } = await this.deps.messaging.issueConnectorBindingHandle({
      pluginInstanceId: this.instanceId(binding.connectorId),
      threadId: binding.threadId,
      userId: binding.userId,
      scope: { canSend: true, canSubscribe: false },
      connectorId: binding.connectorId,
      externalChatId: binding.externalChatId,
    });
    this.handleByConversation.set(key, handleId);
    return handleId;
  }

  /**
   * Admit one inbound message. Idempotent on `providerMessageId`: the send ledger returns the
   * original receipt for a redelivery, so a replay neither persists a second message nor spends
   * a second agent turn.
   */
  async admit(input: HostConnectorInbound): Promise<ConnectorAdmission> {
    const binding = await this.resolveBinding(input);
    const handle = await this.resolveHandle(binding);

    const receipt = await this.deps.messaging.send(
      { pluginInstanceId: this.instanceId(input.connectorId) },
      {
        address: { kind: 'connector_binding', handle },
        idempotencyKey: input.providerMessageId,
        payload: {
          provenance: {
            epistemicStatus: 'user_intent',
            origin: {
              kind: 'external',
              connectorId: input.connectorId,
              sourceAddress: {
                connectorId: input.connectorId,
                chatId: input.externalConversationId,
                messageId: input.providerMessageId,
              },
            },
          },
          elements: [{ elementId: 'el-1', kind: 'text', payload: { text: input.text } }],
        },
      },
    );
    return { threadId: receipt.threadId, messageId: receipt.messageId };
  }
}

export function createConnectorIngress(deps: ConnectorIngressDeps): ConnectorIngress {
  return new ConnectorIngress(deps);
}
