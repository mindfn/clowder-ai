/**
 * F140: First-Run Quest routes.
 * GET  /api/first-run/available-clients  — detect installed CLI clients
 * GET  /api/first-run/quest              — get current quest thread
 * POST /api/first-run/quest              — create quest thread
 * POST /api/first-run/connectivity-test  — probe provider API connectivity
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { resolveByAccountRef } from '../config/account-resolver.js';
import { detectAvailableClients } from '../domains/cats/services/first-run-quest/client-detection.js';
import type { FirstRunQuestStateV1, IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { probeApiKey } from '../utils/api-key-probe.js';
import { resolveUserId } from '../utils/request-identity.js';

const execAsync = promisify(exec);

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

/**
 * CLI commands for non-interactive connectivity probe.
 *
 * claude `-p` is a mode flag (not prompt value) and reads from stdin when piped,
 * so we use `echo … | claude -p`. Other CLIs take the prompt as a direct argument.
 */
const CLI_PROBE_CMD: Record<string, (model?: string) => string> = {
  claude: (m) => `echo "reply pong" | claude -p${m ? ` --model ${m}` : ''} --max-budget-usd 0.05`,
  codex: (m) => `codex exec${m ? ` --model ${m}` : ''} "reply pong"`,
  gemini: (m) => `gemini -p "reply pong"${m ? ` --model ${m}` : ''}`,
  opencode: (m) => `opencode run${m ? ` --model ${m}` : ''} "reply pong"`,
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

type ExecFn = (cmd: string, opts: { timeout: number }) => Promise<{ stdout: string }>;

export interface CliProbeOptions {
  model?: string;
  execFn?: ExecFn;
}

export async function tryCliProbe(
  client: string,
  opts: CliProbeOptions = {},
): Promise<{ ok: boolean; message: string } | null> {
  const { model, execFn = execAsync } = opts;
  if (!Object.hasOwn(CLI_PROBE_CMD, client)) return null;
  const buildCmd = CLI_PROBE_CMD[client];
  if (model && !SAFE_MODEL_RE.test(model)) {
    return { ok: false, message: '模型名称包含非法字符' };
  }
  const cmd = buildCmd(model);
  try {
    const { stdout } = await execFn(cmd, { timeout: 30_000 });
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
      return { ok: false, message: `${client} CLI 无响应` };
    }
    /* Budget / rate-limit text in stdout also proves connectivity (exit code 0 path) */
    if (CLI_OK_PATTERNS.some((re) => re.test(trimmed))) {
      return { ok: true, message: `${client} CLI 连接正常（受限响应）` };
    }
    /* Guard against false positives: error text in stdout with exit code 0 */
    if (STDOUT_ERROR_PATTERNS.some((re) => re.test(trimmed))) {
      return { ok: false, message: `${client} CLI 异常: ${trimmed.slice(0, 80)}` };
    }
    return { ok: true, message: `${client} CLI 连接正常` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string }).stderr ?? '';
    /* Budget / rate-limit errors prove the CLI authenticated and reached the API */
    if (CLI_OK_PATTERNS.some((re) => re.test(msg) || re.test(stderr))) {
      return { ok: true, message: `${client} CLI 连接正常（受限响应）` };
    }
    /* Process killed (timeout) — treat as failure unless stderr proved connectivity above */
    if ((err as { code?: number | null }).code === null) {
      return { ok: false, message: `${client} CLI 响应超时` };
    }
    if (msg.includes('authentication') || msg.includes('login') || msg.includes('OAuth')) {
      return { ok: false, message: '需要先完成 OAuth 登录，请在终端运行一次 CLI' };
    }
    return { ok: false, message: `${client} CLI 调用失败: ${msg.slice(0, 100)}` };
  }
}

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
    /* Cat is already created by the wizard before this endpoint is called,
       so start at quest-2 (cat intro) instead of quest-1 (create cat). */
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
   * - Builtin/OAuth profiles → CLI probe (tryCliProbe)
   * - API-key profiles → direct probe via api-key-probe utility
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

    /* Builtin/OAuth profiles: use CLI probe — the CLI handles its own auth */
    if (runtime.authType === 'oauth') {
      if (clientName) {
        const cliResult = await tryCliProbe(clientName, { model });
        if (cliResult) return cliResult;
      }
      return { ok: false, message: '内置认证需要通过 CLI 验证，请确认 CLI 已登录' };
    }

    /* API-key profiles: direct probe using resolved runtime credentials */
    if (!runtime.baseUrl || !runtime.apiKey) {
      return { ok: false, error: 'API Key 账号缺少 baseUrl 或 apiKey，请编辑补全' };
    }
    return probeApiKey(runtime.baseUrl, runtime.apiKey, { model, clientId });
  });
};
