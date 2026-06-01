/**
 * F171: First-Run Quest routes.
 * GET  /api/first-run/available-clients  — detect installed CLI clients
 * GET  /api/first-run/quest              — get current quest thread
 * POST /api/first-run/quest              — create quest thread
 * POST /api/first-run/connectivity-test  — probe provider API connectivity
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { builtinAccountIdForClient, type ClientId, protocolForClient } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { resolveByAccountRef } from '../config/account-resolver.js';
import { detectAvailableClients } from '../domains/cats/services/first-run-quest/client-detection.js';
import type { FirstRunQuestStateV1, IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { resolveCliCommand } from '../utils/cli-resolve.js';
import { resolveWindowsSpawnPlan } from '../utils/cli-spawn-win.js';
import { resolveUserId } from '../utils/request-identity.js';

const IS_WINDOWS = process.platform === 'win32';

interface FirstRunQuestRoutesOptions {
  threadStore: IThreadStore;
}

const createQuestSchema = z.object({
  firstCatId: z.string().min(1).optional(),
  firstCatName: z.string().min(1).optional(),
});

const connectivityTestSchema = z.object({
  profileId: z.string().min(1),
  /** Client ID for account binding (anthropic/openai/google) — NOT the CLI tool name. */
  clientId: z.string().min(1),
  client: z.string().optional(),
  /** When provided, forwarded to the test endpoint for model-specific probing. */
  model: z.string().optional(),
});

/* ── Spawn-based CLI probe ────────────────────────────────────────────── */

/** Structured probe spec: args array + optional stdin data. */
interface CliProbeSpec {
  args: (model?: string) => string[];
  /** Optional data piped to stdin before close. Most CLIs take prompt as a positional arg. */
  stdin?: string;
  /** Force spawn with shell: true. Claude CLI needs shell context to exit cleanly. */
  shell?: boolean;
}

/**
 * CLI probe specs — args for spawn-based invocation.
 * Uses the same spawn path as real conversation invocations:
 *   spawn() + resolveWindowsSpawnPlan() on Windows.
 */
const CLI_PROBE_SPECS: Record<string, CliProbeSpec> = {
  claude: {
    args: (m) => ['-p', ...(m ? ['--model', m] : []), '--max-budget-usd', '0.05'],
    stdin: 'reply pong',
    shell: true,
  },
  codex: {
    args: (m) => ['exec', ...(m ? ['--model', m] : []), 'reply pong'],
  },
  gemini: {
    args: (m) => ['-p', 'reply pong', ...(m ? ['--model', m] : [])],
  },
  kimi: {
    args: (m) => ['--print', ...(m ? ['--model', m] : []), '--prompt', 'reply pong'],
  },
  opencode: {
    args: (m) => ['run', '--format', 'json', ...(m ? ['--model', m] : []), 'reply pong'],
  },
};

/** Error patterns that prove the CLI authenticated and reached the API. */
const CLI_OK_PATTERNS = [
  /budget/i,
  /exceeded/i,
  /rate.?limit/i,
  /max.?tokens/i,
  /not.?supported/i,
  /invalid_request_error/i,
  /model.*(not|unsupported|unavailable)/i,
];

/** Stdout patterns that indicate failure despite exit code 0. */
const STDOUT_ERROR_PATTERNS = [/^error/i, /exception/i, /frozen/i, /unauthorized/i];

/** Model names must be safe for shell interpolation. */
const SAFE_MODEL_RE = /^[\w.\-/]+$/;

/** Probe timeout — CLI cold start (especially opencode) can be slow. */
const PROBE_TIMEOUT_MS = 120_000;

/** @internal Spawn function signature for dependency injection in tests. */
type ProbeSpawnFn = (
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; stdio?: readonly string[]; shell?: boolean | string },
) => ChildProcess;

export interface CliProbeOptions {
  model?: string;
  /** Extra env vars injected into the subprocess (e.g. API key credentials). */
  env?: Record<string, string>;
  /** @internal Test hook — overrides child_process.spawn for unit testing. */
  spawnFn?: ProbeSpawnFn;
}

/**
 * Probe CLI connectivity by spawning the CLI with the same mechanism used
 * in real conversation invocations (spawn + resolveWindowsSpawnPlan).
 *
 * This avoids the exec() → cmd.exe → .cmd shim chain that caused orphaned
 * processes and 30s timeouts on Windows (#802).
 */
export function tryCliProbe(
  client: string,
  opts: CliProbeOptions = {},
): Promise<{ ok: boolean; message: string } | null> {
  const spec = CLI_PROBE_SPECS[client];
  if (!spec) return Promise.resolve(null);

  const { model, env, spawnFn: customSpawn } = opts;
  if (model && !SAFE_MODEL_RE.test(model)) {
    return Promise.resolve({ ok: false, message: '模型名称包含非法字符' });
  }

  const cliArgs = spec.args(model);
  const spawnEnv: NodeJS.ProcessEnv =
    env && Object.keys(env).length > 0 ? { ...process.env, ...env } : { ...process.env };

  return new Promise((resolve) => {
    /* Resolve command + args via the same path as real invocations. */
    let command: string = resolveCliCommand(client) ?? client;
    let finalArgs = cliArgs;
    let shell: boolean | string | undefined;

    if (spec.shell) {
      /* Claude CLI needs shell context to exit cleanly (stdin pipe + shell
         environment). This matches the main-branch exec() behaviour. */
      shell = true;
    } else if (IS_WINDOWS) {
      const plan = resolveWindowsSpawnPlan(command, cliArgs);
      command = plan.command;
      finalArgs = plan.args;
      shell = plan.shell;
    }

    const doSpawn = customSpawn ?? spawn;
    const child = doSpawn(command, finalArgs, {
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(shell !== undefined ? { shell } : {}),
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (result: { ok: boolean; message: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
      settle({ ok: false, message: `${client} CLI 响应超时` });
    }, PROBE_TIMEOUT_MS);

    /* Pipe optional stdin data if spec provides it. */
    if (spec.stdin) {
      child.stdin?.write(spec.stdin);
    }
    child.stdin?.end();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      settle({ ok: false, message: `${client} CLI 启动失败: ${err.message.slice(0, 100)}` });
    });

    child.on('close', (code) => {
      const combined = stdout + stderr;

      /* Budget / rate-limit / model errors prove the CLI reached the API. */
      if (CLI_OK_PATTERNS.some((re) => re.test(combined))) {
        settle({ ok: true, message: `${client} CLI 连接正常（受限响应）` });
        return;
      }

      if (code === 0) {
        const trimmed = stdout.trim();
        if (!trimmed) {
          settle({ ok: false, message: `${client} CLI 无响应` });
          return;
        }
        if (STDOUT_ERROR_PATTERNS.some((re) => re.test(trimmed))) {
          settle({ ok: false, message: `${client} CLI 异常: ${trimmed.slice(0, 80)}` });
          return;
        }
        settle({ ok: true, message: `${client} CLI 连接正常` });
        return;
      }

      /* Non-zero exit: check for auth errors. */
      if (/authentication|login|OAuth/i.test(combined)) {
        settle({ ok: false, message: '需要先完成 OAuth 登录，请在终端运行一次 CLI' });
        return;
      }
      settle({ ok: false, message: `${client} CLI 调用失败 (exit ${code})` });
    });
  });
}

/* ── Route definitions ────────────────────────────────────────────────── */

export const firstRunQuestRoutes: FastifyPluginAsync<FirstRunQuestRoutesOptions> = async (app, opts) => {
  const { threadStore } = opts;

  /** Detect installed CLI clients on this machine. */
  app.get('/api/first-run/available-clients', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    const clients = await detectAvailableClients();
    return { clients };
  });

  /** Find the user's quest thread (most recent). */
  app.get('/api/first-run/quest', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    const threads = await threadStore.list(userId);
    const questThread = threads
      .filter((t) => t.firstRunQuestState)
      .sort((a, b) => (b.firstRunQuestState?.startedAt ?? 0) - (a.firstRunQuestState?.startedAt ?? 0))
      .at(0);
    if (!questThread) {
      return { quest: null };
    }
    return {
      quest: {
        threadId: questThread.id,
        state: questThread.firstRunQuestState,
      },
    };
  });

  /** Create a new quest thread. */
  app.post('/api/first-run/quest', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    const parsed = createQuestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const thread = await threadStore.create(userId, '新手教程');
    const initialState: FirstRunQuestStateV1 = {
      v: 1,
      phase: 'quest-2-cat-intro',
      startedAt: Date.now(),
      firstCatId: parsed.data.firstCatId,
      firstCatName: parsed.data.firstCatName,
    };
    await threadStore.updateFirstRunQuestState(thread.id, initialState);

    return {
      quest: {
        threadId: thread.id,
        state: initialState,
      },
    };
  });

  /**
   * Probe provider API connectivity for a given profile.
   * Uses spawn() with resolveWindowsSpawnPlan — same path as real invocations.
   */
  app.post('/api/first-run/connectivity-test', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { ok: false, error: 'Identity required' };
    }

    const parsed = connectivityTestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { ok: false, error: 'Invalid request body' };
    }

    const { profileId, clientId, client: clientName, model } = parsed.data;
    const projectRoot = resolveActiveProjectRoot();
    const runtime = resolveByAccountRef(projectRoot, profileId);

    if (!runtime) {
      reply.status(404);
      return { ok: false, error: '未找到该账号配置，请刷新后重试' };
    }

    /* Resolve CLI tool name: explicit `client` field > derived from clientId */
    const cliName = clientName ?? builtinAccountIdForClient(clientId as ClientId);
    if (!cliName) {
      return { ok: false, error: `未知的 client: ${clientId}` };
    }

    /* Reject explicitly if api_key account has no stored key. */
    if (runtime.authType === 'api_key' && !runtime.apiKey) {
      return { ok: false, error: '该账号未配置 API Key，请先填写密钥' };
    }

    /* Build env vars for API-key accounts so the CLI picks up credentials. */
    const probeEnv =
      runtime.authType === 'api_key' && runtime.apiKey
        ? buildProbeEnv(clientId, runtime.apiKey, runtime.baseUrl)
        : undefined;

    const result = await tryCliProbe(cliName, { model, env: probeEnv });
    if (result) return result;

    return { ok: true, skipped: true, message: `${cliName} 不支持连接探测，已跳过检测` };
  });
};

/** @internal Exported for testing only. */
export { buildProbeEnv };

/**
 * Build env vars that mirror production credential injection for each provider.
 */
function buildProbeEnv(clientId: string, apiKey: string, baseUrl?: string): Record<string, string> {
  const env: Record<string, string> = {};
  const protocol = protocolForClient(clientId as ClientId);

  switch (protocol) {
    case 'anthropic':
      env.ANTHROPIC_API_KEY = apiKey;
      if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl.replace(/\/v1\/?$/, '');
      break;
    case 'openai':
      env.OPENAI_API_KEY = apiKey;
      if (baseUrl) {
        env.OPENAI_BASE_URL = baseUrl;
        env.OPENAI_API_BASE = baseUrl;
      }
      break;
    case 'google':
      env.GEMINI_API_KEY = apiKey;
      env.GOOGLE_API_KEY = apiKey;
      if (baseUrl) env.GEMINI_BASE_URL = baseUrl;
      break;
    case 'kimi':
      env.MOONSHOT_API_KEY = apiKey;
      if (baseUrl) env.CAT_CAFE_KIMI_BASE_URL = baseUrl;
      break;
    default:
      env.API_KEY = apiKey;
      if (baseUrl) env.API_BASE_URL = baseUrl;
  }
  return env;
}
