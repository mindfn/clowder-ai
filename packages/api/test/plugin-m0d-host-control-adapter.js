import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { CAPABILITY_TABLE } from '@clowder-ai/plugin-contract';

import {
  createExternalRuntimeHarness,
  EXTERNAL_INSTANCE_ID,
  externalManifest,
} from './plugin-external-runtime-helpers.js';
import { actualInstanceId, prepareFixture } from './plugin-m0d-fixture-setup.js';
import { createMessagingOwner } from './plugin-m0d-messaging-owner.js';
import {
  ObservedNodeProcessAdapter,
  publishAcceptanceArchive,
  stageAcceptancePackage,
} from './plugin-m0d-process-fixture.js';

const FIXTURE_PLUGIN_ID = 'dev.clowder.m0d-control';
const FIXTURE_PACKAGE_DIGEST = `sha512-${createHash('sha512').update('m0d-host-control').digest('base64')}`;

function canonicalCapabilities(values) {
  const requested = new Set(values);
  return Object.values(CAPABILITY_TABLE)
    .flat()
    .filter((capability) => requested.has(capability));
}

function requestedCapabilities(given) {
  const requested = new Set(given.grants);
  const grantState = given.state.grantState;
  if (Array.isArray(grantState?.presetCapabilities)) {
    for (const capability of grantState.presetCapabilities) requested.add(capability);
  } else if (grantState && typeof grantState === 'object') {
    for (const [capability, state] of Object.entries(grantState)) {
      if (state?.visible === true) requested.add(capability);
    }
  }
  return canonicalCapabilities(requested);
}

function fixtureManifest(contractVersion, capabilities) {
  return {
    pluginId: FIXTURE_PLUGIN_ID,
    version: '1.0.0',
    contractVersion,
    name: 'M0-D Host control fixture',
    features: [{ id: 'messaging', name: 'Messaging', resources: [], capabilities }],
    runtime: { transport: 'builtin' },
  };
}

function error(errorCode) {
  return { status: 'error', errorCode };
}

export function contractPermissionEntries() {
  return Object.entries(CAPABILITY_TABLE).flatMap(([layer, capabilities]) =>
    capabilities.map((capability) => ({ capability, layer, firstPartyPreset: layer === 'L1' })),
  );
}

export class HostControlBehaviorAdapter {
  #expectedGrantRevision;
  #permissionMatrix;
  #roots = [];

  constructor(behaviorCase) {
    this.behaviorCase = behaviorCase;
    this.pluginInstanceId = behaviorCase.given.caller.pluginInstanceId;
  }

  async setup(given) {
    if (this.behaviorCase.when.operation === 'deliverOnMessage') {
      await this.#setupDelivery(given);
      return;
    }
    if (this.behaviorCase.when.operation === 'deleteReplayEvents') {
      await this.#setupReplay(given);
      return;
    }
    const { HostInventoryControlPlane, MemoryPluginInventoryStore, PLUGIN_CONTRACT_VERSION } = await import(
      '../dist/domains/plugin/host-inventory/index.js'
    );
    this.store = new MemoryPluginInventoryStore();
    this.controlPlane = new HostInventoryControlPlane(this.store, {
      createInstanceId: () => this.pluginInstanceId,
      now: () => 10,
    });
    this.rawHostErrorCode = undefined;
    this.#permissionMatrix = undefined;

    const requested = requestedCapabilities(given);
    if (requested.length === 0) return;
    const manifest = fixtureManifest(PLUGIN_CONTRACT_VERSION, requested);
    await this.controlPlane.installPackage({
      manifest,
      computedPackageDigest: FIXTURE_PACKAGE_DIGEST,
      expectedPackageDigest: FIXTURE_PACKAGE_DIGEST,
      packagePluginId: manifest.pluginId,
      effectiveGrants: given.grants,
    });
    this.#expectedGrantRevision = 1;
  }

  async #setupReplay(given) {
    this.messagingOwner = await createMessagingOwner(500);
    await prepareFixture(this.messagingOwner, this.behaviorCase, 500);
    const callerId = given.caller.pluginInstanceId;
    this.pluginInstanceId = actualInstanceId(callerId, callerId);
    this.rawHostErrorCode = undefined;
    this.replayEvents = structuredClone(given.state.replayEvents ?? []);
  }

  async #setupDelivery(given) {
    const packageRoot = await mkdtemp(join(resolve('.'), '.m0d-host-control-'));
    const hostRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-m0d-delivery-'));
    this.#roots.push(packageRoot, hostRoot);
    const packagesRoot = join(packageRoot, 'packages');
    const manifest = externalManifest();
    manifest.features[0].capabilities = [...new Set([...manifest.features[0].capabilities, 'onMessage'])];
    const runtime = await import('../dist/domains/plugin/external-runtime/index.js');
    const { archivePath, packageDigest } = await stageAcceptancePackage(packageRoot, this.behaviorCase, manifest);
    await mkdir(packagesRoot, { recursive: true });
    await publishAcceptanceArchive(packagesRoot, archivePath, packageDigest, runtime.packageDirectoryName);
    const harness = await createExternalRuntimeHarness({
      rootDir: hostRoot,
      manifest,
      effectiveGrants: given.grants,
      packageDigest,
    });
    this.store = harness.inventory;
    this.pluginInstanceId = EXTERNAL_INSTANCE_ID;
    this.rawHostErrorCode = undefined;
    this.processes = new ObservedNodeProcessAdapter(new runtime.NodeExternalPluginProcessAdapter(100));
    this.supervisor = new runtime.ExternalPluginRuntimeSupervisor({
      inventory: harness.inventory,
      broker: harness.broker,
      packages: new runtime.FilesystemVerifiedPluginPackageLocator(packagesRoot),
      processes: this.processes,
      handshakeTimeoutMs: 2_000,
    });
    if (given.grants.includes('onMessage')) await this.supervisor.start(this.pluginInstanceId);
  }

  async #grantProjection(capability) {
    const snapshot = await this.store.snapshot();
    const grant = snapshot.grants.find((candidate) => candidate.pluginInstanceId === this.pluginInstanceId);
    if (!grant) return undefined;
    return {
      capability,
      visible: grant.requestedCapabilities.includes(capability),
      granted: grant.effectiveGrants.includes(capability),
    };
  }

  async observe(target) {
    if (this.behaviorCase.when.operation === 'deleteReplayEvents') {
      if (target === 'messages') return structuredClone(await this.messagingOwner.messageStore.getRecent(2_000));
      if (target === 'replay_events') return this.#observeReplayEvents();
      throw new Error(`unsupported replay-retention observation target ${target}`);
    }
    if (this.behaviorCase.when.operation === 'deliverOnMessage') {
      if (target === 'messages' || target === 'output_events') return [];
      throw new Error(`unsupported Host-delivery observation target ${target}`);
    }
    if (target === 'permission_matrix') return structuredClone(this.#permissionMatrix);
    if (target !== 'grant_state') throw new Error(`unsupported Host-control observation target ${target}`);
    if (this.behaviorCase.when.operation === 'revokeGrant') {
      return this.#grantProjection(this.behaviorCase.when.input.capability);
    }
    const snapshot = await this.store.snapshot();
    return structuredClone(snapshot.grants.find((grant) => grant.pluginInstanceId === this.pluginInstanceId));
  }

  async execute(operation) {
    this.rawHostErrorCode = undefined;
    switch (operation.operation) {
      case 'applyGrantPreset':
        return this.#applyGrantPreset(operation.input);
      case 'revokeGrant':
        return this.#revokeGrant(operation.input);
      case 'checkPermissionMatrix':
        return this.#checkPermissionMatrix(operation.input);
      case 'deliverOnMessage':
        return this.#deliverOnMessage(operation.input);
      case 'deleteReplayEvents':
        return this.#deleteReplayEvents(operation.input);
      default:
        throw new Error(`unsupported Host-control operation ${operation.operation}`);
    }
  }

  async #applyGrantPreset(input) {
    if (input.presetKind !== 'first_party') return error('VALIDATION');
    const l1 = new Set(CAPABILITY_TABLE.L1);
    if (input.capabilities.some((capability) => !l1.has(capability))) return error('PERMISSION');
    const snapshot = await this.store.snapshot();
    const grant = snapshot.grants.find((candidate) => candidate.pluginInstanceId === this.pluginInstanceId);
    if (!grant || input.capabilities.some((capability) => !grant.effectiveGrants.includes(capability))) {
      return error('PERMISSION');
    }
    return { status: 'success' };
  }

  async #revokeGrant(input) {
    try {
      await this.controlPlane.revokeGrant({
        pluginInstanceId: this.pluginInstanceId,
        capability: input.capability,
        expectedGrantRevision: this.#expectedGrantRevision,
      });
      return { status: 'success' };
    } catch (caught) {
      if (caught?.name !== 'PluginInventoryError') throw caught;
      this.rawHostErrorCode = caught.code;
      return error('PERMISSION');
    }
  }

  #checkPermissionMatrix(input) {
    const expected = contractPermissionEntries();
    const unique = new Set(input.entries.map(({ capability }) => capability));
    if (
      input.entries.length !== expected.length ||
      unique.size !== expected.length ||
      !expected.every((entry) => input.entries.some((candidate) => isDeepStrictEqual(candidate, entry)))
    ) {
      return error('VALIDATION');
    }
    this.#permissionMatrix = {
      complete: true,
      firstPartyPresetLayers: [
        ...new Set(expected.filter((entry) => entry.firstPartyPreset).map((entry) => entry.layer)),
      ],
      defaultWhisperTargets: [],
    };
    return { status: 'success' };
  }

  async #deliverOnMessage(input) {
    if (this.processes.specs.length === 0) {
      const snapshot = await this.store.snapshot();
      const grant = snapshot.grants.find((candidate) => candidate.pluginInstanceId === this.pluginInstanceId);
      if (!grant?.effectiveGrants.includes('onMessage')) {
        this.rawHostErrorCode = 'CAPABILITY_DENIED';
        return error('PERMISSION');
      }
    }
    try {
      await this.supervisor.deliver(this.pluginInstanceId, {
        deliveryId: 'm0d-denied-delivery',
        threadHandle: { kind: 'thread_handle', handle: input.threadHandle },
        envelope: input.envelope,
      });
      return { status: 'success' };
    } catch (caught) {
      if (caught?.code !== 'DELIVERY_REJECTED') throw caught;
      this.rawHostErrorCode = caught.cause?.code ?? caught.code;
      return error('PERMISSION');
    }
  }

  async #observeReplayEvents() {
    const callerId = this.behaviorCase.given.caller.pluginInstanceId;
    const retained = [];
    for (const replayEvent of this.replayEvents) {
      const handle = Object.values(this.behaviorCase.given.handles).find(
        (candidate) => candidate.kind === 'subscription' && candidate.subscriptionId === replayEvent.subscriptionId,
      );
      if (!handle) throw new Error(`replay event ${replayEvent.eventId} omitted its subscription handle`);
      const ownerId = actualInstanceId(handle.ownerPluginInstanceId, callerId);
      // eslint-disable-next-line no-await-in-loop
      const cursor = await this.messagingOwner.cursorStore.get(ownerId, handle.subscriptionId);
      if (!cursor || replayEvent.sequence > cursor.replayFloorSequence) retained.push(replayEvent);
    }
    return structuredClone(retained);
  }

  async #deleteReplayEvents(input) {
    try {
      await this.messagingOwner.stream.deleteReplayEvents(
        { pluginInstanceId: this.pluginInstanceId },
        input.subscriptionId,
        input.throughSequence,
      );
      return { status: 'success' };
    } catch (caught) {
      if (caught?.name !== 'MessagingError') throw caught;
      this.rawHostErrorCode = caught.code;
      return error(caught.code);
    }
  }

  async close() {
    if (this.supervisor) await this.supervisor.stop(this.pluginInstanceId, 'acceptance_complete');
    for (const root of this.#roots) await rm(root, { recursive: true, force: true });
    this.#roots = [];
  }
}
