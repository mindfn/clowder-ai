import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

export function resolveRepoRoot(): string {
  return REPO_ROOT;
}

const MODEL_ID_PATTERN = /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)?$/;

export function isValidModelId(model: string): boolean {
  return MODEL_ID_PATTERN.test(model) && model.length <= 200;
}

export function resolveScriptPath(script: string | { unix: string; windows: string }): string {
  const path = typeof script === 'string' ? script : process.platform === 'win32' ? script.windows : script.unix;
  return resolve(REPO_ROOT, path);
}

export function resolveSpawnCommand(script: string | { unix: string; windows: string }): {
  command: string;
  args: string[];
} {
  const resolved = resolveScriptPath(script);
  if (process.platform === 'win32' && resolved.endsWith('.ps1')) {
    return { command: 'powershell', args: ['-ExecutionPolicy', 'Bypass', '-File', resolved] };
  }
  return { command: 'bash', args: [resolved] };
}

function resolveLogDir(): string {
  return process.env['LOG_DIR'] ?? resolve(REPO_ROOT, 'data/logs/api');
}

export function readLogTail(serviceId: string, lines = 100): string[] {
  const logPath = resolve(resolveLogDir(), `${serviceId}.log`);
  if (!existsSync(logPath)) return [];
  try {
    const fd = openSync(logPath, 'r');
    try {
      const stat = fstatSync(fd);
      const maxRead = 256 * 1024;
      const readSize = Math.min(stat.size, maxRead);
      if (readSize === 0) return [];
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      return buf.toString('utf-8').split('\n').slice(-lines).filter(Boolean);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}

export function openLogFd(serviceId: string): number | null {
  try {
    const logDir = resolveLogDir();
    mkdirSync(logDir, { recursive: true });
    return openSync(resolve(logDir, `${serviceId}.log`), 'a');
  } catch {
    return null;
  }
}

export function appendLog(serviceId: string, chunk: string): void {
  try {
    const logDir = resolveLogDir();
    mkdirSync(logDir, { recursive: true });
    appendFileSync(resolve(logDir, `${serviceId}.log`), chunk);
  } catch {
    /* best effort */
  }
}

const READY_MARKER = '__CATCAFE_SIDECAR_READY__';
// Fallback markers — if the sidecar didn't get the explicit READY_MARKER hook
// installed yet (older script), fall back to uvicorn's own ready emission.
const FALLBACK_MARKERS: readonly RegExp[] = [/Uvicorn running on http/i, /Application startup complete/i];

interface ChildLike {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
}

/**
 * Wire up a child process's stdout/stderr to:
 *   1. continue writing into the per-service log file (preserves existing UX
 *      — users see install/start logs in the same place); and
 *   2. parse for a ready marker (sidecar boot completion) and invoke
 *      onReady() exactly once when seen — this is the push-based fast path
 *      that replaces the old 5-min polling watcher.
 *
 * Caller must spawn with `stdio: ['ignore', 'pipe', 'pipe']` (or another
 * config that gives us readable stdout + stderr handles).
 *
 * The polling watcher (watchForRunningAndFire) can still run alongside as a
 * safety net — onReady is idempotent if you guard fire on the consumer side,
 * and the marker listener also guards itself with a `fired` flag so we never
 * call onReady twice from stdout/stderr races.
 */
export function wireUpSidecarReadyListener(child: ChildLike, serviceId: string, onReady: () => void): void {
  let fired = false;
  const trigger = (reason: string): void => {
    if (fired) return;
    fired = true;
    appendLog(serviceId, `\n[ready-marker] sidecar ready signal received (${reason})\n`);
    try {
      onReady();
    } catch {
      /* swallow — caller's onReady is itself idempotent / safe */
    }
  };
  // Stream chunking is arbitrary — marker text can be split across two
  // chunks (e.g. "...__CATCAFE" + "_SIDECAR_READY__..."). Per-stream
  // rolling buffers let includes()/regex match across that boundary.
  // Bounded length so unbounded sidecar output doesn't leak memory;
  // 256 chars comfortably covers the longest marker (~28 chars for
  // "Application startup complete") plus prefix slack. Codex P2 3256102827.
  const MAX_BUFFER = 256;
  const makeHandler = (): ((chunk: Buffer | string) => void) => {
    let buffer = '';
    return (chunk: Buffer | string): void => {
      const text = chunk.toString('utf-8');
      // Mirror stdout/stderr into the service log so users still see
      // install/start output via readLogTail.
      appendLog(serviceId, text);
      if (fired) return;
      buffer += text;
      if (buffer.includes(READY_MARKER)) {
        trigger('explicit marker');
        return;
      }
      for (const pattern of FALLBACK_MARKERS) {
        if (pattern.test(buffer)) {
          trigger(`uvicorn pattern: ${pattern.source}`);
          return;
        }
      }
      if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
    };
  };
  child.stdout?.on('data', makeHandler());
  child.stderr?.on('data', makeHandler());
}
