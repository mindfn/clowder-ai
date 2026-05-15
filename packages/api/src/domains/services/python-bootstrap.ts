// python-bootstrap.ts
//
// API-side coordinator for the python-bootstrap meta-service.
//
// Before any whisper / tts / embed / llm-postprocess install runs, the
// install route calls `await ensurePython(logger)`. That call:
//
//   1. Returns immediately if Python is already installed (cached path
//      hit, or services.json installStatus='installed').
//   2. If another caller is currently running the bootstrap, awaits the
//      same in-flight Promise (no duplicate spawn within this API process).
//   3. Otherwise spawns scripts/services/install-python.{sh,ps1} as a
//      detached child, captures its stdout, parses PYTHON_PATH on success,
//      persists installStatus to services.json, fires the 'installed'
//      service-hooks event so any other listener can react.
//   4. On failure, persists installStatus='failed' and throws — callers
//      bubble that up as 422 to the user.
//
// resolver lock (python-resolve.{sh,ps1}) is still a defensive backstop
// for in-shell concurrency; the API-level coordinator here makes sure we
// don't even reach that backstop in the common case.
//
// Status state machine (mirrored in services.json):
//   none        — never attempted; ensurePython will spawn
//   installing  — a child process is currently running
//   installed   — Python is ready
//   failed      — last attempt failed; ensurePython throws to caller

import { spawn } from 'node:child_process';
import { getServiceConfig, setServiceConfig } from './service-config.js';
import { fireServiceEvent, onServiceEvent } from './service-hooks.js';
import { appendLog, resolveRepoRoot, resolveSpawnCommand } from './service-logs.js';

const PYTHON_BOOTSTRAP_ID = 'python-bootstrap';

interface BootstrapLogger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
}

interface ResolvedPython {
  path: string;
  arch: string;
  source: string;
}

// Module-local in-memory state — protects against duplicate spawns within
// a single API process. Cross-process serialization (e.g. concurrent API
// instances on the same machine) is handled by python-resolve's own lock.
let inFlight: Promise<ResolvedPython> | null = null;
let cachedResult: ResolvedPython | null = null;
// Subscribers that want python-bootstrap progress fan-out (e.g. each parallel
// service install handler wants to mirror chunks into ITS own service log).
// Populated by ensurePython() callers; cleared when the spawn resolves.
const logChunkSubscribers = new Set<(chunk: string) => void>();

function bootstrapScript(): { unix: string; windows: string } {
  return {
    unix: 'scripts/services/install-python.sh',
    windows: 'scripts/services/install-python.ps1',
  };
}

function parseResolverOutput(out: string): Partial<ResolvedPython> {
  const result: Partial<ResolvedPython> = {};
  for (const line of out.split(/\r?\n/)) {
    const match = line.match(/^PYTHON_(PATH|ARCH|SOURCE)=(.+)$/);
    if (!match) continue;
    const key = match[1].toLowerCase() as 'path' | 'arch' | 'source';
    result[key] = match[2];
  }
  return result;
}

/**
 * Returns the path to a Python 3.12+ interpreter, blocking only as long as
 * an actual install is needed. Concurrent callers within this API process
 * share one spawn.
 *
 * `onLogChunk` is invoked for every stdout/stderr chunk the bootstrap child
 * produces — useful to mirror progress into the calling service's own log
 * (so the UI card doesn't stare at stale text while python-bootstrap runs).
 * Multiple concurrent callers each get their callback invoked.
 */
export async function ensurePython(
  logger?: BootstrapLogger,
  onLogChunk?: (chunk: string) => void,
): Promise<ResolvedPython> {
  if (cachedResult) return cachedResult;

  // Cheap path: services.json says we already installed last time. Trust
  // it — the resolver inside service install scripts will re-verify.
  const cfg = getServiceConfig(PYTHON_BOOTSTRAP_ID);
  if (cfg.installStatus === 'installed' && cfg.pythonPath) {
    cachedResult = { path: cfg.pythonPath, arch: cfg.pythonArch ?? '', source: cfg.pythonSource ?? 'cached' };
    return cachedResult;
  }

  // Register this caller's log forwarder for the duration of the bootstrap
  // run. spawnBootstrap fans out every chunk to every subscriber.
  if (onLogChunk) logChunkSubscribers.add(onLogChunk);

  try {
    // Another caller in this same API process is already running the
    // bootstrap — share their Promise.
    if (inFlight) return await inFlight;

    inFlight = spawnBootstrap(logger).finally(() => {
      inFlight = null;
    });
    try {
      cachedResult = await inFlight;
      return cachedResult;
    } catch (err) {
      cachedResult = null;
      throw err;
    }
  } finally {
    if (onLogChunk) logChunkSubscribers.delete(onLogChunk);
  }
}

/**
 * Subscribe to the bootstrap 'installed' event. Useful for non-blocking
 * paths (e.g. service install routes that want to immediately return
 * "queued, waiting on python bootstrap" without blocking the HTTP request).
 */
export function onPythonReady(cb: (resolved: ResolvedPython) => void | Promise<void>): void {
  onServiceEvent(PYTHON_BOOTSTRAP_ID, 'installed', async () => {
    if (cachedResult) await cb(cachedResult);
  });
}

function spawnBootstrap(logger?: BootstrapLogger): Promise<ResolvedPython> {
  return new Promise<ResolvedPython>((resolveResult, rejectResult) => {
    setServiceConfig(PYTHON_BOOTSTRAP_ID, { installStatus: 'installing' });
    const { command, args } = resolveSpawnCommand(bootstrapScript());
    logger?.info('[python-bootstrap] spawning %s %s', command, args.join(' '));

    let stdoutBuf = '';
    let stderrBuf = '';
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // Note: we don't keep a long-lived log FD here — appendLog opens and
    // closes its own descriptor per write. An earlier version called
    // openLogFd() and never used or closed the descriptor, leaking one
    // FD per install attempt (eventual EMFILE). Removed (codex P2).

    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString();
      stdoutBuf += s;
      appendLog(PYTHON_BOOTSTRAP_ID, s);
      logger?.info('[python-bootstrap stdout] %s', s.trimEnd());
      for (const cb of logChunkSubscribers) {
        try {
          cb(s);
        } catch {
          /* a subscriber failing shouldn't crash bootstrap */
        }
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString();
      stderrBuf += s;
      appendLog(PYTHON_BOOTSTRAP_ID, s);
      logger?.warn('[python-bootstrap stderr] %s', s.trimEnd());
      for (const cb of logChunkSubscribers) {
        try {
          cb(s);
        } catch {
          /* ignore subscriber failure */
        }
      }
    });
    child.on('error', (err) => {
      setServiceConfig(PYTHON_BOOTSTRAP_ID, { installStatus: 'failed' });
      rejectResult(err);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        setServiceConfig(PYTHON_BOOTSTRAP_ID, { installStatus: 'failed' });
        rejectResult(
          new Error(
            `python-bootstrap exited with code ${code}\nstderr: ${stderrBuf.slice(-1000)}\nstdout: ${stdoutBuf.slice(-500)}`,
          ),
        );
        return;
      }
      const parsed = parseResolverOutput(stdoutBuf);
      if (!parsed.path) {
        setServiceConfig(PYTHON_BOOTSTRAP_ID, { installStatus: 'failed' });
        rejectResult(new Error('python-bootstrap finished but did not report PYTHON_PATH'));
        return;
      }
      const result: ResolvedPython = {
        path: parsed.path,
        arch: parsed.arch ?? '',
        source: parsed.source ?? 'unknown',
      };
      setServiceConfig(PYTHON_BOOTSTRAP_ID, {
        installStatus: 'installed',
        pythonPath: result.path,
        pythonArch: result.arch,
        pythonSource: result.source,
      });
      // Publish the resolved Python info to cachedResult BEFORE firing
      // the 'installed' event, so `onPythonReady` subscribers see the
      // data when their callback runs. Without this, fireServiceEvent's
      // synchronous loop enters entry.fn before ensurePython's
      // `cachedResult = await inFlight` assignment has run (resolveResult
      // is scheduled here, but the awaiter's continuation is a microtask
      // that hasn't fired yet) — subscriber's `if (cachedResult)` guard
      // sees null, skips the cb, and gets unregistered as "successful"
      // without ever running. Codex P2 3249693895.
      cachedResult = result;
      void fireServiceEvent(PYTHON_BOOTSTRAP_ID, 'installed');
      resolveResult(result);
    });
  });
}

/**
 * Test hook — reset module state so tests can simulate a cold start.
 * @internal
 */
export function _resetPythonBootstrapForTest(): void {
  inFlight = null;
  cachedResult = null;
}
