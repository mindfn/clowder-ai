import type {
  BeginConnectorCutoverInput,
  BeginConnectorRollbackInput,
  BeginConnectorShadowInput,
  ConnectorMigrationRecord,
  ConnectorMigrationStore,
  ConnectorMigrationTransaction,
  MarkConnectorHostActiveInput,
  MarkConnectorLegacyRestoredInput,
  MarkConnectorShadowReadyInput,
  ObserveConnectorInput,
  ReconcileConnectorObservationInput,
} from './types.js';
import { ConnectorMigrationError } from './types.js';

const CONNECTOR_ID = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/u;
const SHA256_SRI = /^sha256-[A-Za-z0-9+/]{43}=$/u;
const SHA512_SRI = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const INSTANCE_ID = /^pi_[A-Za-z0-9._:-]{1,252}$/u;

export interface ConnectorMigrationControlPlaneOptions {
  readonly now?: () => number;
}

function invalidInput(condition: boolean, message: string): void {
  if (!condition) throw new ConnectorMigrationError('INVALID_INPUT', message);
}

function canonicalSri(value: string, pattern: RegExp, bytes: number): boolean {
  if (!pattern.test(value)) return false;
  const encoded = value.slice(value.indexOf('-') + 1);
  const decoded = Buffer.from(encoded, 'base64');
  return decoded.length === bytes && decoded.toString('base64') === encoded;
}

function validateConnectorId(connectorId: string): void {
  invalidInput(CONNECTOR_ID.test(connectorId) && !connectorId.includes('--'), 'connectorId has an invalid shape');
}

function validateSha256(value: string, label: string): void {
  invalidInput(canonicalSri(value, SHA256_SRI, 32), `${label} must be canonical sha256 SRI`);
}

function validateSha512(value: string, label: string): void {
  invalidInput(canonicalSri(value, SHA512_SRI, 64), `${label} must be canonical sha512 SRI`);
}

function validateRevision(revision: number): void {
  invalidInput(Number.isSafeInteger(revision) && revision >= 1, 'expectedRevision must be a positive safe integer');
}

function currentRecord(transaction: ConnectorMigrationTransaction, connectorId: string): ConnectorMigrationRecord {
  const record = transaction.records.get(connectorId);
  if (!record) throw new ConnectorMigrationError('RECORD_NOT_FOUND', `unknown connector migration ${connectorId}`);
  return record;
}

function assertRevision(record: ConnectorMigrationRecord, expectedRevision: number): void {
  if (record.revision !== expectedRevision) {
    throw new ConnectorMigrationError(
      'STALE_REVISION',
      `expected connector migration revision ${expectedRevision}, current ${record.revision}`,
    );
  }
}

function assertSource(record: ConnectorMigrationRecord, expectedSourceFingerprint: string): void {
  if (record.sourceFingerprint !== expectedSourceFingerprint) {
    throw new ConnectorMigrationError('SOURCE_CHANGED', 'legacy connector source changed after migration observation');
  }
}

function assertPhase(record: ConnectorMigrationRecord, expected: readonly ConnectorMigrationRecord['phase'][]): void {
  if (!expected.includes(record.phase)) {
    throw new ConnectorMigrationError(
      'INVALID_TRANSITION',
      `connector migration cannot advance from ${record.runtimeAuthority}/${record.phase}`,
    );
  }
}

function assertHostInstance(record: ConnectorMigrationRecord, hostPluginInstanceId: string): void {
  if (record.hostPluginInstanceId !== hostPluginInstanceId) {
    throw new ConnectorMigrationError('HOST_INSTANCE_MISMATCH', 'Host plugin instance differs from the frozen shadow');
  }
}

export class ConnectorMigrationControlPlane {
  private readonly now: () => number;

  constructor(
    readonly store: ConnectorMigrationStore,
    options: ConnectorMigrationControlPlaneOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  observe(input: ObserveConnectorInput): Promise<ConnectorMigrationRecord> {
    validateConnectorId(input.connectorId);
    validateSha256(input.sourceFingerprint, 'sourceFingerprint');
    invalidInput(
      input.ownerIntent === 'enabled' || input.ownerIntent === 'disabled',
      'ownerIntent has an invalid value',
    );
    return this.store.transaction((transaction) => {
      const existing = transaction.records.get(input.connectorId);
      if (existing) {
        assertSource(existing, input.sourceFingerprint);
        if (existing.ownerIntent !== input.ownerIntent) {
          throw new ConnectorMigrationError(
            'INVALID_TRANSITION',
            'owner intent changed after observation and requires an explicit reconciled update',
          );
        }
        return existing;
      }
      const record: ConnectorMigrationRecord = {
        connectorId: input.connectorId,
        runtimeAuthority: 'legacy',
        phase: 'observed',
        revision: 1,
        sourceFingerprint: input.sourceFingerprint,
        ownerIntent: input.ownerIntent,
        updatedAt: this.now(),
      };
      transaction.records.put(record);
      return record;
    });
  }

  reconcileObservation(input: ReconcileConnectorObservationInput): Promise<ConnectorMigrationRecord> {
    validateConnectorId(input.connectorId);
    validateRevision(input.expectedRevision);
    validateSha256(input.sourceFingerprint, 'sourceFingerprint');
    invalidInput(
      input.ownerIntent === 'enabled' || input.ownerIntent === 'disabled',
      'ownerIntent has an invalid value',
    );
    return this.store.transaction((transaction) => {
      const current = currentRecord(transaction, input.connectorId);
      assertRevision(current, input.expectedRevision);
      assertPhase(current, ['observed', 'interrupted']);
      if (current.sourceFingerprint === input.sourceFingerprint && current.ownerIntent === input.ownerIntent) {
        return current;
      }
      return this.advance(
        transaction,
        current,
        {
          runtimeAuthority: 'legacy',
          phase: 'observed',
          sourceFingerprint: input.sourceFingerprint,
          ownerIntent: input.ownerIntent,
        },
        true,
      );
    });
  }

  beginShadow(input: BeginConnectorShadowInput): Promise<ConnectorMigrationRecord> {
    this.validateFencedSourceInput(input);
    return this.store.transaction((transaction) => {
      const current = currentRecord(transaction, input.connectorId);
      this.assertFence(current, input);
      assertPhase(current, ['observed', 'interrupted']);
      return this.advance(transaction, current, { runtimeAuthority: 'legacy', phase: 'copying' }, true);
    });
  }

  markShadowReady(input: MarkConnectorShadowReadyInput): Promise<ConnectorMigrationRecord> {
    this.validateFencedSourceInput(input);
    invalidInput(INSTANCE_ID.test(input.hostPluginInstanceId), 'hostPluginInstanceId has an invalid shape');
    validateSha512(input.hostPackageDigest, 'hostPackageDigest');
    validateSha256(input.evidenceFingerprint, 'evidenceFingerprint');
    return this.store.transaction((transaction) => {
      const current = currentRecord(transaction, input.connectorId);
      this.assertFence(current, input);
      assertPhase(current, ['copying']);
      return this.advance(transaction, current, {
        runtimeAuthority: 'legacy',
        phase: 'shadow-ready',
        hostPluginInstanceId: input.hostPluginInstanceId,
        hostPackageDigest: input.hostPackageDigest,
        evidenceFingerprint: input.evidenceFingerprint,
      });
    });
  }

  beginCutover(input: BeginConnectorCutoverInput): Promise<ConnectorMigrationRecord> {
    this.validateFencedSourceInput(input);
    return this.store.transaction((transaction) => {
      const current = currentRecord(transaction, input.connectorId);
      this.assertFence(current, input);
      assertPhase(current, ['shadow-ready']);
      if (input.legacyRuntimeState !== 'stopped') {
        throw new ConnectorMigrationError('LEGACY_RUNTIME_ACTIVE', 'legacy connector must stop before cutover');
      }
      if (input.hostRuntimeState !== 'stopped') {
        throw new ConnectorMigrationError('HOST_RUNTIME_ACTIVE', 'Host connector must be stopped before cutover');
      }
      return this.advance(transaction, current, { runtimeAuthority: 'host', phase: 'activating' });
    });
  }

  markHostActive(input: MarkConnectorHostActiveInput): Promise<ConnectorMigrationRecord> {
    this.validateHostInput(input);
    return this.store.transaction((transaction) => {
      const current = currentRecord(transaction, input.connectorId);
      assertRevision(current, input.expectedRevision);
      assertPhase(current, ['activating']);
      assertHostInstance(current, input.hostPluginInstanceId);
      return this.advance(transaction, current, { runtimeAuthority: 'host', phase: 'active' });
    });
  }

  markHostStartFailed(input: MarkConnectorHostActiveInput): Promise<ConnectorMigrationRecord> {
    this.validateHostInput(input);
    return this.store.transaction((transaction) => {
      const current = currentRecord(transaction, input.connectorId);
      assertRevision(current, input.expectedRevision);
      assertPhase(current, ['activating']);
      assertHostInstance(current, input.hostPluginInstanceId);
      return this.advance(transaction, current, { runtimeAuthority: 'legacy', phase: 'rollback-required' });
    });
  }

  beginRollback(input: BeginConnectorRollbackInput): Promise<ConnectorMigrationRecord> {
    this.validateHostInput(input);
    return this.store.transaction((transaction) => {
      const current = currentRecord(transaction, input.connectorId);
      assertRevision(current, input.expectedRevision);
      assertPhase(current, ['active']);
      assertHostInstance(current, input.hostPluginInstanceId);
      return this.advance(transaction, current, { runtimeAuthority: 'legacy', phase: 'rollback-required' });
    });
  }

  markLegacyRestored(input: MarkConnectorLegacyRestoredInput): Promise<ConnectorMigrationRecord> {
    this.validateHostInput(input);
    return this.store.transaction((transaction) => {
      const current = currentRecord(transaction, input.connectorId);
      assertRevision(current, input.expectedRevision);
      assertPhase(current, ['rollback-required', 'interrupted']);
      assertHostInstance(current, input.hostPluginInstanceId);
      if (input.hostRuntimeState !== 'stopped') {
        throw new ConnectorMigrationError('HOST_RUNTIME_ACTIVE', 'Host connector must stop before legacy restore');
      }
      if (current.ownerIntent === 'enabled' && input.legacyRuntimeState !== 'running') {
        throw new ConnectorMigrationError(
          'INVALID_TRANSITION',
          'enabled owner intent requires a verified legacy runtime',
        );
      }
      if (current.ownerIntent === 'disabled' && input.legacyRuntimeState !== 'stopped') {
        throw new ConnectorMigrationError(
          'LEGACY_RUNTIME_ACTIVE',
          'disabled owner intent cannot restore a live legacy runtime',
        );
      }
      return this.advance(transaction, current, { runtimeAuthority: 'legacy', phase: 'observed' }, true);
    });
  }

  recoverAfterRestart(): Promise<number> {
    return this.store.transaction((transaction) => {
      let changed = 0;
      for (const record of transaction.records.list()) {
        if (!['copying', 'activating', 'rollback-required'].includes(record.phase)) continue;
        transaction.records.put(
          this.next(record, {
            runtimeAuthority: 'legacy',
            phase: 'interrupted',
          }),
        );
        changed += 1;
      }
      return changed;
    });
  }

  private validateFencedSourceInput(input: BeginConnectorShadowInput): void {
    validateConnectorId(input.connectorId);
    validateRevision(input.expectedRevision);
    validateSha256(input.expectedSourceFingerprint, 'expectedSourceFingerprint');
  }

  private validateHostInput(input: MarkConnectorHostActiveInput): void {
    validateConnectorId(input.connectorId);
    validateRevision(input.expectedRevision);
    invalidInput(INSTANCE_ID.test(input.hostPluginInstanceId), 'hostPluginInstanceId has an invalid shape');
  }

  private assertFence(current: ConnectorMigrationRecord, input: BeginConnectorShadowInput): void {
    assertRevision(current, input.expectedRevision);
    assertSource(current, input.expectedSourceFingerprint);
  }

  private advance(
    transaction: ConnectorMigrationTransaction,
    current: ConnectorMigrationRecord,
    patch: Partial<ConnectorMigrationRecord>,
    clearHostBinding = false,
  ): ConnectorMigrationRecord {
    const next = this.next(current, patch, clearHostBinding);
    transaction.records.put(next);
    return next;
  }

  private next(
    current: ConnectorMigrationRecord,
    patch: Partial<ConnectorMigrationRecord>,
    clearHostBinding = false,
  ): ConnectorMigrationRecord {
    const {
      hostPluginInstanceId: _instance,
      hostPackageDigest: _digest,
      evidenceFingerprint: _evidence,
      ...base
    } = current;
    return {
      ...(clearHostBinding ? base : current),
      ...patch,
      revision: current.revision + 1,
      updatedAt: this.now(),
    };
  }
}
