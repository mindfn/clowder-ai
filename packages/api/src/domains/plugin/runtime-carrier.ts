import type { M0CDeliverInput, M0CDeliverResult } from '@clowder-ai/plugin-contract';

import type { PluginRuntimeLifecyclePort } from './external-plugin-lifecycle-types.js';
import { ExternalPluginRuntimeError } from './external-runtime/types.js';
import type { PluginInventoryStore } from './host-inventory/ports.js';
import type { PluginInstanceRecord, PluginPackageRecord } from './host-inventory/types.js';

/**
 * F202 Train C1 — the Host's single runtime-carrier boundary.
 *
 * A *carrier* is how an admitted package runs: inside the Host process, or as a child
 * process speaking the broker protocol. The C1 terminal contract makes that an
 * implementation detail the package declares (clause 1), so callers ask for a lifecycle
 * action on an instance and never choose a carrier (clause 2), and no selection rule may
 * name a specific pluginId (clause 6) — a bundled runtime declares which package it
 * implements instead.
 */
export interface PluginRuntimeAdmission {
  readonly instance: PluginInstanceRecord;
  readonly packageRecord: PluginPackageRecord;
}

export interface PluginRuntimeCarrier {
  /** Derived from the admitted package alone. Carrier selection has no other input. */
  claims(admission: PluginRuntimeAdmission): boolean;
  start(pluginInstanceId: string): Promise<unknown>;
  stop(pluginInstanceId: string, reason: string): Promise<void>;
  stopAll(reason: string): Promise<void>;
  /** Carriers that survive a Host restart report how many sessions they recovered. */
  recoverAfterRestart?(): Promise<number>;
  /** Only carriers with a Host→package delivery surface implement this. */
  deliver?(pluginInstanceId: string, input: M0CDeliverInput): Promise<M0CDeliverResult>;
}

export class PluginRuntimeCarrierRouter implements PluginRuntimeLifecyclePort {
  readonly #carriers: PluginRuntimeCarrier[] = [];

  constructor(private readonly inventory: Pick<PluginInventoryStore, 'snapshot'>) {}

  /**
   * Registration order is selection order — the first claim wins, so a carrier that
   * claims a narrower set of manifests must be registered before a broader one.
   * Registration is open because some carriers are only assembled once the Plugin
   * Manager exists; selection stays closed to this class either way.
   */
  register(carrier: PluginRuntimeCarrier): void {
    this.#carriers.push(carrier);
  }

  async start(pluginInstanceId: string): Promise<unknown> {
    const carrier = await this.#select(pluginInstanceId);
    return carrier.start(pluginInstanceId);
  }

  async stop(pluginInstanceId: string, reason = 'host_stop'): Promise<void> {
    const carrier = await this.#select(pluginInstanceId);
    await carrier.stop(pluginInstanceId, reason);
  }

  async stopAll(reason = 'host_shutdown'): Promise<void> {
    const settled = await Promise.allSettled(this.#carriers.map((carrier) => carrier.stopAll(reason)));
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  async recoverAfterRestart(): Promise<number> {
    let recovered = 0;
    for (const carrier of this.#carriers) {
      recovered += (await carrier.recoverAfterRestart?.()) ?? 0;
    }
    return recovered;
  }

  async deliver(pluginInstanceId: string, input: M0CDeliverInput): Promise<M0CDeliverResult> {
    const carrier = await this.#select(pluginInstanceId);
    if (!carrier.deliver) {
      throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${pluginInstanceId} has no Host delivery surface`);
    }
    return carrier.deliver(pluginInstanceId, input);
  }

  async #select(pluginInstanceId: string): Promise<PluginRuntimeCarrier> {
    const admission = await this.#admission(pluginInstanceId);
    const carrier = this.#carriers.find((candidate) => candidate.claims(admission));
    if (!carrier) {
      throw new ExternalPluginRuntimeError(
        'UNSUPPORTED_TRANSPORT',
        `no runtime carrier implements ${admission.packageRecord.pluginId}`,
      );
    }
    return carrier;
  }

  /**
   * Selection authority only. Each carrier still enforces its own activation, config
   * and revision fences before it touches a runtime — this resolves *which* carrier
   * owns the instance, not *whether* the instance may run.
   */
  async #admission(pluginInstanceId: string): Promise<PluginRuntimeAdmission> {
    const snapshot = await this.inventory.snapshot();
    const instance = snapshot.instances.find((candidate) => candidate.pluginInstanceId === pluginInstanceId);
    const packageRecord = instance
      ? snapshot.packages.find((candidate) => candidate.packageDigest === instance.packageDigest)
      : undefined;
    if (!instance || !packageRecord) {
      throw new ExternalPluginRuntimeError(
        'INSTANCE_NOT_RUNNABLE',
        `${pluginInstanceId} is not a runnable plugin instance`,
      );
    }
    return { instance, packageRecord };
  }
}
