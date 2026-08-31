import type { PluginInstanceRecord } from '../host-inventory/types.js';
import type {
  ConnectorMigrationPhase,
  ConnectorMigrationRecord,
  ConnectorMigrationSnapshot,
  ConnectorRuntimeAuthority,
} from './types.js';

export type ConnectorMigrationProjectionConsistency =
  | 'ready'
  | 'host-instance-missing'
  | 'host-instance-stale'
  | 'host-package-mismatch';

export interface ConnectorMigrationProjection {
  readonly phase: ConnectorMigrationPhase;
  readonly revision: number;
  readonly consistency: ConnectorMigrationProjectionConsistency;
  readonly hostPluginInstanceId?: string;
}

export interface ConnectorMigrationStatusProjection {
  readonly runtimeAuthority: ConnectorRuntimeAuthority;
  readonly migration?: ConnectorMigrationProjection;
}

interface ConnectorStatusIdentity {
  readonly id: string;
  readonly source?: 'builtin' | 'external';
}

interface InventoryProjectionInput {
  readonly instances: readonly Pick<
    PluginInstanceRecord,
    'pluginInstanceId' | 'packageDigest' | 'lifecycleState' | 'activationState' | 'runtimeState'
  >[];
}

function consistency(
  record: ConnectorMigrationRecord,
  inventory: InventoryProjectionInput,
): ConnectorMigrationProjectionConsistency {
  if (!record.hostPluginInstanceId) return 'ready';
  const instance = inventory.instances.find((candidate) => candidate.pluginInstanceId === record.hostPluginInstanceId);
  if (!instance) return 'host-instance-missing';
  if (instance.lifecycleState !== 'installed') return 'host-instance-stale';
  if (instance.packageDigest !== record.hostPackageDigest) return 'host-package-mismatch';
  return 'ready';
}

export function projectConnectorMigrationStatuses<T extends ConnectorStatusIdentity>(
  statuses: readonly T[],
  migrations: ConnectorMigrationSnapshot,
  inventory: InventoryProjectionInput,
): Array<T & Partial<ConnectorMigrationStatusProjection>> {
  const migrationByConnector = new Map(migrations.records.map((record) => [record.connectorId, record]));
  return statuses.map((status) => {
    if (status.source !== 'external') return status;
    const record = migrationByConnector.get(status.id);
    if (!record) return { ...status, runtimeAuthority: 'legacy' as const };
    return {
      ...status,
      runtimeAuthority: record.runtimeAuthority,
      migration: {
        phase: record.phase,
        revision: record.revision,
        consistency: consistency(record, inventory),
        ...(record.hostPluginInstanceId === undefined ? {} : { hostPluginInstanceId: record.hostPluginInstanceId }),
      },
    };
  });
}
