import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  CAT_CAFE_SPLIT_ENTRYPOINTS,
  resolvePencilCommand,
  resolveServersForCat,
} from '../../../../../config/capabilities/capability-orchestrator.js';

/**
 * opencode Config Template Generator
 * Generates opencode.json configuration for Cat Cafe runtime.
 *
 * opencode reads its config from opencode.json (per-project or ~/.config/opencode/).
 * This generator produces a config with:
 * - Anthropic provider (via proxy)
 * - Optional OMOC plugin (oh-my-opencode)
 * - Optional Clowder AI MCP server (deterministic injection via mcpServerPath)
 */

interface OpenCodeConfigOptions {
  /** Anthropic API key — validated but NOT written to config (stays in ANTHROPIC_API_KEY env var) */
  apiKey: string;
  /** Base URL for Anthropic API (passed through as configured) */
  baseUrl: string;
  /** Model name (e.g. 'claude-sonnet-4-6' or 'openrouter/google/gemini-3-flash-preview') */
  model: string;
  /** Enable Oh My OpenCode plugin (default: true) */
  enableOmoc?: boolean;
}

type OpenCodeProviderConfig = {
  npm?: string;
  models?: Record<string, { name: string }>;
  options: {
    apiKey?: string;
    baseURL?: string;
  };
};

interface OpenCodeConfig {
  $schema: string;
  model?: string;
  provider: Record<string, OpenCodeProviderConfig>;
  plugin?: string[];
  mcp?: Record<string, unknown>;
}

export function generateOpenCodeConfig(options: OpenCodeConfigOptions): OpenCodeConfig {
  const { baseUrl, model, enableOmoc = true } = options;

  const config: OpenCodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    model,
    provider: {
      anthropic: {
        options: {
          baseURL: baseUrl,
        },
      },
    },
  };

  if (enableOmoc) {
    config.plugin = ['oh-my-opencode'];
  }

  return config;
}

export const OC_API_KEY_ENV = 'CAT_CAFE_OC_API_KEY';
export const OC_BASE_URL_ENV = 'CAT_CAFE_OC_BASE_URL';

/**
 * OpenCode API type determines which AI SDK npm adapter to use.
 * - 'openai'           → @ai-sdk/openai-compatible  (chat/completions, default for custom providers)
 * - 'openai-responses'  → @ai-sdk/openai             (responses API, for official OpenAI endpoints)
 * - 'anthropic'         → @ai-sdk/anthropic
 * - 'google'            → @ai-sdk/google
 */
export type OpenCodeApiType = 'openai' | 'openai-responses' | 'anthropic' | 'google';

const NPM_ADAPTER_FOR_API_TYPE: Record<string, string> = {
  openai: '@ai-sdk/openai-compatible',
  'openai-responses': '@ai-sdk/openai',
  anthropic: '@ai-sdk/anthropic',
  google: '@ai-sdk/google',
};

/**
 * Derive the OpenCode API type from the member's provider name binding.
 *
 * Account-level protocol is no longer used — it was removed from the UI and
 * should not drive runtime routing. The sole authority is the provider name,
 * which the user explicitly sets in the member editor "Provider 名称" field.
 */
export function deriveOpenCodeApiType(providerName: string | undefined): OpenCodeApiType {
  const normalized = providerName?.toLowerCase();
  if (normalized === 'openai-responses') return 'openai-responses';
  if (normalized === 'anthropic') return 'anthropic';
  if (normalized === 'google') return 'google';
  return 'openai';
}

export interface OpenCodeRuntimeConfigOptions {
  providerName: string;
  models: readonly string[];
  defaultModel?: string;
  apiType?: OpenCodeApiType;
  hasBaseUrl?: boolean;
  /** Absolute path to Clowder AI MCP server entry (packages/mcp-server/dist/index.js). */
  mcpServerPath?: string;
  /** Cat ID for capabilities.json enabled-state filtering. */
  catId?: string;
}

export interface OpenCodeRuntimeConfigDebugSummary {
  model?: string;
  providerKeys: string[];
  providerSummary: Record<
    string,
    {
      npm?: string;
      modelKeys: string[];
      hasBaseUrl: boolean;
      apiKeySource: string;
      baseUrlSource?: string;
    }
  >;
}

export function parseOpenCodeModel(model: string): { providerName: string; modelName: string } | null {
  const trimmed = model.trim();
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) return null;
  return {
    providerName: trimmed.slice(0, slashIndex),
    modelName: trimmed.slice(slashIndex + 1),
  };
}

function stripOwnProviderPrefix(modelName: string, providerName: string): string {
  const prefix = `${providerName}/`;
  return modelName.startsWith(prefix) ? modelName.slice(prefix.length) : modelName;
}

/**
 * OpenCode treats certain provider names as built-in and forces its own SDK
 * handling (e.g. 'openai' → Responses API via sdk.responses()), ignoring the
 * npm adapter field.  Remap these names so the config's npm adapter is used.
 *
 * Only 'openai' needs remapping: its builtin forces Responses-style routing
 * that conflicts with Chat Completions proxies. 'anthropic' and 'google'
 * builtins already match the intended SDK adapter, so no remap needed.
 */
const OPENCODE_BUILTIN_NAMES = new Set(['openai']);

export function safeProviderName(name: string): string {
  return OPENCODE_BUILTIN_NAMES.has(name) ? `${name}-compat` : name;
}

export function generateOpenCodeRuntimeConfig(options: OpenCodeRuntimeConfigOptions): OpenCodeConfig {
  const { providerName, models, defaultModel, apiType = 'openai', hasBaseUrl = false, mcpServerPath, catId } = options;

  const configName = safeProviderName(providerName);

  const modelsMap: Record<string, { name: string }> = {};
  const modelsToRegister = defaultModel ? [...models, defaultModel] : [...models];
  for (const rawModel of modelsToRegister) {
    const modelName = stripOwnProviderPrefix(rawModel, providerName);
    modelsMap[modelName] = { name: modelName };
  }

  let configDefaultModel = defaultModel;
  if (configName !== providerName && defaultModel?.startsWith(`${providerName}/`)) {
    configDefaultModel = `${configName}/${defaultModel.slice(providerName.length + 1)}`;
  }

  const config: OpenCodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    ...(configDefaultModel ? { model: configDefaultModel } : {}),
    provider: {
      [configName]: {
        npm: NPM_ADAPTER_FOR_API_TYPE[apiType] ?? NPM_ADAPTER_FOR_API_TYPE.openai,
        models: modelsMap,
        options: {
          ...(hasBaseUrl ? { baseURL: `{env:${OC_BASE_URL_ENV}}` } : {}),
          apiKey: `{env:${OC_API_KEY_ENV}}`,
        },
      },
    },
  };

  if (mcpServerPath) {
    const mcp = buildOpenCodeMcpSync(mcpServerPath, catId);
    if (Object.keys(mcp).length > 0) config.mcp = mcp;
  }

  return config;
}

function buildOpenCodeMcpSync(
  mcpServerPath: string,
  catId?: string,
): Record<string, { type: string; command: string[] }> {
  const distDir = dirname(mcpServerPath);
  const projectRoot = resolve(distDir, '../../..');
  const mcp: Record<string, { type: string; command: string[]; environment?: Record<string, string> }> = {};

  let resolved = false;
  try {
    const raw = readFileSync(join(projectRoot, '.cat-cafe', 'capabilities.json'), 'utf-8');
    const capConfig = JSON.parse(raw);
    if (capConfig?.version === 1 && catId) {
      for (const s of resolveServersForCat(capConfig, catId) as Array<{
        name: string;
        enabled: boolean;
        command: string;
        args: string[];
        resolver?: string;
        transport?: string;
        env?: Record<string, string>;
      }>) {
        if (!s.enabled) continue;
        if (s.transport === 'streamableHttp') continue;
        if (CAT_CAFE_SPLIT_ENTRYPOINTS.has(s.name)) {
          const ep = CAT_CAFE_SPLIT_ENTRYPOINTS.get(s.name)!;
          const epPath = join(distDir, ep);
          if (existsSync(epPath)) mcp[s.name] = { type: 'local', command: ['node', epPath] };
        } else if (s.resolver === 'pencil') {
          // Pencil needs async resolution — handled in writeOpenCodeRuntimeConfig
        } else if (s.command) {
          const entry: { type: string; command: string[]; environment?: Record<string, string> } = {
            type: 'local',
            command: [s.command, ...s.args],
          };
          if (s.env && Object.keys(s.env).length > 0) entry.environment = s.env;
          mcp[s.name] = entry;
        }
      }
      resolved = true;
    }
  } catch {
    // best-effort fallback below
  }

  if (!resolved) {
    for (const [name, entrypoint] of CAT_CAFE_SPLIT_ENTRYPOINTS) {
      mcp[name] = { type: 'local', command: ['node', join(distDir, entrypoint)] };
    }
  }
  return mcp;
}

function summarizeEnvPlaceholder(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\{env:([^}]+)\}$/);
  return match ? `env:${match[1]}` : value;
}

export function summarizeOpenCodeRuntimeConfigForDebug(
  options: OpenCodeRuntimeConfigOptions,
): OpenCodeRuntimeConfigDebugSummary {
  const config = generateOpenCodeRuntimeConfig(options);
  const providerEntries = Object.entries(config.provider).sort(([a], [b]) => a.localeCompare(b));

  return {
    model: config.model,
    providerKeys: providerEntries.map(([providerName]) => providerName),
    providerSummary: Object.fromEntries(
      providerEntries.map(([providerName, providerConfig]) => [
        providerName,
        {
          npm: providerConfig.npm,
          modelKeys: Object.keys(providerConfig.models ?? {}).sort(),
          hasBaseUrl: Boolean(providerConfig.options.baseURL),
          apiKeySource: summarizeEnvPlaceholder(providerConfig.options.apiKey) ?? '(unset)',
          ...(providerConfig.options.baseURL
            ? { baseUrlSource: summarizeEnvPlaceholder(providerConfig.options.baseURL) }
            : {}),
        },
      ]),
    ),
  };
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

/**
 * Writes a per-invocation opencode config file.
 * OpenCode's `OPENCODE_CONFIG` points to a config file path; `OPENCODE_CONFIG_DIR`
 * is reserved for the `.opencode/`-style config directory structure.
 * Returns the `opencode.json` file path (set it as `OPENCODE_CONFIG`).
 */
export async function writeOpenCodeRuntimeConfig(
  projectRoot: string,
  catId: string,
  invocationId: string,
  options: OpenCodeRuntimeConfigOptions,
  workingDirectory?: string,
): Promise<string> {
  const safeCatId = sanitizePathSegment(catId);
  const safeInvocationId = sanitizePathSegment(invocationId);
  const configDir = join(projectRoot, '.cat-cafe', `oc-config-${safeCatId}-${safeInvocationId}`);
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'opencode.json');
  const tempPath = `${configPath}.tmp-${process.pid}`;
  const config = generateOpenCodeRuntimeConfig({ ...options, catId: options.catId ?? catId });

  // Resolve pencil at invoke time (async) — only if enabled in capabilities.json
  if (options.mcpServerPath) {
    const mcpProjectRoot = resolve(dirname(options.mcpServerPath), '../../..');
    const effectiveCatId = options.catId ?? catId;
    let pencilEnabled = false;
    try {
      const raw = readFileSync(join(mcpProjectRoot, '.cat-cafe', 'capabilities.json'), 'utf-8');
      const capConfig = JSON.parse(raw);
      if (capConfig?.version === 1 && effectiveCatId) {
        pencilEnabled = (
          resolveServersForCat(capConfig, effectiveCatId) as Array<{
            name: string;
            enabled: boolean;
            resolver?: string;
          }>
        ).some((s) => s.resolver === 'pencil' && s.enabled);
      }
    } catch {
      /* best-effort */
    }
    if (pencilEnabled) {
      try {
        const pencil = await resolvePencilCommand({ projectRoot: mcpProjectRoot });
        if (pencil) {
          if (!config.mcp) config.mcp = {};
          config.mcp.pencil = { type: 'local', command: [pencil.command, ...pencil.args] };
        }
      } catch {
        /* best-effort */
      }
    }
  }

  if (workingDirectory) {
    const userConfigPath = join(workingDirectory, 'opencode.json');
    try {
      if (existsSync(userConfigPath)) {
        const userConfig = JSON.parse(readFileSync(userConfigPath, 'utf-8')) as { mcp?: Record<string, unknown> };
        if (userConfig.mcp && typeof userConfig.mcp === 'object') {
          const merged = { ...userConfig.mcp, ...(config.mcp ?? {}) };
          config.mcp = merged;
        }
      }
    } catch {
      // best-effort: if user config unreadable, proceed with our config only
    }
  }

  writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf-8');
  renameSync(tempPath, configPath);
  return configPath;
}
