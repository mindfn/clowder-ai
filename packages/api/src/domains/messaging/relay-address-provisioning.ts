/**
 * F202 Train C1 — what a relaying package is handed when it activates.
 *
 * A package speaking in its own voice never gains wake power from its text; that is a frozen v0
 * security property. Relaying a human's "@opus" and having a cat answer therefore needs an
 * address whose external identity the Host verified, and no SDK can grant itself one. So the
 * Host mints it, once, at activation.
 *
 * It also removes two steps from the package. The fallback thread is fixed and derived from the
 * package's own identity, so the Host settles it here rather than the package discovering it is
 * unbound, asking for its thread, creating one and retrying. A package handed its address has
 * nothing left to bootstrap — which is what keeps this off the published plugin-to-Host surface.
 *
 * KNOWN BOUNDARY, stated rather than hidden. The address issued here is bound to one synthetic
 * conversation standing for "this package's own system thread". A package that later maps real
 * conversations to their own threads needs an address per thread, and D-4 pins a declared
 * `sourceAddress.chatId` to the address's own external chat — so that case is NOT served by this
 * one address, and sends through it must not declare a foreign `sourceAddress`. Serving it
 * properly means generalising the address kind from "bound to chat C" to "relays authenticated
 * humans from source S", which is a contract change and is tracked as such.
 */

export interface RelayAddress {
  readonly threadId: string;
  readonly handleId: string;
}

export interface RelayAddressProvisionerDeps {
  readonly messaging: {
    issueConnectorBindingHandle(input: {
      pluginInstanceId: string;
      threadId: string;
      userId: string;
      scope: { canSend: boolean; canSubscribe: boolean };
      connectorId: string;
      externalChatId: string;
    }): Promise<{ handleId: string }>;
  };
  readonly threads: {
    create(userId: string, title: string): Promise<{ id: string }> | { id: string };
  };
  /**
   * Where the package's choice of thread is remembered. It has to outlive the process: a second
   * activation that creates a second thread splits the package's history in two, and the user
   * finds yesterday's conversation missing rather than moved.
   */
  readonly store: {
    getSystemThreadId(pluginInstanceId: string): Promise<string | null>;
    setSystemThreadId(pluginInstanceId: string, threadId: string): Promise<void>;
  };
  readonly defaultUserId: string;
  /** Human label for the source; defaults to the raw source id. */
  readonly label?: (sourceId: string) => string;
}

export interface ProvisionInput {
  readonly pluginInstanceId: string;
  /** The external system this package relays from — a connector id, or anything else. */
  readonly sourceId: string;
}

/** The synthetic conversation standing for a package's own system thread. */
function systemConversationId(pluginInstanceId: string): string {
  return `system:${pluginInstanceId}`;
}

export class RelayAddressProvisioner {
  private readonly deps: RelayAddressProvisionerDeps;

  constructor(deps: RelayAddressProvisionerDeps) {
    this.deps = deps;
  }

  async provision(input: ProvisionInput): Promise<RelayAddress> {
    const threadId = await this.resolveSystemThread(input);
    const { handleId } = await this.deps.messaging.issueConnectorBindingHandle({
      pluginInstanceId: input.pluginInstanceId,
      threadId,
      userId: this.deps.defaultUserId,
      scope: { canSend: true, canSubscribe: false },
      connectorId: input.sourceId,
      externalChatId: systemConversationId(input.pluginInstanceId),
    });
    return { threadId, handleId };
  }

  private async resolveSystemThread(input: ProvisionInput): Promise<string> {
    const existing = await this.deps.store.getSystemThreadId(input.pluginInstanceId);
    if (existing) return existing;

    const label = this.deps.label?.(input.sourceId) ?? input.sourceId;
    const thread = await this.deps.threads.create(this.deps.defaultUserId, `${label} · 系统`);
    await this.deps.store.setSystemThreadId(input.pluginInstanceId, thread.id);
    return thread.id;
  }
}

export function createRelayAddressProvisioner(deps: RelayAddressProvisionerDeps): RelayAddressProvisioner {
  return new RelayAddressProvisioner(deps);
}
