/**
 * F202 Train C1 — shared fixture for the gap-E (durable connector checkpoint) gate files.
 *
 * Gap E is a PUBLIC-WIRE boundary blocker, not narrow wiring. Verified against the installed
 * @clowder-ai/plugin-contract@0.1.0-beta.15: WIRE_METHOD_COUNT === 13 and
 * isWireMethod('plugin.state.get'|'plugin.state.set') === false. Those two names exist only in
 * the L0 capability enum and design prose; Core has no handler, store or composition path.
 *
 * Telegram long polling and WeCom Bot / XiaoYi WebSocket resume need a restart-safe provider
 * cursor. The three candidate substitutes are all disqualified at the interface level:
 *   - messaging settlement ledger: LEDGER_RETENTION_MS = 7d with a documented at-least-once
 *     boundary (ledger.ts:13,20) vs the TTL=0 this requires; keyed by the request's own
 *     idempotencyKey, with no read() and no revision CAS.
 *   - subscription cursor: tracks the HOST's output event log, advance-only (a stale advance is
 *     silently absorbed - precisely the rewind this must refuse), and dies with the handle.
 *   - inventory snapshot: a Host-authored lifecycle projection with no plugin-writable region.
 *
 * WHY THROUGH THE BROKER + AN INJECTED AUTHORITY (fifth-round review P1): asserting on
 * `runtime.messaging.connectorCheckpoints` lets an internal method satisfy the gate while the
 * package still cannot reach it, and sharing only `projectRoot` between the before/after
 * compositions pressures the implementation toward a package-local file store. Every case calls
 * through an authenticated Broker connection and pins durability to an explicitly isolated
 * authority shared by both compositions.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { isWireMethod, WIRE_METHOD_REGISTRY } from '@clowder-ai/plugin-contract';
import {
  authenticatedConnection,
  BASE_GRANTS,
  CHECKPOINT_COMMIT,
  CHECKPOINT_READ,
  checkpointGrants,
  hostAcceptedDelivery,
  installConnectorInstance,
  productionComposition,
} from './f202-c1-production-composition-helpers.js';

export const DECLARED_KEY = 'provider-cursor';

const GAP_E_WIRE_ABSENT =
  'C1 gap E (boundary blocker): the 13-row wire registry has no checkpoint row. ' +
  'plugin.state.get/set are RESERVED L0 capability NAMES ONLY - isWireMethod() returns false, ' +
  'Core registers no handler, and no composition owns a durable checkpoint authority.';

/**
 * An explicitly isolated durable authority shared across compositions, so "survives restart"
 * cannot be satisfied by composition-local memory, a projectRoot file, or the test re-reading
 * its own input. It counts commits because a replay case that only compares return values
 * (fifth-round shape) still admits an implementation that writes twice and returns the first
 * result — sixth-round review P1.
 */
export class IsolatedCheckpointAuthority {
  constructor() {
    this.records = new Map();
    this.commits = [];
  }

  slot(pluginInstanceId, key) {
    return `${pluginInstanceId}::${key}`;
  }

  read(pluginInstanceId, key) {
    return this.records.get(this.slot(pluginInstanceId, key)) ?? null;
  }

  commit(pluginInstanceId, key, value, revision) {
    this.commits.push({ pluginInstanceId, key, revision });
    this.records.set(this.slot(pluginInstanceId, key), { value, revision });
    return { revision };
  }
}

export async function checkpointFixture(prefix, overrides = {}) {
  const projectRoot = overrides.projectRoot ?? (await mkdtemp(resolve(tmpdir(), prefix)));
  await mkdir(resolve(projectRoot, 'dist'), { recursive: true });
  await writeFile(resolve(projectRoot, 'dist/plugin.js'), '// fixture entrypoint\n', 'utf8');
  const { runtime } = await productionComposition(projectRoot, { checkpointStore: overrides.checkpointStore });
  const effectiveGrants = overrides.effectiveGrants ?? [...BASE_GRANTS, ...checkpointGrants()];
  const pluginInstanceId =
    overrides.pluginInstanceId ?? (await installConnectorInstance(runtime, projectRoot, { effectiveGrants }));
  const connection = await authenticatedConnection(runtime, pluginInstanceId);
  return { projectRoot, runtime, pluginInstanceId, connection };
}

/**
 * A fixture whose settlement precondition is already satisfied (seventh-round review P1).
 *
 * Case 18 makes "no settlementRef at all" a refusal. Any negative that omits the field therefore
 * gets rejected by the SETTLEMENT rule and never exercises its own rule - a declared-key, size or
 * content negative would pass against an implementation that enforces none of them. These cases
 * must carry a reference the Host actually minted, so settlement is the one reason left standing.
 */
export async function settledCheckpointFixture(prefix, overrides = {}) {
  const fixture = await checkpointFixture(prefix, overrides);
  const receipt = await hostAcceptedDelivery(
    fixture.runtime,
    fixture.connection,
    fixture.pluginInstanceId,
    `${prefix}settle`,
  );
  return { ...fixture, settlementRef: { messageId: receipt.messageId } };
}

/**
 * The public-surface precondition every gap-E case shares. Fails first, and for one reason.
 *
 * The grant assertion is the anti-escape half (sixth-round review P1): the required grant is
 * taken from the row itself (control-plane.ts:322 feeds `row.grant` into currentCallContext), so
 * hanging the checkpoint rows off a grant the connector already holds for messaging would
 * silently satisfy every case here while giving checkpoints no permission isolation at all.
 */
export function assertCheckpointRowsReachable(runtime) {
  assert.ok(isWireMethod(CHECKPOINT_COMMIT), GAP_E_WIRE_ABSENT);
  assert.ok(isWireMethod(CHECKPOINT_READ), GAP_E_WIRE_ABSENT);
  // Seventh-round review P1: excluding only BASE_GRANTS still lets the rows hang off ANY other
  // pre-existing grant, which is no isolation at all. The frozen requirement is a DEDICATED
  // state-class grant - derived from the registry, so it binds whatever §7.2 item 5 signs without
  // this gate inventing a name. Only the SPELLING stays provisional; the requirement does not.
  const incumbentGrants = new Set(
    Object.entries(WIRE_METHOD_REGISTRY)
      .filter(([method]) => method !== CHECKPOINT_COMMIT && method !== CHECKPOINT_READ)
      .map(([, row]) => row.grant),
  );
  for (const method of [CHECKPOINT_COMMIT, CHECKPOINT_READ]) {
    const grant = WIRE_METHOD_REGISTRY[method].grant;
    assert.ok(
      !incumbentGrants.has(grant),
      `${method} must be gated by a state-class grant of its own; reusing the incumbent grant ` +
        `'${grant}' (already held for another row) gives checkpoints no permission isolation`,
    );
  }
  const registered = runtime.broker.options.methods.map((handler) => handler.method);
  assert.ok(
    registered.includes(CHECKPOINT_COMMIT) && registered.includes(CHECKPOINT_READ),
    'the SHIPPED composition must register Host handlers for both rows; a contract row with no ' +
      'Core handler is still unreachable for a migrated package',
  );
}

/** Post-signature these must be scope/settlement refusals, never a missing-plumbing error. */
export function assertNotPlumbingFailure(error) {
  assert.ok(
    !['METHOD_NOT_READY', 'METHOD_NOT_REGISTERED', 'INSTANCE_NOT_READY'].includes(error?.code),
    `refusal must come from the checkpoint contract, not from missing plumbing (${error?.code})`,
  );
  return true;
}
