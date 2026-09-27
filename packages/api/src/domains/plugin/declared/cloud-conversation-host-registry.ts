import type { CloudConversationHostContribution } from '@clowder-ai/plugin-contract';
import type { PluginInvocationOutcome } from '../carrier/host-invocation.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';

export type CloudConversationProvider = CloudConversationHostContribution['provider'];

export interface CloudConversationHostRegistration {
  readonly provider: CloudConversationProvider;
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly contribution: CloudConversationHostContribution;
  /** Calls one of the package's actions; a failure says whether the package could have acted on it. */
  attempt(method: string, params: unknown): Promise<PluginInvocationOutcome>;
}

/**
 * One activation's hold on its provider. A lease is never reused: a package that is stopped and
 * started again (same instance or not) gets a new one, with a higher generation.
 */
export interface CloudConversationHostLease extends CloudConversationHostRegistration {
  readonly generation: number;
}

/**
 * F202 W2-3 h3b — which enabled package hosts each cloud conversation provider (contract
 * `cloud-conversation-host`; one provider accepts at most one enabled package).
 *
 * The declared runtime contributions register a package as the last step of its activation and
 * unregister it before its carrier stops, so the registry holds exactly the packages that are
 * enabled and running. The Host's outbound adapter and reply poller read it; they never keep a
 * package of their own. Listeners are told after every change and must not throw.
 */
export class CloudConversationHostRegistry {
  readonly #current = new Map<CloudConversationProvider, CloudConversationHostLease>();
  readonly #listeners = new Set<() => void>();
  #generation = 0;

  /** Refuses a second package for a provider that already has one: the activation fails closed. */
  register(registration: CloudConversationHostRegistration): CloudConversationHostLease {
    const holder = this.#current.get(registration.provider);
    if (holder) {
      throw new ExternalPluginRuntimeError(
        'RUNTIME_ALREADY_ACTIVE',
        `${registration.pluginId} cannot host ${registration.provider} conversations: ${holder.pluginId} already does`,
      );
    }
    this.#generation += 1;
    const lease: CloudConversationHostLease = Object.freeze({ ...registration, generation: this.#generation });
    this.#current.set(registration.provider, lease);
    this.#notify();
    return lease;
  }

  /** Removes the provider's holder only if it is still this very lease. */
  unregister(lease: CloudConversationHostLease): void {
    if (!this.isCurrent(lease)) return;
    this.#current.delete(lease.provider);
    this.#notify();
  }

  current(provider: CloudConversationProvider): CloudConversationHostLease | undefined {
    return this.#current.get(provider);
  }

  isCurrent(lease: CloudConversationHostLease): boolean {
    return this.#current.get(lease.provider) === lease;
  }

  /** Returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
