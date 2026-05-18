/**
 * Plugin Framework Types — F202 声明式插件注册与资源编排
 */

/** Option for select-type config fields */
export interface PluginConfigOption {
  value: string;
  label: string;
  hint?: string;
  docsUrl?: string;
  supportedBy?: Record<string, string[]>;
}

/** Plugin config field declaration (from plugin.yaml) */
export interface PluginConfigField {
  envName: string;
  label: string;
  sensitive: boolean;
  required: boolean;
  type?: 'text' | 'select';
  options?: PluginConfigOption[];
  oneOf?: Record<string, PluginConfigField[]>;
}

/** Plugin health check declaration */
export interface PluginHealthCheck {
  limbCommand?: string;
  mcpProbe?: string;
}

/** Plugin resource declaration */
export interface PluginResourceDef {
  type: 'skill' | 'mcp' | 'limb' | 'schedule';
  path?: string;
  name?: string;
  command?: string;
  args?: string[];
  transport?: string;
}

/** Parsed plugin manifest (from plugin.yaml) */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  iconBg?: string;
  builtin?: boolean;
  docsUrl?: string;
  setupSteps?: string[];
  config: PluginConfigField[];
  healthCheck?: PluginHealthCheck;
  resources: PluginResourceDef[];
}

/** Derived plugin status */
export type PluginStatus = 'enabled' | 'configured' | 'not_configured' | 'partial';

/** Per-resource activation status */
export interface PluginResourceStatus {
  type: string;
  path?: string;
  name?: string;
  enabled: boolean;
  error?: string;
}

/** Full plugin info returned by API (manifest + derived state) */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  iconBg?: string;
  docsUrl?: string;
  setupSteps?: string[];
  status: PluginStatus;
  configured: boolean;
  config: (PluginConfigField & { currentValue: string | null })[];
  healthCheck?: PluginHealthCheck;
  resources: PluginResourceStatus[];
  hasHealthCheck: boolean;
}
