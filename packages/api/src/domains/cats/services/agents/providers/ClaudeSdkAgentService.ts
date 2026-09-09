import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import {
  type Options as ClaudeSdkOptions,
  query as claudeQuery,
  type McpServerConfig,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type {
  AgentClientActiveRunHandle,
  AgentFreshnessCarrierCapability,
  AgentMessage,
  AgentService,
  AgentServiceOptions,
  MessageMetadata,
  PreparedProviderRequestV1,
  ToolExecutionPolicy,
} from '../../types.js';
import {
  ANTHROPIC_PROFILE_MODE_KEY,
  buildClaudeEnvOverrides,
  resolveClaudeEffortLevel,
  resolveClaudeModelSelection,
  resolveDefaultClaudeMcpServerPath,
  SUBSCRIPTION_MODE_DENY_KEYS,
} from './ClaudeAgentService.js';
import { resolveClaudeMcpConfig } from './claude-mcp-config.js';
import { extractClaudeUsage, transformClaudeEvent } from './claude-ndjson-parser.js';
import { appendLocalImagePathHints, collectImageAccessDirectories } from './image-cli-bridge.js';
import { extractImagePaths } from './image-paths.js';
import { compileL0ViaSubprocess } from './l0-compiler.js';

const log = createModuleLogger('claude-sdk-agent');

type ClaudeQueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: ClaudeSdkOptions }) => Query;

interface ClaudeSdkAgentServiceOptions {
  catId?: CatId;
  model?: string;
  mcpServerPath?: string;
  l0CompilerFn?: typeof compileL0ViaSubprocess;
  queryFn?: ClaudeQueryFn;
  activeRunControlTimeoutMs?: number;
}

const DEFAULT_ACTIVE_RUN_CONTROL_TIMEOUT_MS = 15_000;

async function withActiveRunControlDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('claude_sdk_active_run_control_timeout')), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class AsyncInputQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolveNext) => this.waiters.push(resolveNext));
      },
    };
  }
}

function toSdkEnvironment(overrides: Record<string, string | null>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

function createSdkUserMessage(text: string, sessionId: string, uuid = randomUUID()): SDKUserMessage {
  return {
    type: 'user',
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

/**
 * Claude's official Agent SDK carrier. Unlike `claude -p`, the SDK exposes a
 * streaming input channel and an explicit interrupt operation, so Append and
 * Steer are delivered to the exact active query without involving MCP tools.
 */
export class ClaudeSdkAgentService implements AgentService {
  readonly catId: CatId;
  private readonly model: string;
  private readonly mcpServerPath: string | undefined;
  private readonly l0CompilerFn: typeof compileL0ViaSubprocess;
  private readonly queryFn: ClaudeQueryFn;
  private readonly activeRunControlTimeoutMs: number;

  constructor(options?: ClaudeSdkAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('opus');
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.l0CompilerFn = options?.l0CompilerFn ?? compileL0ViaSubprocess;
    this.queryFn = options?.queryFn ?? claudeQuery;
    this.activeRunControlTimeoutMs = options?.activeRunControlTimeoutMs ?? DEFAULT_ACTIVE_RUN_CONTROL_TIMEOUT_MS;
    const configuredPath = options?.mcpServerPath ?? process.env.CAT_CAFE_MCP_SERVER_PATH;
    this.mcpServerPath = configuredPath
      ? isAbsolute(configuredPath)
        ? configuredPath
        : resolve(process.cwd(), configuredPath)
      : resolveDefaultClaudeMcpServerPath();
  }

  injectsL0Natively(): boolean {
    return true;
  }

  supportsToolExecutionPolicy(policy: ToolExecutionPolicy): boolean {
    return policy.mode === 'read_only';
  }

  freshnessCarrierCapability(): AgentFreshnessCarrierCapability {
    return { provider: 'anthropic', carrier: 'claude_agent_sdk', deliverySemantics: 'exact_active_turn' };
  }

  contextCapability(): import('../../types.js').AgentContextCapability {
    return {
      provider: 'anthropic',
      carrier: 'agent_sdk',
      reportsRuntimeWindow: true,
      authoritativeUsage: true,
      usageTelemetry: 'available',
      nativeWindowControl: false,
      nativeCompressionControl: false,
      observesCompression: true,
      reason: 'Claude Agent SDK streams native usage and compact-boundary events',
    };
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const readOnly = options?.toolExecutionPolicy?.mode === 'read_only';
    const imagePaths = extractImagePaths(options?.contentBlocks, options?.uploadDir);
    const effectivePrompt = appendLocalImagePathHints(prompt, imagePaths);
    const { effectiveModel, useEnvModelOverride } = resolveClaudeModelSelection(options?.callbackEnv, this.model);
    const effort = resolveClaudeEffortLevel(this.catId as string, effectiveModel, options?.reasoningEffortOverride);
    const l0 = await this.l0CompilerFn({ catId: this.catId as string, userId: options?.auditContext?.userId });
    const nativeInstructions: PreparedProviderRequestV1['nativeInstructions'] = [
      { body: l0, injectionDecision: 'native_l0_compiled' },
      ...(options?.systemPrompt
        ? [{ body: options.systemPrompt, injectionDecision: 'route_append_system_prompt' }]
        : []),
    ];
    const systemPrompt = nativeInstructions.map((entry) => entry.body).join('\n\n');
    const mcpResolution = readOnly
      ? undefined
      : await resolveClaudeMcpConfig({
          callbackEnv: options?.callbackEnv,
          workingDirectory: options?.workingDirectory,
          mcpServerPath: this.mcpServerPath,
        });
    const declaredServerNames = Object.keys(mcpResolution?.servers ?? {});
    const preparedRequest: PreparedProviderRequestV1 = Object.freeze({
      v: 1,
      message: Object.freeze({ body: effectivePrompt }),
      nativeInstructions: Object.freeze(nativeInstructions.map((entry) => Object.freeze(entry))),
      runtime: Object.freeze({
        provider: 'anthropic',
        carrier: 'agent_sdk',
        ...(effectiveModel ? { model: effectiveModel } : {}),
        protocol: 'sdk-streaming-input',
        reasoningEffort: effort,
        ...(readOnly ? { toolExecutionPolicy: 'read_only' as const } : {}),
      }),
      tools: Object.freeze({
        finalSurface: readOnly ? ('exact' as const) : ('declared_only' as const),
        declaredServerNames: Object.freeze(readOnly ? [] : declaredServerNames),
        ...(readOnly ? { catCafeSchemas: Object.freeze([]) } : {}),
      }),
      providerNativeVisibility: 'unknown',
    });
    await options?.beforeProviderLaunch?.(preparedRequest);
    if (!('body' in preparedRequest.message)) throw new Error('claude_sdk_prepared_message_not_exact');

    const envOverrides = buildClaudeEnvOverrides(options?.callbackEnv);
    if (options?.accountEnv) {
      for (const [key, value] of Object.entries(options.accountEnv)) envOverrides[key] = value;
    }
    if (options?.callbackEnv?.[ANTHROPIC_PROFILE_MODE_KEY] === 'subscription') {
      for (const key of SUBSCRIPTION_MODE_DENY_KEYS) envOverrides[key] = null;
    }
    if (readOnly) envOverrides.CAT_CAFE_READONLY = 'true';

    const abortController = new AbortController();
    const abort = () => abortController.abort(options?.signal?.reason);
    options?.signal?.addEventListener('abort', abort, { once: true });
    if (options?.signal?.aborted) abort();

    const input = new AsyncInputQueue<SDKUserMessage>();
    let activeSessionId = options?.sessionId ?? '';
    const initialMessageId = randomUUID();
    const sdkOptions: ClaudeSdkOptions = {
      abortController,
      ...(options?.workingDirectory ? { cwd: options.workingDirectory } : {}),
      env: toSdkEnvironment(envOverrides),
      ...(imagePaths.length > 0 ? { additionalDirectories: collectImageAccessDirectories(imagePaths) } : {}),
      ...(useEnvModelOverride || !effectiveModel ? {} : { model: effectiveModel }),
      systemPrompt,
      includePartialMessages: true,
      permissionMode: readOnly ? 'plan' : 'bypassPermissions',
      ...(readOnly ? { tools: [] } : {}),
      ...(!readOnly ? { allowDangerouslySkipPermissions: true } : {}),
      settingSources:
        options?.callbackEnv?.[ANTHROPIC_PROFILE_MODE_KEY] === 'api_key'
          ? ['project', 'local']
          : ['user', 'project', 'local'],
      ...(options?.sessionId ? { resume: options.sessionId } : {}),
      ...(readOnly ? { mcpServers: {}, strictMcpConfig: true } : {}),
      ...(!readOnly && mcpResolution
        ? { mcpServers: mcpResolution.servers as Record<string, McpServerConfig>, strictMcpConfig: true }
        : {}),
      extraArgs: { effort },
    };

    const metadata: MessageMetadata = { provider: 'anthropic', model: effectiveModel };
    const streamState = {
      currentMessageId: undefined as string | undefined,
      partialTextMessageIds: new Set<string>(),
      lastTurnInputTokens: undefined as number | undefined,
      thinkingBuffer: '',
    };
    let query: Query | undefined;
    let releaseDispatch: (() => void) | undefined;
    let active = true;
    let dispatcherRegistered = false;

    const registerDispatcher = () => {
      if (dispatcherRegistered || !options?.activeRunDispatch || !options.invocationId || !activeSessionId) return;
      dispatcherRegistered = true;
      const invocationId = options.activeRunDispatch.invocationId;
      const handle: AgentClientActiveRunHandle = {
        provider: 'anthropic',
        carrier: 'claude_agent_sdk',
        threadId: activeSessionId,
        turnId: initialMessageId,
      };
      const release = options.activeRunDispatch.register({
        invocationId,
        capabilities: { append: true, steer: true },
        handle,
        dispatch: async (dispatchInput, dispatchOptions) => {
          if (dispatchOptions.expectedInvocationId !== invocationId) {
            return { accepted: false, reason: 'active_run_mismatch' };
          }
          if (!active || !query) return { accepted: false, reason: 'active_run_closed' };
          const text = appendLocalImagePathHints(dispatchInput.text.trim(), dispatchInput.imagePaths ?? []);
          if (!text) return { accepted: false, reason: 'invalid_input' };
          try {
            if (dispatchOptions.force) {
              await withActiveRunControlDeadline(query.interrupt(), this.activeRunControlTimeoutMs);
            }
            const accepted = input.push(createSdkUserMessage(text, activeSessionId));
            return accepted ? { accepted: true, handle } : { accepted: false, reason: 'active_run_closed' };
          } catch (err) {
            log.warn({ err, invocationId }, 'Claude SDK active-run dispatch rejected');
            return { accepted: false, reason: 'provider_rejected' };
          }
        },
      });
      if (typeof release === 'function') releaseDispatch = release;
    };

    try {
      query = this.queryFn({ prompt: input, options: sdkOptions });
      input.push(createSdkUserMessage(preparedRequest.message.body, activeSessionId, initialMessageId));
      for await (const event of query as AsyncIterable<SDKMessage>) {
        const raw = event as unknown as Record<string, unknown>;
        if (typeof raw.session_id === 'string' && raw.session_id) {
          activeSessionId = raw.session_id;
          metadata.sessionId = raw.session_id;
          registerDispatcher();
        }
        if (raw.type === 'result') {
          metadata.usage = extractClaudeUsage(raw);
          if (streamState.lastTurnInputTokens != null && metadata.usage) {
            metadata.usage.lastTurnInputTokens = streamState.lastTurnInputTokens;
          }
        }
        const transformed = transformClaudeEvent(event, this.catId, streamState);
        if (!transformed) continue;
        for (const message of Array.isArray(transformed) ? transformed : [transformed]) {
          yield { ...message, metadata };
        }
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
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
      input.close();
      releaseDispatch?.();
      options?.signal?.removeEventListener('abort', abort);
    }
    yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
  }
}
