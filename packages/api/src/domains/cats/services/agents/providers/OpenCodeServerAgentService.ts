import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { parseOpenCodeModel } from '../../../../../config/opencode-model.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type {
  AgentClientActiveRunHandle,
  AgentFreshnessCarrierCapability,
  AgentMessage,
  AgentServiceOptions,
  L0InjectableAgentService,
  MessageMetadata,
  PreparedProviderRequestV1,
  ToolExecutionPolicy,
} from '../../types.js';
import { appendLocalImagePathHints } from './image-cli-bridge.js';
import { extractImagePaths } from './image-paths.js';
import type { OpenCodeServerHostLike } from './OpenCodeServerHost.js';

const log = createModuleLogger('opencode-server-agent');

interface OpenCodeServerAgentServiceOptions {
  catId?: CatId;
  model?: string;
  host: OpenCodeServerHostLike;
}

const READ_ONLY_PERMISSION = {
  '*': 'deny',
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  lsp: 'allow',
  skill: 'allow',
  webfetch: 'allow',
  websearch: 'allow',
} as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function eventSessionId(event: Record<string, unknown>): string | undefined {
  const properties = record(event.properties);
  if (typeof properties?.sessionID === 'string') return properties.sessionID;
  const part = record(properties?.part);
  if (typeof part?.sessionID === 'string') return part.sessionID;
  const info = record(properties?.info);
  return typeof info?.sessionID === 'string' ? info.sessionID : undefined;
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  const object = record(error);
  const data = record(object?.data);
  if (typeof data?.message === 'string') return data.message;
  if (typeof object?.message === 'string') return object.message;
  return JSON.stringify(error);
}

function materializeEnvironment(value: unknown, env: Readonly<Record<string, string | undefined>>): unknown {
  if (typeof value === 'string') {
    const match = /^\{env:([^}]+)\}$/.exec(value);
    return match && env[match[1]] !== undefined ? env[match[1]] : value;
  }
  if (Array.isArray(value)) return value.map((item) => materializeEnvironment(item, env));
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, materializeEnvironment(item, env)]));
}

function readRuntimeConfig(
  callbackEnv: Record<string, string> | undefined,
  accountEnv: Record<string, string> | undefined,
  readOnly: boolean,
): { config: Record<string, unknown>; nativeInstructions: PreparedProviderRequestV1['nativeInstructions'] } {
  const path = callbackEnv?.OPENCODE_CONFIG;
  if (!path) throw new Error('opencode_server_runtime_config_required');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const parsed = record(raw);
  if (!parsed) throw new Error('opencode_server_runtime_config_invalid');
  const env = { ...process.env, ...(callbackEnv ?? {}), ...(accountEnv ?? {}) };
  const config = materializeEnvironment(parsed, env) as Record<string, unknown>;
  const instructions = Array.isArray(parsed.instructions)
    ? parsed.instructions.flatMap((instruction) => {
        if (typeof instruction !== 'string') return [];
        try {
          return [{ body: readFileSync(instruction, 'utf8'), injectionDecision: 'runtime_config_instruction' }];
        } catch {
          return [];
        }
      })
    : [];
  if (readOnly) {
    config.permission = READ_ONLY_PERMISSION;
    config.agent = {
      ...(record(config.agent) ?? {}),
      'cat-cafe-read-only': { mode: 'primary', permission: READ_ONLY_PERMISSION },
    };
  }
  return { config, nativeInstructions: instructions };
}

function promptBody(text: string, model: string, messageID: string, readOnly: boolean): Record<string, unknown> {
  const parsedModel = parseOpenCodeModel(model);
  return {
    messageID,
    ...(parsedModel ? { model: { providerID: parsedModel.providerName, modelID: parsedModel.modelName } } : {}),
    ...(readOnly ? { agent: 'cat-cafe-read-only' } : {}),
    parts: [{ type: 'text', text }],
  };
}

export class OpenCodeServerAgentService implements L0InjectableAgentService {
  readonly catId: CatId;
  readonly l0CompilerFn = undefined;
  private readonly model: string;
  private readonly host: OpenCodeServerHostLike;

  constructor(options: OpenCodeServerAgentServiceOptions) {
    this.catId = options.catId ?? createCatId('opencode');
    this.model = options.model ?? getCatModel(this.catId as string);
    this.host = options.host;
  }

  injectsL0Natively(): boolean {
    return true;
  }

  supportsToolExecutionPolicy(policy: ToolExecutionPolicy): boolean {
    return policy.mode === 'read_only';
  }

  freshnessCarrierCapability(): AgentFreshnessCarrierCapability {
    return { provider: 'opencode', carrier: 'opencode_server', deliverySemantics: 'exact_active_turn' };
  }

  contextCapability(): import('../../types.js').AgentContextCapability {
    return {
      provider: 'opencode',
      carrier: 'server',
      reportsRuntimeWindow: false,
      authoritativeUsage: true,
      usageTelemetry: 'available',
      nativeWindowControl: true,
      nativeCompressionControl: true,
      observesCompression: false,
      reason: 'OpenCode server exposes compaction events, but their epoch authority is not yet proven end to end',
    };
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const readOnly = options?.toolExecutionPolicy?.mode === 'read_only';
    const model = options?.callbackEnv?.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE ?? this.model;
    const imagePaths = extractImagePaths(options?.contentBlocks, options?.uploadDir);
    const exactPrompt = appendLocalImagePathHints(prompt, imagePaths);
    const runtime = readRuntimeConfig(options?.callbackEnv, options?.accountEnv, readOnly);
    const preparedRequest: PreparedProviderRequestV1 = Object.freeze({
      v: 1,
      message: Object.freeze({ body: exactPrompt }),
      nativeInstructions: Object.freeze(runtime.nativeInstructions.map((entry) => Object.freeze(entry))),
      runtime: Object.freeze({
        provider: 'opencode',
        carrier: 'server',
        ...(model ? { model } : {}),
        protocol: 'http+sse',
        ...(readOnly ? { toolExecutionPolicy: 'read_only' as const } : {}),
      }),
      tools: Object.freeze({
        finalSurface: readOnly ? ('exact' as const) : ('declared_only' as const),
        declaredServerNames: Object.freeze(readOnly ? [] : Object.keys(record(runtime.config.mcp) ?? {})),
        ...(readOnly ? { catCafeSchemas: Object.freeze([]) } : {}),
      }),
      providerNativeVisibility: 'unknown',
    });
    await options?.beforeProviderLaunch?.(preparedRequest);
    if (!('body' in preparedRequest.message)) throw new Error('opencode_server_prepared_message_not_exact');

    const metadata: MessageMetadata = { provider: 'opencode', model };
    const directory = options?.workingDirectory;
    const streamAbort = new AbortController();
    const abort = () => {
      streamAbort.abort(options?.signal?.reason);
    };
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted) abort();

    let sessionId = options?.sessionId;
    let releaseDispatch: (() => void) | undefined;
    let active = true;
    let latestMessageId = `msg_${randomUUID()}`;
    let latestMessageSeen = false;
    const textByPart = new Map<string, string>();
    const messageRoles = new Map<string, string>();
    const emittedTools = new Set<string>();
    const completedUsageMessages = new Set<string>();

    const sendPrompt = async (text: string, messageId: string): Promise<void> => {
      if (!sessionId) throw new Error('opencode_server_session_unavailable');
      latestMessageId = messageId;
      latestMessageSeen = false;
      await this.host.request(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        method: 'POST',
        directory,
        body: promptBody(text, model, messageId, readOnly),
      });
    };

    try {
      await this.host.ensureStarted();
      await this.host.request('/config', { method: 'PATCH', directory, body: runtime.config });
      if (sessionId) {
        await this.host.request(`/session/${encodeURIComponent(sessionId)}`, { directory });
      } else {
        const created = record(
          await this.host.request('/session', {
            method: 'POST',
            directory,
            body: { title: `Clowder AI · ${this.catId as string}` },
          }),
        );
        if (typeof created?.id !== 'string') throw new Error('opencode_server_session_create_invalid');
        sessionId = created.id;
      }
      metadata.sessionId = sessionId;
      yield { type: 'session_init', catId: this.catId, sessionId, metadata, timestamp: Date.now() };
      const activeSessionId = sessionId;

      const eventStream = await this.host.openEvents(directory, streamAbort.signal);
      if (options?.activeRunDispatch && options.invocationId) {
        const invocationId = options.activeRunDispatch.invocationId;
        const handle: AgentClientActiveRunHandle = {
          provider: 'opencode',
          carrier: 'opencode_server',
          threadId: activeSessionId,
          turnId: latestMessageId,
        };
        const release = options.activeRunDispatch.register({
          invocationId,
          capabilities: { append: true, steer: true },
          handle,
          dispatch: async (dispatchInput, dispatchOptions) => {
            if (dispatchOptions.expectedInvocationId !== invocationId) {
              return { accepted: false, reason: 'active_run_mismatch' };
            }
            if (!active) return { accepted: false, reason: 'active_run_closed' };
            const text = appendLocalImagePathHints(dispatchInput.text.trim(), dispatchInput.imagePaths ?? []);
            if (!text) return { accepted: false, reason: 'invalid_input' };
            try {
              if (dispatchOptions.force) {
                latestMessageSeen = false;
                await this.host.request(`/session/${encodeURIComponent(activeSessionId)}/abort`, {
                  method: 'POST',
                  directory,
                });
              }
              await sendPrompt(text, `msg_${randomUUID()}`);
              return { accepted: true, handle };
            } catch (err) {
              log.warn({ err, invocationId }, 'OpenCode server active-run dispatch rejected');
              return { accepted: false, reason: 'provider_rejected' };
            }
          },
        });
        if (typeof release === 'function') releaseDispatch = release;
      }

      await sendPrompt(preparedRequest.message.body, latestMessageId);
      for await (const event of eventStream) {
        if (eventSessionId(event) !== sessionId) continue;
        const properties = record(event.properties);
        const type = event.type;
        const info = record(properties?.info);
        const part = record(properties?.part);
        const eventMessageId =
          typeof properties?.messageID === 'string'
            ? properties.messageID
            : typeof part?.messageID === 'string'
              ? part.messageID
              : typeof info?.id === 'string'
                ? info.id
                : undefined;
        if (eventMessageId === latestMessageId) latestMessageSeen = true;
        if (type === 'message.updated' && typeof info?.id === 'string' && typeof info.role === 'string') {
          messageRoles.set(info.id, info.role);
        }

        if (type === 'message.part.delta' && properties?.field === 'text' && typeof properties.delta === 'string') {
          if (!eventMessageId || messageRoles.get(eventMessageId) !== 'assistant') continue;
          const partId = typeof properties.partID === 'string' ? properties.partID : 'unknown';
          textByPart.set(partId, `${textByPart.get(partId) ?? ''}${properties.delta}`);
          yield {
            type: 'text',
            catId: this.catId,
            content: properties.delta,
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }
        if (type === 'message.part.updated' && part?.type === 'text' && typeof part.text === 'string') {
          if (!eventMessageId || messageRoles.get(eventMessageId) !== 'assistant') continue;
          const partId = typeof part.id === 'string' ? part.id : 'unknown';
          const previous = textByPart.get(partId) ?? '';
          const delta = part.text.startsWith(previous) ? part.text.slice(previous.length) : part.text;
          textByPart.set(partId, part.text);
          if (delta) {
            yield { type: 'text', catId: this.catId, content: delta, metadata, timestamp: Date.now() };
          }
          continue;
        }
        if (type === 'message.part.updated' && part?.type === 'tool' && typeof part.id === 'string') {
          if (!eventMessageId || messageRoles.get(eventMessageId) !== 'assistant') continue;
          if (emittedTools.has(part.id)) continue;
          const state = record(part.state);
          if (state?.status !== 'running' && state?.status !== 'completed' && state?.status !== 'error') continue;
          emittedTools.add(part.id);
          yield {
            type: 'tool_use',
            catId: this.catId,
            toolName: typeof part.tool === 'string' ? part.tool : 'unknown',
            toolInput: record(state.input) ?? {},
            ...(typeof part.callID === 'string' ? { toolUseId: part.callID } : {}),
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }
        if (type === 'message.updated' && info?.role === 'assistant' && typeof info.id === 'string') {
          const time = record(info.time);
          const tokens = record(info.tokens);
          if (time?.completed !== undefined && tokens && !completedUsageMessages.has(info.id)) {
            completedUsageMessages.add(info.id);
            const cache = record(tokens.cache);
            metadata.usage = {
              ...(typeof tokens.input === 'number'
                ? { inputTokens: tokens.input, lastTurnInputTokens: tokens.input }
                : {}),
              ...(typeof tokens.output === 'number' ? { outputTokens: tokens.output } : {}),
              ...(typeof tokens.total === 'number' ? { totalTokens: tokens.total } : {}),
              ...(typeof cache?.read === 'number' && cache.read > 0 ? { cacheReadTokens: cache.read } : {}),
              ...(typeof cache?.write === 'number' && cache.write > 0 ? { cacheCreationTokens: cache.write } : {}),
              ...(typeof info.cost === 'number' ? { costUsd: info.cost } : {}),
            };
            yield { type: 'agent_loop', catId: this.catId, metadata, timestamp: Date.now() };
          }
          if (info.error) {
            yield {
              type: 'error',
              catId: this.catId,
              error: errorMessage(info.error),
              metadata,
              timestamp: Date.now(),
            };
          }
          continue;
        }
        if (type === 'session.compacted') {
          yield {
            type: 'provider_signal',
            catId: this.catId,
            content: JSON.stringify({ type: 'compact_boundary', catId: this.catId }),
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }
        if (type === 'session.error') {
          yield {
            type: 'error',
            catId: this.catId,
            error: errorMessage(properties?.error),
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }
        if (type === 'session.idle' && latestMessageSeen) break;
      }
    } catch (err) {
      if (!streamAbort.signal.aborted) {
        yield {
          type: 'error',
          catId: this.catId,
          error: err instanceof Error ? err.message : String(err),
          metadata,
          timestamp: Date.now(),
        };
      }
    } finally {
      active = false;
      releaseDispatch?.();
      streamAbort.abort();
      options?.signal?.removeEventListener('abort', abort);
    }
    yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
  }
}
