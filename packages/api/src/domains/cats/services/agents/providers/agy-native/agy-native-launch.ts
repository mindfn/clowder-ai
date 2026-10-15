import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { AgyProfileConfig, CatId, NativeSessionBinding } from '@cat-cafe/shared';
import { resolveCliCommand } from '../../../../../../utils/cli-resolve.js';
import type { CliSpawnOptions } from '../../../../../../utils/cli-types.js';
import { findMonorepoRoot } from '../../../../../../utils/monorepo-root.js';
import type { AgentServiceOptions, PreparedProviderRequestV1 } from '../../../types.js';
import { preflightAgyProfile, resolveAgyProfile, resolveAgySpawnCwd } from '../agy-profile-manager.js';
import { encodeAgyStreamJsonUserMessage } from '../agy-stream-json-parser.js';
import { resolveProviderMcpConfig } from '../provider-mcp-config.js';
import { materializeAgyNativeAgentFile } from './agy-native-agent-file.js';
import { prepareAgyNativeCredentialFile } from './agy-native-credential-file.js';
import { materializeAgyNativeEffectGuard } from './agy-native-effect-guard.js';
import { AgyNativeResumeMismatchError } from './agy-native-errors.js';
import { prepareAgyNativeInput } from './agy-native-input.js';
import { materializeAgyNativeMcpConfig } from './agy-native-mcp-config.js';
import { type AgyNativePermissionMode, buildAgyNativePolicy } from './agy-native-policy.js';
import { acquireAgyNativeProfileTurn, waitForAgyNativeProfileTurn } from './agy-native-profile-turn.js';
import { materializeAgyNativeSettings } from './agy-native-settings.js';
import { materializeAgyNativeSkills } from './agy-native-skills.js';
import { AGY_NATIVE_MCP_TOOLS } from './agy-native-tools.js';

export interface AgyNativeLaunchInput {
  readonly catId: CatId;
  readonly model: string;
  readonly profileConfig: AgyProfileConfig;
  readonly workspace: string;
  readonly prompt: string;
  readonly body: string;
  readonly command?: string;
  readonly options?: AgentServiceOptions;
  readonly controlOperation?: 'compact';
}

export interface AgyNativeLaunchPlan {
  readonly cliOptions: CliSpawnOptions & { readonly cwd: string };
  readonly preparedRequest: PreparedProviderRequestV1;
  readonly agentName: string;
  readonly permissionMode: AgyNativePermissionMode;
  readonly agentTools: readonly string[];
  readonly binding: Omit<NativeSessionBinding, 'cliSessionId'>;
  readonly resumeSessionId?: string;
  readonly disposeCredentials?: () => void;
}

function assertNoUntrustedProfilePrograms(home: string): void {
  for (const executable of ['plugins', 'skills.json']) {
    if (existsSync(join(home, '.gemini', 'config', executable))) {
      throw new Error(`AGY native profile has unvalidated executable config: ${executable}`);
    }
  }
}

function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isolatedOAuthEnv(home: string): Record<string, string | null> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    TERM: 'dumb',
    // Managed invocations must not mutate the installed carrier in the background.
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    HOME: home,
    GEMINI_HOME: join(home, '.gemini'),
    XDG_CONFIG_HOME: join(home, '.config'),
    GEMINI_API_KEY: null,
    GOOGLE_API_KEY: null,
    GOOGLE_GENAI_USE_VERTEXAI: null,
    GOOGLE_APPLICATION_CREDENTIALS: null,
    GOOGLE_CLOUD_PROJECT: null,
    GOOGLE_CLOUD_LOCATION: null,
    CAT_CAFE_AGENT_KEY_SECRET: null,
    CAT_CAFE_AGENT_KEY_FILE: null,
    CAT_CAFE_AGENT_KEY_FILES: null,
    CAT_CAFE_READONLY_AGENT_KEY_UNION: null,
    CAT_CAFE_API_URL: null,
    CAT_CAFE_INVOCATION_ID: null,
    CAT_CAFE_CALLBACK_TOKEN: null,
    CAT_CAFE_CREDENTIAL_FILE: null,
    CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE: null,
    CAT_CAFE_DESKTOP_MODE: null,
    CAT_CAFE_MCP_PROFILE: null,
    CAT_CAFE_READONLY: null,
    CAT_CAFE_DEPLOYMENT_ID: process.env.CAT_CAFE_DEPLOYMENT_ID ?? null,
    CAT_CAFE_RUNTIME_ROOT: process.env.CAT_CAFE_RUNTIME_ROOT ?? null,
    CAT_CAFE_HOST_NODE_ID: process.env.CAT_CAFE_HOST_NODE_ID ?? null,
  };
}

function executionOwnerEnv(options?: AgentServiceOptions): Record<string, string> {
  const context = options?.auditContext;
  if (!context) return {};
  return {
    CAT_CAFE_EXECUTION_ID: context.executionId ?? context.invocationId,
    CAT_CAFE_INVOCATION_ID: context.invocationId,
    CAT_CAFE_THREAD_ID: context.threadId,
    CAT_CAFE_CAT_ID: context.catId,
    CAT_CAFE_USER_ID: context.userId,
  };
}

function assertOperatorTrustedWorkspace(config: AgyProfileConfig, workspaceRoot: string): void {
  const trusted = config.trustedWorkspaces?.some((path) => {
    if (!isAbsolute(path)) return false;
    try {
      return realpathSync(path) === workspaceRoot;
    } catch {
      return false;
    }
  });
  if (!trusted) throw new Error('AGY native workspace is outside the operator trusted workspace list');
}

async function materializeTaskMcp(
  home: string,
  input: AgyNativeLaunchInput,
  callbackEnv?: Readonly<Record<string, string>>,
): Promise<(() => void) | undefined> {
  const ordinary = input.options?.toolExecutionPolicy?.mode !== 'read_only';
  const credential = ordinary && callbackEnv ? prepareAgyNativeCredentialFile(home, callbackEnv ?? {}) : undefined;
  try {
    const runtimeRoot = findMonorepoRoot(process.cwd());
    const resolvedServers =
      ordinary && credential
        ? await resolveProviderMcpConfig({
            callbackEnv: { ...callbackEnv, CAT_CAFE_CAT_ID: input.catId },
            workingDirectory: input.workspace,
            mcpServerPath: join(runtimeRoot, 'packages/mcp-server/dist/index.js'),
            credentialFile: credential.path,
            provider: 'google',
          })
        : undefined;
    materializeAgyNativeMcpConfig({
      profileHome: home,
      runtimeRoot,
      serverNames: resolvedServers ? Object.keys(resolvedServers) : [],
      ...(resolvedServers ? { resolvedServers } : {}),
      ...(credential ? { callback: { apiUrl: credential.apiUrl, credentialFile: credential.path } } : {}),
    });
    return credential?.dispose;
  } catch (error) {
    credential?.dispose();
    throw error;
  }
}

/** Prepare the ordinary native tool surface with canonical MCP identity and resume provenance. */
export async function prepareAgyNativeLaunch(input: AgyNativeLaunchInput): Promise<AgyNativeLaunchPlan> {
  const options = input.options;
  const policy = buildAgyNativePolicy({
    workspaceRoot: input.workspace,
    autoApprove: input.profileConfig.autoApprove,
    readOnly: options?.toolExecutionPolicy?.mode === 'read_only',
  });
  if (policy.permissionMode !== 'always-proceed')
    assertOperatorTrustedWorkspace(input.profileConfig, policy.workspaceRoot);
  const profile = resolveAgyProfile({
    materializeSettings: false,
    catId: input.catId,
    expectedModel: input.model,
    workingDirectory: policy.workspaceRoot,
    config: input.profileConfig,
  });
  if (!profile) throw new Error('AGY native isolated profile is disabled');
  const home = realpathSync(profile.homePath);
  if (containsPath(home, policy.workspaceRoot) || containsPath(policy.workspaceRoot, home)) {
    throw new Error('AGY native profile HOME overlaps the model-readable workspace');
  }
  assertNoUntrustedProfilePrograms(home);
  const ownerInvocationId = options?.auditContext?.invocationId ?? options?.invocationId;
  const releaseProfile = input.controlOperation
    ? acquireAgyNativeProfileTurn(home, ownerInvocationId)
    : await waitForAgyNativeProfileTurn(home, ownerInvocationId, options?.signal);
  let disposeCredentials: (() => void) | undefined;
  try {
    const agent = materializeAgyNativeAgentFile({
      profileHome: home,
      catId: input.catId,
      systemPrompt: input.body,
      autoApprove: policy.permissionMode === 'always-proceed',
      tools: policy.agentTools,
    });
    materializeAgyNativeSettings({ profileHome: home, model: input.model, policy });
    materializeAgyNativeEffectGuard({
      profileHome: home,
      runtimeRoot: findMonorepoRoot(process.cwd()),
      readOnly: options?.toolExecutionPolicy?.mode === 'read_only',
    });
    const command = input.command ?? resolveCliCommand('agy');
    if (!command) throw new Error('AGY native CLI binary was not found');
    const profilePreflight = preflightAgyProfile(profile, {
      agyCommand: command,
      workingDirectory: policy.workspaceRoot,
    });
    if (!profilePreflight.ok) throw new Error(profilePreflight.message);
    const prior = options?.nativeSessionBinding;
    const resume =
      Boolean(options?.sessionId) &&
      prior?.v === 1 &&
      prior.carrier === 'agy_stream_json' &&
      prior.cliSessionId === options?.sessionId &&
      prior.l0Hash === agent.l0Hash &&
      prior.agentName === agent.agentName &&
      prior.workspaceRoot === policy.workspaceRoot &&
      prior.profileHome === home &&
      prior.model === input.model &&
      prior.permissionMode === policy.permissionMode;
    if (options?.sessionId && !resume) {
      throw new AgyNativeResumeMismatchError(
        'Native session binding is missing or differs from the current identity, model, workspace, profile or permissions; start a new session explicitly',
      );
    }
    if (options?.requireExactResume && !options.sessionId) {
      throw new AgyNativeResumeMismatchError('Native exact resume requires a session ID');
    }
    const nativeInput = prepareAgyNativeInput(
      input.prompt,
      options?.contentBlocks,
      policy.workspaceRoot,
      options?.uploadDir,
    );
    const skillDirectories = await materializeAgyNativeSkills({
      profileHome: home,
      workspace: policy.workspaceRoot,
      runtimeRoot: findMonorepoRoot(process.cwd()),
    });
    const args = [
      '--add-dir',
      policy.workspaceRoot,
      ...nativeInput.accessDirectories.flatMap((directory) => ['--add-dir', directory]),
      ...skillDirectories.flatMap((directory) => ['--add-dir', directory]),
      ...policy.cliArgs,
      '--agent',
      agent.agentName,
      '--model',
      input.model,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      ...(resume && options?.sessionId ? ['--conversation', options.sessionId] : []),
    ];
    const preparedRequest: PreparedProviderRequestV1 = Object.freeze({
      v: 1,
      message: Object.freeze({
        body: nativeInput.prompt,
        ...(nativeInput.hasAttachments ? { injectionDecision: 'adapter_native_file_attachment_references' } : {}),
      }),
      nativeInstructions: Object.freeze([
        { body: readFileSync(agent.filePath, 'utf8'), injectionDecision: 'native_agent_file_compiled' },
      ]),
      runtime: Object.freeze({
        provider: 'google',
        carrier: 'antigravity_cli',
        model: input.model,
        protocol: 'stream-json',
      }),
      tools: Object.freeze({ finalSurface: 'unknown' as const }),
      providerNativeVisibility: 'unknown',
    });
    const cliOptions: CliSpawnOptions & { readonly cwd: string } = {
      command,
      args,
      cwd: resolveAgySpawnCwd(profile, input.catId, policy.workspaceRoot),
      env: { ...isolatedOAuthEnv(home), ...executionOwnerEnv(options) },
      inheritParentEnv: false,
      bindExecutionOwner: Boolean(options?.auditContext),
      stdinInput: `${encodeAgyStreamJsonUserMessage(nativeInput.prompt)}\n`,
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
      ...(options?.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
      ...(options?.parentSpan ? { parentSpan: options.parentSpan } : {}),
    };
    disposeCredentials = await materializeTaskMcp(home, input, options?.callbackEnv);
    return {
      cliOptions,
      preparedRequest,
      agentName: agent.agentName,
      permissionMode: policy.permissionMode,
      agentTools: [
        ...policy.agentTools,
        ...(input.options?.toolExecutionPolicy?.mode !== 'read_only' ? AGY_NATIVE_MCP_TOOLS : []),
      ],
      binding: {
        v: 1,
        carrier: 'agy_stream_json',
        model: input.model,
        profileHome: home,
        l0Hash: agent.l0Hash,
        workspaceRoot: policy.workspaceRoot,
        permissionMode: policy.permissionMode,
        agentName: agent.agentName,
      },
      ...(resume && options?.sessionId ? { resumeSessionId: options.sessionId } : {}),
      disposeCredentials: () => {
        try {
          disposeCredentials?.();
        } finally {
          releaseProfile();
        }
      },
    };
  } catch (error) {
    try {
      disposeCredentials?.();
    } finally {
      releaseProfile();
    }
    throw error;
  }
}
