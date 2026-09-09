import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';

const log = createModuleLogger('opencode-server-host');
const OPENCODE_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const OPENCODE_SERVER_HEALTH_TIMEOUT_MS = 1_000;

export interface OpenCodeServerRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly directory?: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export interface OpenCodeServerHostLike {
  ensureStarted(): Promise<void>;
  request(path: string, options?: OpenCodeServerRequestOptions): Promise<unknown>;
  openEvents(directory: string | undefined, signal: AbortSignal): Promise<AsyncIterable<Record<string, unknown>>>;
  close(): Promise<void>;
}

function withDirectory(baseUrl: string, path: string, directory?: string): string {
  const url = new URL(path, baseUrl);
  if (directory) url.searchParams.set('directory', directory);
  return url.toString();
}

async function reserveEphemeralPort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('opencode_server_ephemeral_port_unavailable'));
        return;
      }
      server.close((err) => (err ? reject(err) : resolvePort(address.port)));
    });
  });
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const payload = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!payload) continue;
        try {
          const event = JSON.parse(payload) as unknown;
          if (event && typeof event === 'object') yield event as Record<string, unknown>;
        } catch (err) {
          log.warn({ err }, 'Ignored malformed OpenCode SSE event');
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

export class OpenCodeServerHost implements OpenCodeServerHostLike {
  private child: ChildProcess | undefined;
  private baseUrl: string | undefined;
  private startPromise: Promise<void> | undefined;

  async ensureStarted(): Promise<void> {
    if (this.child && this.baseUrl && this.child.exitCode === null) return;
    this.startPromise ??= this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async start(): Promise<void> {
    const command = resolveCliCommand('opencode');
    if (!command) throw new Error(formatCliNotFoundError('opencode'));
    const port = await reserveEphemeralPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn(command, ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs'], {
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child = child;
    this.baseUrl = baseUrl;
    child.stderr?.on('data', (chunk) => log.debug({ output: String(chunk).trim() }, 'OpenCode server'));
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.baseUrl = undefined;
      log.info({ code, signal }, 'OpenCode server host exited');
    });
    child.once('error', (err) => log.error({ err }, 'OpenCode server host failed'));

    const deadline = Date.now() + 10_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`opencode_server_exited_before_ready:${child.exitCode}`);
      try {
        const response = await fetch(`${baseUrl}/global/health`, {
          signal: AbortSignal.timeout(OPENCODE_SERVER_HEALTH_TIMEOUT_MS),
        });
        if (response.ok) return;
        lastError = new Error(`health_http_${response.status}`);
      } catch (err) {
        lastError = err;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    await this.close();
    throw new Error(
      `opencode_server_start_timeout:${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  async request(path: string, options: OpenCodeServerRequestOptions = {}): Promise<unknown> {
    await this.ensureStarted();
    if (!this.baseUrl) throw new Error('opencode_server_not_started');
    const timeoutSignal = AbortSignal.timeout(OPENCODE_SERVER_REQUEST_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(withDirectory(this.baseUrl, path, options.directory), {
      method: options.method ?? 'GET',
      headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`opencode_server_http_${response.status}${detail ? `:${detail}` : ''}`);
    }
    if (response.status === 204) return undefined;
    const text = await response.text();
    return text ? (JSON.parse(text) as unknown) : undefined;
  }

  async openEvents(
    directory: string | undefined,
    signal: AbortSignal,
  ): Promise<AsyncIterable<Record<string, unknown>>> {
    await this.ensureStarted();
    if (!this.baseUrl) throw new Error('opencode_server_not_started');
    const response = await fetch(withDirectory(this.baseUrl, '/event', directory), {
      headers: { accept: 'text/event-stream' },
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`opencode_server_event_http_${response.status}`);
    return parseSse(response.body);
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.baseUrl = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolveClose) => {
      const timeout = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolveClose();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolveClose();
      });
    });
  }
}

export type OpenCodeServerHostRegistry = Map<string, OpenCodeServerHost>;

export function getOrCreateOpenCodeServerHost(
  registry: OpenCodeServerHostRegistry,
  profileId: string,
): OpenCodeServerHost {
  const existing = registry.get(profileId);
  if (existing) return existing;
  const host = new OpenCodeServerHost();
  registry.set(profileId, host);
  return host;
}

export async function closeStaleOpenCodeServerHosts(
  registry: OpenCodeServerHostRegistry,
  activeProfileIds: ReadonlySet<string>,
): Promise<void> {
  for (const [profileId, host] of registry) {
    if (activeProfileIds.has(profileId)) continue;
    registry.delete(profileId);
    await host.close();
  }
}
