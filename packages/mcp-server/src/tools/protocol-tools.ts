import { z } from 'zod';
import { execute, poll, submit } from '../protocol-engine/engine.js';
import type { AuthType, ExecutionParams, ProtocolTemplate, ProviderInstance } from '../protocol-engine/types.js';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

export interface ProtocolToolConfig {
  prefix: string;
  provider: ProviderInstance;
  template: ProtocolTemplate;
  credentials: Record<string, string>;
}

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: never) => Promise<ToolResult>;
};

function buildParams(config: ProtocolToolConfig, capability: string, vars: Record<string, string>): ExecutionParams {
  return {
    provider: config.provider,
    capability,
    credentials: config.credentials,
    vars,
  };
}

function createSubmitTool(config: ProtocolToolConfig, capabilities: string[]): ToolDef {
  return {
    name: `${config.prefix}_submit`,
    description:
      `Submit an async ${config.template.name} task. ` +
      `Capabilities: ${capabilities.join(', ')}. ` +
      `Returns taskId for polling. Template vars depend on capability ` +
      `(e.g. text2video: prompt; image2video: prompt + image_url).`,
    inputSchema: {
      capability: z.enum(capabilities as [string, ...string[]]).describe('Capability to invoke'),
      vars: z.record(z.string()).describe('Template variables (prompt, image_url, etc.)'),
    },
    handler: (async (input: { capability: string; vars: Record<string, string> }) => {
      try {
        const result = await submit(config.template, buildParams(config, input.capability, input.vars));
        return successResult(JSON.stringify({ taskId: result.taskId, status: result.status }));
      } catch (err) {
        return errorResult(`Submit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }) as (args: never) => Promise<ToolResult>,
  };
}

function createPollTool(config: ProtocolToolConfig, capabilities: string[]): ToolDef {
  return {
    name: `${config.prefix}_poll`,
    description:
      `Poll an async ${config.template.name} task status. ` +
      `Returns status, resultUrl (when succeeded), and error (when failed).`,
    inputSchema: {
      capability: z.enum(capabilities as [string, ...string[]]).describe('Original capability used for submit'),
      task_id: z.string().min(1).describe('Task ID from submit'),
    },
    handler: (async (input: { capability: string; task_id: string }) => {
      try {
        const result = await poll(config.template, buildParams(config, input.capability, {}), input.task_id);
        return successResult(JSON.stringify(result, null, 2));
      } catch (err) {
        return errorResult(`Poll failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }) as (args: never) => Promise<ToolResult>,
  };
}

function createExecuteTool(config: ProtocolToolConfig, capabilities: string[]): ToolDef {
  return {
    name: `${config.prefix}_execute`,
    description:
      `Execute a sync ${config.template.name} request. ` +
      `Capabilities: ${capabilities.join(', ')}. ` +
      `Returns result directly.`,
    inputSchema: {
      capability: z.enum(capabilities as [string, ...string[]]).describe('Capability to invoke'),
      vars: z.record(z.string()).describe('Template variables (video_url, prompt, etc.)'),
    },
    handler: (async (input: { capability: string; vars: Record<string, string> }) => {
      try {
        const result = await execute(config.template, buildParams(config, input.capability, input.vars));
        return successResult(result.result);
      } catch (err) {
        return errorResult(`Execute failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }) as (args: never) => Promise<ToolResult>,
  };
}

export function createProtocolTools(config: ProtocolToolConfig): ToolDef[] {
  const capabilities = Object.keys(config.template.capabilities);
  if (capabilities.length === 0) return [];

  if (config.template.mode === 'async') {
    return [createSubmitTool(config, capabilities), createPollTool(config, capabilities)];
  }
  return [createExecuteTool(config, capabilities)];
}

export function buildProviderFromEnv(prefix: string): ProviderInstance | null {
  const provider = process.env[`${prefix}_PROVIDER`];
  const authType = (process.env[`${prefix}_AUTH_TYPE`] ?? 'apikey') as AuthType;
  const apiKey = process.env[`${prefix}_API_KEY`];
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  const model = process.env[`${prefix}_MODEL`];

  if (!provider) return null;

  return {
    id: provider,
    name: provider,
    protocol: provider,
    baseUrl: baseUrl ?? '',
    authType,
    model,
  };
}

export function buildCredentialsFromEnv(prefix: string): Record<string, string> {
  const creds: Record<string, string> = {};
  const apiKey = process.env[`${prefix}_API_KEY`];
  if (apiKey) creds['apiKey'] = apiKey;
  const secretKey = process.env[`${prefix}_SECRET_KEY`];
  if (secretKey) creds['secretKey'] = secretKey;
  const accessKey = process.env[`${prefix}_ACCESS_KEY`];
  if (accessKey) creds['accessKey'] = accessKey;
  return creds;
}
