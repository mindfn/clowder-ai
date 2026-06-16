/**
 * AcpHttpStreamClient — HTTP streaming transport for ACP agent processes.
 *
 * F161 Phase C: Spawn a child process that starts an HTTP ACP server (e.g.
 * `opencode acp --port 0`), discover the port from stdout, then communicate
 * via HTTP POST with NDJSON streaming responses.
 *
 * Same public API as AcpClient (stdio) so AcpProcessPool / AcpAgentService
 * work with either transport transparently.
 *
 * Key differences from stdio:
 *   - Process stdout is scanned for port discovery, not used for protocol messages
 *   - JSON-RPC requests go via HTTP POST to http://localhost:<port>/
 *   - Streaming responses (session/prompt) return NDJSON lines
 *   - session/cancel is a fire-and-forget HTTP POST
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';

import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import { resolveCliCommandOrBare } from '../../../../../../utils/cli-resolve.js';
import { resolveWindowsSpawnPlan } from '../../../../../../utils/cli-spawn-win.js';
import {
  type AcpCapacitySignal,
  type AcpClientConfig,
  AcpProtocolError,
  AcpStreamIdleError,
  AcpTimeoutError,
  buildAcpSpawnLogFields,
} from './AcpClient.js';
import type {
  AcpInitializeResult,
  AcpMcpServer,
  AcpNewSessionResult,
  AcpNotification,
  AcpPromptResult,
  AcpResponse,
  AcpSessionUpdate,
  AcpStopReason,
} from './types.js';
import { ACP_METHODS } from './types.js';

const log = createModuleLogger('acp-http-client');

const IS_WINDOWS = process.platform === 'win32';
const KILL_GRACE_MS = 3_000;
const PORT_DISCOVERY_TIMEOUT_MS = 30_000;

/** Regex to discover the HTTP port from process stdout.
 *  Matches common patterns: "Listening on port 12345", "port: 12345", '{"port":12345}' */
const PORT_RE = /(?:port[:\s]+|"port"\s*:\s*)(\d{4,5})/i;

const CAPACITY_RE = /MODEL_CAPACITY_EXHAUSTED|No capacity available|status 429.*Retrying/i;

// ─── HTTP streaming client config ────────────────────────────

export interface AcpHttpStreamClientConfig extends AcpClientConfig {
  /** Port discovery timeout (ms). Default 30s. */
  portDiscoveryTimeoutMs?: number;
}

// ─── Client ──────────────────────────────────────────────────

export class AcpHttpStreamClient {
  private child: ChildProcess | null = null;
  private closed = false;
  private exited = false;
  private port: number | null = null;
  private baseUrl = '';
  private initResult: AcpInitializeResult | null = null;
  private readonly capacityListeners = new Set<(signal: AcpCapacitySignal) => void>();
  private _recentCapacitySignal: AcpCapacitySignal | null = null;

  constructor(private readonly config: AcpHttpStreamClientConfig) {}

  // ── Lifecycle ────────────────────────────────────────────────

  async initialize(): Promise<AcpInitializeResult> {
    // Phase 1: spawn the process
    const doSpawn = this.config.spawnFn ?? nodeSpawn;
    let command = resolveCliCommandOrBare(this.config.command);
    let args = [...this.config.args];
    const childEnv = { ...process.env, ...this.config.env };
    if (!IS_WINDOWS && isAbsolute(command)) {
      const binDir = dirname(command);
      childEnv.PATH = childEnv.PATH ? `${binDir}:${childEnv.PATH}` : binDir;
    }
    const spawnOpts: SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe'] } = {
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    };
    if (IS_WINDOWS && !this.config.spawnFn) {
      const spawnPlan = resolveWindowsSpawnPlan(command, args);
      command = spawnPlan.command;
      args = spawnPlan.args;
      if (spawnPlan.shell !== undefined) spawnOpts.shell = spawnPlan.shell;
    }

    this.child = doSpawn(command, args, spawnOpts) as ChildProcess;

    // Stderr: capacity detection (shared with stdio client)
    this.child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      log.warn({ pid: this.child?.pid }, '[acp-http stderr] %s', text);
      if (CAPACITY_RE.test(text)) {
        const signal: AcpCapacitySignal = { message: text.slice(0, 300), timestamp: Date.now() };
        this._recentCapacitySignal = signal;
        for (const fn of this.capacityListeners) fn(signal);
      }
    });

    this.child.on('error', (err) => {
      log.error('ACP HTTP process error: %s', err.message);
      this.exited = true;
    });

    this.child.on('exit', (code, signal) => {
      log.info('ACP HTTP process exited: code=%s signal=%s', code, signal);
      this.exited = true;
    });

    log.info(
      buildAcpSpawnLogFields({ command, args, cwd: this.config.cwd, pid: this.child.pid, env: this.config.env }),
      'ACP HTTP: process spawned, discovering port from stdout',
    );

    // Phase 2: discover port from stdout
    this.port = await this.discoverPort();
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    log.info({ port: this.port, pid: this.child.pid }, 'ACP HTTP: port discovered');

    // Phase 3: send initialize via HTTP
    const resp = await this.httpRequest(ACP_METHODS.initialize, { protocolVersion: 1 });
    this.initResult = resp.result as unknown as AcpInitializeResult;
    log.info(
      {
        agentInfo: this.initResult.agentInfo,
        loadSession: this.initResult.agentCapabilities?.loadSession,
        pid: this.child?.pid,
        port: this.port,
      },
      'ACP HTTP: agent ready',
    );
    return this.initResult;
  }

  async newSession(cwd?: string, mcpServers: AcpMcpServer[] = []): Promise<AcpNewSessionResult> {
    const compatible = this.filterMcpByCapabilities(mcpServers);
    const effectiveCwd = cwd ?? this.config.cwd;
    log.info(
      { cwd: effectiveCwd, mcpServerCount: compatible.length, pid: this.child?.pid, port: this.port },
      'ACP HTTP session/new',
    );
    const t0 = Date.now();
    const resp = await this.httpRequest(ACP_METHODS.sessionNew, { cwd: effectiveCwd, mcpServers: compatible });
    log.info({ durationMs: Date.now() - t0, hasResult: !!resp.result }, 'ACP HTTP session/new: response');
    return resp.result as unknown as AcpNewSessionResult;
  }

  async setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    if (!configId.trim() || !value.trim()) return;
    await this.httpRequest(ACP_METHODS.sessionSetConfigOption, {
      sessionId,
      configId: configId.trim(),
      value: value.trim(),
    });
  }

  /**
   * Stream prompt events via HTTP streaming response.
   * Same yield semantics as AcpClient.promptStream.
   */
  async *promptStream(
    sessionId: string,
    text: string,
    options?: { timeoutMs?: number; idleWarningMs?: number; idleStallMs?: number },
  ): AsyncGenerator<AcpSessionUpdate, AcpStopReason> {
    const timeoutMs = options?.timeoutMs ?? 900_000;
    const idleWarningMs = options?.idleWarningMs ?? 20_000;
    const idleStallMs = options?.idleStallMs ?? 90_000;

    const id = randomUUID();
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: ACP_METHODS.sessionPrompt,
      id,
      params: { sessionId, prompt: [{ type: 'text', text }] },
    });
    const controller = new AbortController();

    let eventCount = 0;
    let lastEventAt = 0;
    let idleWarningFired = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let budgetTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingTool = false;
    let stopReason: AcpStopReason = 'end_turn';
    let promptError: Error | null = null;
    let done = false;

    const queue: AcpSessionUpdate[] = [];
    let waitResolve: (() => void) | null = null;

    /** Wake the consumer loop if it's waiting. Extracted to avoid TS narrowing issues with waitResolve. */
    const wakeConsumer = () => {
      if (waitResolve) {
        const resolve = waitResolve;
        waitResolve = null;
        resolve();
      }
    };

    const resetBudget = () => {
      if (budgetTimer) clearTimeout(budgetTimer);
      if (done) return;
      budgetTimer = setTimeout(() => {
        if (done) return;
        log.error({ sessionId, eventCount, timeoutMs }, 'HTTP turn budget exceeded');
        controller.abort();
        promptError = new AcpTimeoutError('session/prompt', timeoutMs);
        done = true;
        wakeConsumer();
      }, timeoutMs);
    };

    const injectSynthetic = (update: Record<string, unknown>) => {
      queue.push({ sessionId, update } as AcpSessionUpdate);
      wakeConsumer();
    };

    const scheduleIdleCheck = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (done) return;
      const nextMs = idleWarningFired ? Math.max(0, idleStallMs - idleWarningMs) : idleWarningMs;
      idleTimer = setTimeout(() => {
        if (done || eventCount === 0) return;
        const rawIdle = Date.now() - lastEventAt;
        const idleSinceMs = Math.max(rawIdle, idleWarningFired ? idleStallMs : idleWarningMs);
        if (!idleWarningFired) {
          idleWarningFired = true;
          const updateType = pendingTool ? 'stream_tool_wait_warning' : 'stream_idle_warning';
          injectSynthetic({ sessionUpdate: updateType, idleSinceMs, eventCount, timestamp: Date.now() });
          scheduleIdleCheck();
        } else if (!pendingTool) {
          log.error({ sessionId, idleSinceMs, eventCount }, 'HTTP stream idle stall — terminating');
          controller.abort();
          promptError = new AcpStreamIdleError(sessionId, idleSinceMs, eventCount);
          done = true;
          wakeConsumer();
        }
      }, nextMs);
    };

    // Start HTTP streaming request
    resetBudget();

    const streamPromise = (async () => {
      try {
        const resp = await fetch(this.baseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        });
        if (!resp.ok) {
          throw new Error(`ACP HTTP ${resp.status}: ${await resp.text()}`);
        }
        if (!resp.body) throw new Error('ACP HTTP: no response body');

        // Read NDJSON lines from streaming response
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(trimmed) as Record<string, unknown>;
            } catch {
              log.warn('ACP HTTP non-JSON line: %s', trimmed.slice(0, 120));
              continue;
            }

            const msgId = msg.id as string | undefined;
            const method = msg.method as string | undefined;

            if (msgId === id && !method) {
              // Final response to our prompt request — protocol is done
              const resp = msg as unknown as AcpResponse;
              if (resp.error) {
                promptError = new AcpProtocolError(resp.error.code, resp.error.message, resp.error.data);
              } else {
                const result = resp.result as unknown as AcpPromptResult;
                stopReason = result.stopReason;
              }
              // Don't wait for HTTP connection close — wake consumer immediately.
              // controller.abort() terminates the reader; the catch block ignores AbortError.
              done = true;
              wakeConsumer();
              controller.abort();
            } else if (method && !msgId) {
              // Notification (session update)
              const params = (msg as unknown as AcpNotification).params as unknown as AcpSessionUpdate;
              if (params.sessionId !== sessionId) continue;

              queue.push(params);
              eventCount++;
              lastEventAt = Date.now();
              idleWarningFired = false;

              const inner = (params.update ?? params) as Record<string, unknown>;
              const updateType = inner.sessionUpdate as string | undefined;
              if (updateType === 'tool_call' || updateType === 'permission_pending') {
                pendingTool = true;
              } else if (pendingTool && updateType !== 'tool_call_update' && updateType !== 'agent_thought_chunk') {
                pendingTool = false;
              }
              scheduleIdleCheck();
              resetBudget();
              wakeConsumer();
            }
          }
        }

        // Process any remaining buffer
        if (buffer.trim()) {
          try {
            const msg = JSON.parse(buffer.trim()) as Record<string, unknown>;
            if (msg.id === id && !msg.method) {
              const resp = msg as unknown as AcpResponse;
              if (resp.error) {
                promptError = new AcpProtocolError(resp.error.code, resp.error.message, resp.error.data);
              } else {
                const result = resp.result as unknown as AcpPromptResult;
                stopReason = result.stopReason;
              }
            }
          } catch {
            /* ignore */
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          promptError = err instanceof Error ? err : new Error(String(err));
        }
      } finally {
        done = true;
        wakeConsumer();
      }
    })();

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) break;
        await new Promise<void>((r) => {
          waitResolve = r;
        });
      }
      while (queue.length > 0) yield queue.shift()!;
      await streamPromise; // Ensure cleanup
      if (promptError) throw promptError;
      return stopReason;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (budgetTimer) clearTimeout(budgetTimer);
      this.capacityListeners.delete(() => {}); // noop — capacity injector not used for HTTP
    }
  }

  cancelSession(sessionId: string): void {
    if (!this.port || this.closed || this.exited) return;
    const body = JSON.stringify({ jsonrpc: '2.0', method: ACP_METHODS.sessionCancel, params: { sessionId } });
    fetch(this.baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch((err) => {
      log.warn({ sessionId, err: err instanceof Error ? err.message : String(err) }, 'ACP HTTP cancel failed');
    });
    log.info('Sent HTTP session/cancel for %s', sessionId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.child && !this.child.killed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (this.child && !this.child.killed) this.child.kill('SIGKILL');
          resolve();
        }, KILL_GRACE_MS);
        this.child!.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        this.child!.kill('SIGTERM');
      });
    }
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }
  get isAlive(): boolean {
    return this.child !== null && !this.child.killed && !this.closed && !this.exited;
  }

  onCapacity(fn: (signal: AcpCapacitySignal) => void): void {
    this.capacityListeners.add(fn);
  }
  offCapacity(fn: (signal: AcpCapacitySignal) => void): void {
    this.capacityListeners.delete(fn);
  }
  get recentCapacitySignal(): AcpCapacitySignal | null {
    return this._recentCapacitySignal;
  }
  clearRecentCapacitySignal(): void {
    this._recentCapacitySignal = null;
  }

  // ── MCP capability filtering (same logic as AcpClient) ──────

  private filterMcpByCapabilities(servers: AcpMcpServer[]): AcpMcpServer[] {
    const caps = this.initResult?.agentCapabilities?.mcpCapabilities;
    if (!caps) return servers;
    return servers.filter((s) => {
      if ('type' in s) {
        if (s.type === 'http') return caps.http === true;
        if (s.type === 'sse') return caps.sse === true;
        return false;
      }
      return true;
    });
  }

  // ── Internal ────────────────────────────────────────────────

  private discoverPort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      if (!this.child?.stdout) {
        reject(new Error('ACP HTTP: no stdout'));
        return;
      }
      const timeoutMs = this.config.portDiscoveryTimeoutMs ?? PORT_DISCOVERY_TIMEOUT_MS;
      const timer = setTimeout(() => {
        reject(new Error(`ACP HTTP: port discovery timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const rl = createInterface({ input: this.child.stdout });
      rl.on('line', (line) => {
        const match = PORT_RE.exec(line);
        if (match) {
          clearTimeout(timer);
          rl.close();
          resolve(Number(match[1]));
        } else {
          // Log non-port stdout lines (could be startup messages)
          log.debug({ pid: this.child?.pid }, '[acp-http stdout] %s', line.slice(0, 200));
        }
      });
      rl.on('close', () => {
        clearTimeout(timer);
        if (!this.port) reject(new Error('ACP HTTP: stdout closed before port discovered'));
      });
    });
  }

  private async httpRequest(method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<AcpResponse> {
    if (!this.port || this.closed || this.exited) {
      throw new Error('ACP HTTP client not connected');
    }

    const id = randomUUID();
    const body = JSON.stringify({ jsonrpc: '2.0', method, id, params });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    log.info({ method, id, timeoutMs, pid: this.child?.pid, port: this.port }, 'ACP HTTP request');
    const t0 = Date.now();

    try {
      const resp = await fetch(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`ACP HTTP ${resp.status}: ${text}`);
      }

      // For non-streaming requests, response is a single JSON object
      const text = await resp.text();
      const result = JSON.parse(text) as AcpResponse;
      log.info({ method, id, durationMs: Date.now() - t0, hasError: !!result.error }, 'ACP HTTP response');

      if (result.error) {
        throw new AcpProtocolError(result.error.code, result.error.message, result.error.data);
      }
      return result;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof AcpProtocolError) throw err;
      if (controller.signal.aborted) throw new AcpTimeoutError(method, timeoutMs);
      throw err;
    }
  }
}
