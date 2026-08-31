export const CONNECTOR_MIGRATION_SCHEMA_VERSION = 1 as const;

export type ConnectorRuntimeAuthority = 'legacy' | 'host';
export type ConnectorOwnerIntent = 'disabled' | 'enabled';
export type ConnectorMigrationPhase =
  | 'observed'
  | 'copying'
  | 'shadow-ready'
  | 'activating'
  | 'active'
  | 'rollback-required'
  | 'interrupted';

export interface ConnectorMigrationRecord {
  readonly connectorId: string;
  readonly runtimeAuthority: ConnectorRuntimeAuthority;
  readonly phase: ConnectorMigrationPhase;
  readonly revision: number;
  readonly sourceFingerprint: string;
  readonly ownerIntent: ConnectorOwnerIntent;
  readonly hostPluginInstanceId?: string;
  readonly hostPackageDigest?: string;
  readonly evidenceFingerprint?: string;
  readonly updatedAt: number;
}

export interface ConnectorMigrationSnapshot {
  readonly schemaVersion: typeof CONNECTOR_MIGRATION_SCHEMA_VERSION;
  readonly records: readonly ConnectorMigrationRecord[];
}

export interface ConnectorMigrationRecordStore {
  get(connectorId: string): ConnectorMigrationRecord | undefined;
  list(): ConnectorMigrationRecord[];
  put(record: ConnectorMigrationRecord): void;
}

export interface ConnectorMigrationTransaction {
  readonly records: ConnectorMigrationRecordStore;
}

export interface ConnectorMigrationStore {
  snapshot(): Promise<ConnectorMigrationSnapshot>;
  transaction<T>(work: (transaction: ConnectorMigrationTransaction) => Promise<T> | T): Promise<T>;
}

export type ConnectorMigrationErrorCode =
  | 'INVALID_INPUT'
  | 'RECORD_NOT_FOUND'
  | 'STALE_REVISION'
  | 'SOURCE_CHANGED'
  | 'INVALID_TRANSITION'
  | 'LEGACY_RUNTIME_ACTIVE'
  | 'HOST_RUNTIME_ACTIVE'
  | 'HOST_INSTANCE_MISMATCH'
  | 'CORRUPT_SNAPSHOT'
  | 'UNSUPPORTED_SCHEMA';

export class ConnectorMigrationError extends Error {
  constructor(
    readonly code: ConnectorMigrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorMigrationError';
  }
}

export interface ObserveConnectorInput {
  readonly connectorId: string;
  readonly sourceFingerprint: string;
  readonly ownerIntent: ConnectorOwnerIntent;
}

export interface ReconcileConnectorObservationInput extends ObserveConnectorInput {
  readonly expectedRevision: number;
}

export interface BeginConnectorShadowInput {
  readonly connectorId: string;
  readonly expectedRevision: number;
  readonly expectedSourceFingerprint: string;
}

export interface MarkConnectorShadowReadyInput extends BeginConnectorShadowInput {
  readonly hostPluginInstanceId: string;
  readonly hostPackageDigest: string;
  readonly evidenceFingerprint: string;
}

export interface BeginConnectorCutoverInput extends BeginConnectorShadowInput {
  readonly legacyRuntimeState: 'running' | 'stopped';
  readonly hostRuntimeState: 'stopped' | 'starting' | 'handshaking' | 'healthy' | 'degraded' | 'crashed';
}

export interface MarkConnectorHostActiveInput {
  readonly connectorId: string;
  readonly expectedRevision: number;
  readonly hostPluginInstanceId: string;
}

export interface BeginConnectorRollbackInput extends MarkConnectorHostActiveInput {}

export interface MarkConnectorLegacyRestoredInput extends MarkConnectorHostActiveInput {
  readonly legacyRuntimeState: 'running' | 'stopped';
  readonly hostRuntimeState: 'stopped' | 'starting' | 'handshaking' | 'healthy' | 'degraded' | 'crashed';
}
