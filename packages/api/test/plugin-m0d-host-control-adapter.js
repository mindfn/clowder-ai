import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { CAPABILITY_TABLE } from '@clowder-ai/plugin-contract';

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

  constructor(behaviorCase) {
    this.behaviorCase = behaviorCase;
    this.pluginInstanceId = behaviorCase.given.caller.pluginInstanceId;
  }

  async setup(given) {
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
}
