import {
  CONNECTOR_MIGRATION_SCHEMA_VERSION,
  ConnectorMigrationError,
  type ConnectorMigrationPhase,
  type ConnectorMigrationRecord,
  type ConnectorMigrationSnapshot,
  type ConnectorOwnerIntent,
  type ConnectorRuntimeAuthority,
} from './types.js';

const AUTHORITY = new Set<ConnectorRuntimeAuthority>(['legacy', 'host']);
const OWNER_INTENT = new Set<ConnectorOwnerIntent>(['disabled', 'enabled']);
const PHASE = new Set<ConnectorMigrationPhase>([
  'observed',
  'copying',
  'shadow-ready',
  'activating',
  'active',
  'rollback-required',
  'interrupted',
]);
const CONNECTOR_ID = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/u;
const SHA256_SRI = /^sha256-[A-Za-z0-9+/]{43}=$/u;
const SHA512_SRI = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const INSTANCE_ID = /^pi_[A-Za-z0-9._:-]{1,252}$/u;

function corrupt(message: string): never {
  throw new ConnectorMigrationError('CORRUPT_SNAPSHOT', message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) corrupt(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function closedKeys(raw: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (extras.length > 0) corrupt(`${label} has unsupported fields: ${extras.join(', ')}`);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) corrupt(`${label} must be a non-empty string`);
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) corrupt(`${label} has an unsupported value`);
  return value as T;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    corrupt(`${label} must be a positive safe integer`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    corrupt(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function canonicalSri(value: unknown, pattern: RegExp, algorithm: string, label: string): string {
  const candidate = nonEmptyString(value, label);
  if (!pattern.test(candidate)) corrupt(`${label} must be canonical ${algorithm} SRI`);
  const encoded = candidate.slice(algorithm.length + 1);
  const bytes = Buffer.from(encoded, 'base64');
  const expectedBytes = algorithm === 'sha256' ? 32 : 64;
  if (bytes.length !== expectedBytes || bytes.toString('base64') !== encoded) {
    corrupt(`${label} must be canonical ${algorithm} SRI`);
  }
  return candidate;
}

function optionalString(value: unknown, pattern: RegExp, label: string): string | undefined {
  if (value === undefined) return undefined;
  const candidate = nonEmptyString(value, label);
  if (!pattern.test(candidate)) corrupt(`${label} has an invalid shape`);
  return candidate;
}

function connectorId(value: unknown, label: string): string {
  const candidate = nonEmptyString(value, label);
  if (!CONNECTOR_ID.test(candidate) || candidate.includes('--')) corrupt(`${label} has an invalid shape`);
  return candidate;
}

interface HostShadowBinding {
  readonly hostPluginInstanceId?: string;
  readonly hostPackageDigest?: string;
  readonly evidenceFingerprint?: string;
}

function parseHostShadowBinding(raw: Record<string, unknown>, label: string): HostShadowBinding {
  const hostPluginInstanceId = optionalString(raw.hostPluginInstanceId, INSTANCE_ID, `${label}.hostPluginInstanceId`);
  const hostPackageDigest =
    raw.hostPackageDigest === undefined
      ? undefined
      : canonicalSri(raw.hostPackageDigest, SHA512_SRI, 'sha512', `${label}.hostPackageDigest`);
  const evidenceFingerprint =
    raw.evidenceFingerprint === undefined
      ? undefined
      : canonicalSri(raw.evidenceFingerprint, SHA256_SRI, 'sha256', `${label}.evidenceFingerprint`);
  return {
    ...(hostPluginInstanceId === undefined ? {} : { hostPluginInstanceId }),
    ...(hostPackageDigest === undefined ? {} : { hostPackageDigest }),
    ...(evidenceFingerprint === undefined ? {} : { evidenceFingerprint }),
  };
}

function assertAuthorityPhase(
  authority: ConnectorRuntimeAuthority,
  phase: ConnectorMigrationPhase,
  label: string,
): void {
  if (authority === 'host' && phase !== 'activating' && phase !== 'active') {
    corrupt(`${label} host authority is only valid while activating or active`);
  }
  if (authority === 'legacy' && (phase === 'activating' || phase === 'active')) {
    corrupt(`${label} ${phase} requires Host authority`);
  }
}

function assertBindingPhase(binding: HostShadowBinding, phase: ConnectorMigrationPhase, label: string): void {
  const { hostPluginInstanceId, hostPackageDigest, evidenceFingerprint } = binding;
  const bindingParts = [hostPluginInstanceId, hostPackageDigest, evidenceFingerprint];
  const hasAnyBinding = bindingParts.some((part) => part !== undefined);
  const hasCompleteBinding = bindingParts.every((part) => part !== undefined);
  const requiresHostBinding = ['shadow-ready', 'activating', 'active', 'rollback-required'].includes(phase);
  if (requiresHostBinding && !hasCompleteBinding) {
    corrupt(`${label} ${phase} requires a complete Host shadow binding`);
  }
  if (!requiresHostBinding && phase !== 'interrupted' && hasAnyBinding) {
    corrupt(`${label} ${phase} cannot carry a Host shadow binding`);
  }
  if (phase === 'interrupted' && hasAnyBinding && !hasCompleteBinding) {
    corrupt(`${label} interrupted requires either no Host binding or a complete Host binding`);
  }
}

function parseRecord(value: unknown, index: number): ConnectorMigrationRecord {
  const label = `records[${index}]`;
  const raw = object(value, label);
  closedKeys(
    raw,
    [
      'connectorId',
      'runtimeAuthority',
      'phase',
      'revision',
      'sourceFingerprint',
      'ownerIntent',
      'hostPluginInstanceId',
      'hostPackageDigest',
      'evidenceFingerprint',
      'updatedAt',
    ],
    label,
  );
  const parsedConnectorId = connectorId(raw.connectorId, `${label}.connectorId`);
  const runtimeAuthority = enumValue(raw.runtimeAuthority, AUTHORITY, `${label}.runtimeAuthority`);
  const phase = enumValue(raw.phase, PHASE, `${label}.phase`);
  const binding = parseHostShadowBinding(raw, label);
  assertAuthorityPhase(runtimeAuthority, phase, label);
  assertBindingPhase(binding, phase, label);

  return {
    connectorId: parsedConnectorId,
    runtimeAuthority,
    phase,
    revision: positiveInteger(raw.revision, `${label}.revision`),
    sourceFingerprint: canonicalSri(raw.sourceFingerprint, SHA256_SRI, 'sha256', `${label}.sourceFingerprint`),
    ownerIntent: enumValue(raw.ownerIntent, OWNER_INTENT, `${label}.ownerIntent`),
    ...binding,
    updatedAt: timestamp(raw.updatedAt, `${label}.updatedAt`),
  };
}

export function emptyConnectorMigrationSnapshot(): ConnectorMigrationSnapshot {
  return { schemaVersion: CONNECTOR_MIGRATION_SCHEMA_VERSION, records: [] };
}

export function cloneConnectorMigrationSnapshot(snapshot: ConnectorMigrationSnapshot): ConnectorMigrationSnapshot {
  return structuredClone(snapshot);
}

export function parseConnectorMigrationSnapshot(value: unknown): ConnectorMigrationSnapshot {
  const raw = object(value, 'connector migration snapshot');
  closedKeys(raw, ['schemaVersion', 'records'], 'connector migration snapshot');
  if (raw.schemaVersion !== CONNECTOR_MIGRATION_SCHEMA_VERSION) {
    if (typeof raw.schemaVersion === 'number') {
      throw new ConnectorMigrationError(
        'UNSUPPORTED_SCHEMA',
        `unsupported connector migration schema ${raw.schemaVersion}`,
      );
    }
    corrupt('connector migration snapshot schemaVersion must be 1');
  }
  if (!Array.isArray(raw.records)) corrupt('connector migration snapshot records must be an array');
  const records = raw.records.map(parseRecord);
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.connectorId)) corrupt(`duplicate connector migration record ${record.connectorId}`);
    ids.add(record.connectorId);
  }
  return { schemaVersion: CONNECTOR_MIGRATION_SCHEMA_VERSION, records };
}
