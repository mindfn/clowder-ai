import type {
  PluginDescription,
  PluginIconSpec,
  PluginManagerCapability,
  PluginManagerConfigField,
  PluginManagerDetail,
  ValueConfigField,
} from '@cat-cafe/shared';
import type { PluginManagerCompatibilityPort } from './plugin-manager-service.js';

export type PluginManagerCompatibilitySource = 'repository-local' | 'connector';
type CompatibilityConfigField = ValueConfigField & {
  readonly currentValue: string | null;
  readonly sensitive: boolean;
};

export interface PluginManagerCompatibilityRecord {
  readonly pluginId: string;
  readonly displayName: string;
  readonly version: string;
  readonly description?: PluginDescription;
  readonly icon?: PluginIconSpec;
  readonly iconBg?: string;
  readonly publisher?: string;
  readonly sourceAdapter: PluginManagerCompatibilitySource;
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly live: boolean;
  readonly docsUrl?: string;
  readonly setupSteps?: readonly string[];
  readonly configFields: readonly CompatibilityConfigField[];
  readonly capabilities: readonly PluginManagerCapability[];
}

function projectCompatibilityConfigField(field: CompatibilityConfigField): PluginManagerConfigField {
  const common = {
    key: field.envName,
    label: field.label,
    required: field.required,
    currentValue: field.currentValue,
    sensitive: field.sensitive,
  };
  switch (field.type) {
    case 'toggle':
      return { ...common, kind: 'boolean', ...(field.default === undefined ? {} : { default: field.default }) };
    case 'select':
      return {
        ...common,
        kind: 'select',
        options: field.options.map((option) => ({ ...option })),
        ...(field.default === undefined ? {} : { default: field.default }),
      };
    case 'list':
      return {
        ...common,
        kind: 'list',
        ...(field.default === undefined ? {} : { default: [...field.default] }),
      };
    case 'input':
      return {
        ...common,
        kind: field.sensitive ? 'secret' : 'string',
        ...(field.default === undefined ? {} : { default: field.default }),
      };
  }
}

export interface PluginManagerCompatibilityProvider {
  list(): Promise<readonly PluginManagerCompatibilityRecord[]>;
}

function projectCompatibilityRecord(record: PluginManagerCompatibilityRecord): PluginManagerDetail {
  const capabilities = record.capabilities.map((capability) => ({ ...capability }));
  return {
    pluginId: record.pluginId,
    pluginInstanceId: null,
    displayName: record.displayName,
    ...(record.description === undefined ? {} : { description: record.description }),
    ...(record.icon === undefined ? {} : { icon: record.icon }),
    ...(record.iconBg === undefined ? {} : { iconBg: record.iconBg }),
    publisher: record.publisher ?? 'Clowder AI',
    source: {
      kind: 'compatibility',
      adapter: record.sourceAdapter,
      packageName: `${record.sourceAdapter}:${record.pluginId}`,
      trust: 'first-party',
    },
    availableVersion: record.version,
    installedVersion: record.version,
    packageDigest: null,
    artifact: 'installed',
    config: record.configured ? 'ready' : 'incomplete',
    auth: 'not-required',
    intent: record.enabled ? 'enabled' : 'disabled',
    live: record.live ? 'running' : 'stopped',
    lifecycleRevision: null,
    capabilitySummary: capabilities.map(({ id, kind, name, active }) => ({ id, kind, name, active })),
    actions: {
      install: false,
      setEnabled: false,
      uninstall: false,
      blockingReasons: ['compatibility-read-only'],
    },
    capabilities,
    ...(record.docsUrl === undefined ? {} : { docsUrl: record.docsUrl }),
    ...(record.setupSteps === undefined ? {} : { setupSteps: [...record.setupSteps] }),
    configFields: record.configFields.map(projectCompatibilityConfigField),
  };
}

/** Train C deletes this adapter after every legacy source is materialized in Host inventory. */
export class PluginManagerCompatibilityAdapter implements PluginManagerCompatibilityPort {
  constructor(private readonly providers: readonly PluginManagerCompatibilityProvider[]) {}

  async list(): Promise<readonly PluginManagerDetail[]> {
    const records = await Promise.all(this.providers.map((provider) => provider.list()));
    const byPluginId = new Map<string, PluginManagerDetail>();
    for (const record of records.flat()) {
      if (!byPluginId.has(record.pluginId)) byPluginId.set(record.pluginId, projectCompatibilityRecord(record));
    }
    return [...byPluginId.values()];
  }
}

export class CompositePluginManagerCompatibilityPort implements PluginManagerCompatibilityPort {
  constructor(private readonly ports: readonly PluginManagerCompatibilityPort[]) {}

  async list(): Promise<readonly PluginManagerDetail[]> {
    const rows = await Promise.all(this.ports.map((port) => port.list()));
    const byPluginId = new Map<string, PluginManagerDetail>();
    for (const row of rows.flat()) {
      if (!byPluginId.has(row.pluginId)) byPluginId.set(row.pluginId, row);
    }
    return [...byPluginId.values()];
  }
}
