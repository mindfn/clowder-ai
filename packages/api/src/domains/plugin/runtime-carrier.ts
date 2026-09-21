import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  type M0CDeliverInput,
  type M0CDeliverResult,
  validateMessagingRowInput,
  validateMessagingRowResult,
} from '@clowder-ai/plugin-contract';

import { readCapabilitiesConfig, withCapabilityLock } from '../../config/capabilities/capability-orchestrator.js';
import { readMountRules } from '../../config/mount/mount-rules-store.js';
import { addSkill, removeSkill } from '../../skills/skill-manage.js';
import type { PluginRuntimeLifecyclePort } from './external-plugin-lifecycle-types.js';
import {
  ExternalPluginRuntimeError,
  type VerifiedPluginPackage,
  type VerifiedPluginPackageLocator,
} from './external-runtime/types.js';
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
  /** Only carriers with a Host→package invocation surface implement this. */
  invoke?(pluginInstanceId: string, method: string, params: unknown): Promise<unknown>;
}

export class PluginRuntimeCarrierRouter implements PluginRuntimeLifecyclePort {
  readonly #carriers: PluginRuntimeCarrier[] = [];
  readonly #resourcePackages = new Map<
    string,
    { readonly pluginId: string; readonly located: VerifiedPluginPackage }
  >();

  constructor(
    private readonly inventory: Pick<PluginInventoryStore, 'snapshot'>,
    private readonly resources?: {
      readonly projectRoot: string;
      readonly packages: VerifiedPluginPackageLocator;
    },
  ) {}

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
    const admission = await this.#admission(pluginInstanceId);
    const carrier = this.#selectAdmission(admission);
    const result = await carrier.start(pluginInstanceId);
    try {
      await this.#activateDeclaredSkills(admission);
      return result;
    } catch (error) {
      await this.#rollbackStartedRuntime(error, carrier, admission);
    }
  }

  async stop(pluginInstanceId: string, reason = 'host_stop'): Promise<void> {
    const admission = await this.#admission(pluginInstanceId);
    const carrier = this.#selectAdmission(admission);
    await carrier.stop(pluginInstanceId, reason);
    try {
      await this.#removePersistedSkills(admission.packageRecord.pluginId);
    } finally {
      await this.#releaseResourcePackage(pluginInstanceId);
    }
  }

  async stopAll(reason = 'host_shutdown'): Promise<void> {
    const carrierResults = await Promise.allSettled(this.#carriers.map((carrier) => carrier.stopAll(reason)));
    const carrierFailure = carrierResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (carrierFailure) throw carrierFailure.reason;
    const resourceResults = await Promise.allSettled(
      [...this.#resourcePackages].map(async ([pluginInstanceId, resource]) => {
        try {
          await this.#removePersistedSkills(resource.pluginId);
        } finally {
          await this.#releaseResourcePackage(pluginInstanceId);
        }
      }),
    );
    const failure = resourceResults.find((result): result is PromiseRejectedResult => result.status === 'rejected');
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
    const method = 'host.messaging.deliver';
    const validatedInput = validateMessagingRowInput(method, input);
    if (!validatedInput.valid) {
      throw new ExternalPluginRuntimeError(
        'PROTOCOL_VIOLATION',
        `${pluginInstanceId} received invalid Host delivery input`,
      );
    }
    const result = await this.invoke(pluginInstanceId, method, validatedInput.value);
    const validatedResult = validateMessagingRowResult(method, result);
    if (!validatedResult.valid || validatedResult.value.deliveryId !== validatedInput.value.deliveryId) {
      throw new ExternalPluginRuntimeError(
        'PROTOCOL_VIOLATION',
        `${pluginInstanceId} returned an invalid delivery receipt`,
      );
    }
    return validatedResult.value;
  }

  async invoke(pluginInstanceId: string, method: string, params: unknown): Promise<unknown> {
    const carrier = await this.#select(pluginInstanceId);
    if (!carrier.invoke) {
      throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${pluginInstanceId} has no Host invocation surface`);
    }
    return carrier.invoke(pluginInstanceId, method, params);
  }

  async #select(pluginInstanceId: string): Promise<PluginRuntimeCarrier> {
    const admission = await this.#admission(pluginInstanceId);
    return this.#selectAdmission(admission);
  }

  #selectAdmission(admission: PluginRuntimeAdmission): PluginRuntimeCarrier {
    const carrier = this.#carriers.find((candidate) => candidate.claims(admission));
    if (!carrier) {
      throw new ExternalPluginRuntimeError(
        'UNSUPPORTED_TRANSPORT',
        `no runtime carrier implements ${admission.packageRecord.pluginId}`,
      );
    }
    return carrier;
  }

  async #activateDeclaredSkills(admission: PluginRuntimeAdmission): Promise<void> {
    const skills = (admission.packageRecord.manifest.contributions ?? []).filter(
      (contribution) => contribution.type === 'skill',
    );
    if (skills.length === 0) return;
    if (!this.resources) {
      throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host static-resource activation is unavailable');
    }
    const resources = this.resources;
    const located = await resources.packages.resolveInstalledPackage(admission.packageRecord.packageDigest);
    this.#resourcePackages.set(admission.instance.pluginInstanceId, {
      pluginId: admission.packageRecord.pluginId,
      located,
    });
    if (!isDeepStrictEqual(located.manifest, admission.packageRecord.manifest)) {
      throw new ExternalPluginRuntimeError(
        'PACKAGE_AUTHORITY_MISMATCH',
        'located package manifest differs from the admitted package record',
      );
    }
    await located.verifyIntegrity();
    const mountRules = await readMountRules(resources.projectRoot, resources.projectRoot);
    await withCapabilityLock(resources.projectRoot, async () => {
      for (const skill of skills) {
        const skillSourceDir = await resolvePackageSkillDirectory(located.rootDir, skill.path);
        const skillName = basename(skillSourceDir);
        const skillsSource = dirname(skillSourceDir);
        const result = await addSkill(resources.projectRoot, skillName, skillsSource, {
          mountRules,
          pluginId: admission.packageRecord.pluginId,
          capabilityId: skillName,
          skillsSource: relative(resources.projectRoot, skillsSource),
        });
        if (result.mounted.length === 0 && result.conflicts.length > 0) {
          throw new Error(
            `All skill mount points conflict for plugin skill '${skillName}': ${result.conflicts
              .map((conflict) => conflict.path)
              .join(', ')}`,
          );
        }
      }
    });
  }

  async #rollbackStartedRuntime(
    startError: unknown,
    carrier: PluginRuntimeCarrier,
    admission: PluginRuntimeAdmission,
  ): Promise<never> {
    const rollbackErrors: unknown[] = [];
    try {
      await carrier.stop(admission.instance.pluginInstanceId, 'start_failed');
    } catch (error) {
      rollbackErrors.push(error);
    }
    try {
      await this.#removePersistedSkills(admission.packageRecord.pluginId);
    } catch (error) {
      rollbackErrors.push(error);
    }
    try {
      await this.#releaseResourcePackage(admission.instance.pluginInstanceId);
    } catch (error) {
      rollbackErrors.push(error);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [startError, ...rollbackErrors],
        `${admission.packageRecord.pluginId} startup rollback failed`,
      );
    }
    throw startError;
  }

  async #removePersistedSkills(pluginId: string): Promise<void> {
    if (!this.resources) return;
    const resources = this.resources;
    const mountRules = await readMountRules(resources.projectRoot, resources.projectRoot);
    await withCapabilityLock(resources.projectRoot, async () => {
      const config = await readCapabilitiesConfig(resources.projectRoot);
      const ownedSkills =
        config?.capabilities.filter((capability) => capability.type === 'skill' && capability.pluginId === pluginId) ??
        [];
      const removalErrors: unknown[] = [];
      for (const skill of ownedSkills) {
        try {
          await removeSkill(resources.projectRoot, skill.id, {
            mountRules,
            pluginId,
            capabilityId: skill.id,
            ...(skill.skillsSource ? { skillsSource: resolve(resources.projectRoot, skill.skillsSource) } : {}),
          });
        } catch (error) {
          removalErrors.push(error);
        }
      }
      if (removalErrors.length > 0) {
        throw new AggregateError(removalErrors, `Failed to remove all persisted skills for ${pluginId}`);
      }
    });
  }

  async #releaseResourcePackage(pluginInstanceId: string): Promise<void> {
    const resource = this.#resourcePackages.get(pluginInstanceId);
    if (!resource) return;
    this.#resourcePackages.delete(pluginInstanceId);
    await resource.located.release();
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

async function resolvePackageSkillDirectory(packageRoot: string, declaredPath: string): Promise<string> {
  const realPackageRoot = await realpath(packageRoot);
  const skillSourceDir = await realpath(resolve(realPackageRoot, declaredPath));
  const relativePath = relative(realPackageRoot, skillSourceDir);
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Skill resource escapes the verified package root: ${declaredPath}`);
  }
  const skillStat = await stat(skillSourceDir);
  if (!skillStat.isDirectory()) throw new Error(`Skill resource must be a directory: ${declaredPath}`);
  const skillManifestStat = await stat(join(skillSourceDir, 'SKILL.md')).catch(() => undefined);
  if (!skillManifestStat?.isFile()) {
    throw new Error(`Skill resource directory must contain SKILL.md: ${declaredPath}`);
  }
  return skillSourceDir;
}
