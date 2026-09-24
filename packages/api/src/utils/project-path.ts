/**
 * Project Path Validation
 * 共享的路径安全校验，防止路径遍历和 symlink 逃逸。
 *
 * Default mode: **denylist** — block known system directories, allow everything else.
 * Legacy mode: if PROJECT_ALLOWED_ROOTS is set, uses allowlist (backward compat).
 *
 * See: https://github.com/zts212653/clowder-ai/issues/228
 */

import { existsSync, realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import { basename, delimiter, dirname, relative, resolve, win32 } from 'node:path';

// ---------------------------------------------------------------------------
// Denylist: known system directories that should never be project roots
// ---------------------------------------------------------------------------

/**
 * Canonicalize one denied root for comparison against realpath'd candidate
 * paths. validateProjectPathDetailed realpaths the candidate before checking,
 * and macOS aliases /tmp, /var, /etc behind /private/... symlinks — a stored
 * literal '/tmp/x' would never match the candidate's '/private/tmp/x', a
 * silent security-control failure. Resolve the longest EXISTING ancestor so
 * not-yet-created directories still canonicalize (and saving them never fails
 * just because the target does not exist yet).
 *
 * Lives in the utils layer (not config) because both the preference store
 * and the legacy env fallback in this module must canonicalize — utils must
 * never depend on the config layer.
 */
export function canonicalizeDeniedRoot(entry: string): string {
  const abs = resolve(entry);
  let probe = abs;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    tail.unshift(basename(probe));
    probe = parent;
  }
  try {
    const canonical = realpathSync(probe);
    return tail.length === 0 ? canonical : resolve(canonical, ...tail);
  } catch {
    return abs;
  }
}

export function getDefaultDeniedRoots(platformName = platform()): string[] {
  if (platformName === 'win32') {
    const systemRoot = process.env.SYSTEMROOT ?? 'C:\\Windows';
    return [resolve(systemRoot)];
  }
  if (platformName === 'darwin') {
    return ['/dev', '/sbin', '/System'];
  }
  // linux / others
  return ['/proc', '/sys', '/dev', '/boot', '/sbin', '/run'];
}

/**
 * F770: preferred source of custom denied roots. Wired once at startup in
 * config.ts to an in-memory snapshot of the JSON preferences (env fallback
 * canonicalized at wiring, pushed on every PUT — see
 * initDeniedRootsRuntime in user-preferences-store).
 *
 * FAIL-CLOSED BY CONSTRUCTION: when the provider is unset / not yet wired /
 * returns null, DENIED_ROOTS() falls back to platform defaults + the legacy
 * env value — exactly the pre-#770 behavior. A security control must degrade
 * toward MORE restriction, never toward "no restriction", so the unwired case
 * can never yield an empty denylist.
 */
let deniedRootsProvider: (() => string[] | null) | null = null;

export function setDeniedRootsProvider(provider: (() => string[] | null) | null): void {
  deniedRootsProvider = provider;
}

/**
 * Canonicalize the raw PROJECT_DENIED_ROOTS env value, cached per exact env
 * string: validation is hot, so each distinct value is normalized ONCE (the
 * stat/realpath walk is disk IO) instead of on every call. Without this the
 * fallback path silently lost the P1 normalization that wiring-time
 * canonicalization provides: a literal '/tmp/x' env entry never matches a
 * candidate realpath'd to '/private/tmp/x'.
 */
const envDeniedRootsCache = new Map<string, string[]>();

function normalizedEnvDeniedRoots(envValue: string): string[] {
  const cached = envDeniedRootsCache.get(envValue);
  if (cached) return cached;
  const normalized = [...new Set(envValue.split(delimiter).filter(Boolean).map(canonicalizeDeniedRoot))];
  envDeniedRootsCache.set(envValue, normalized);
  return normalized;
}

function DENIED_ROOTS(): string[] {
  const defaults = getDefaultDeniedRoots();
  const provided = deniedRootsProvider?.();
  if (provided != null) {
    return [...new Set([...defaults, ...provided])];
  }
  const envDenied = process.env.PROJECT_DENIED_ROOTS;
  if (envDenied?.trim()) {
    return [...new Set([...defaults, ...normalizedEnvDeniedRoots(envDenied)])];
  }
  return defaults;
}

// ---------------------------------------------------------------------------
// Legacy allowlist (only active when PROJECT_ALLOWED_ROOTS is set)
// ---------------------------------------------------------------------------

/**
 * Legacy default roots for allowlist mode (pre-#228).
 * Used when PROJECT_ALLOWED_ROOTS_APPEND=true merges custom roots with defaults.
 */
function legacyDefaultRoots(platformName = platform()): string[] {
  const roots = new Set<string>([homedir()]);
  if (platformName === 'win32') return [...roots];
  roots.add('/tmp');
  roots.add('/private/tmp');
  roots.add('/workspace');
  if (platformName === 'darwin') roots.add('/Volumes');

  // On macOS, os.tmpdir() returns /var/folders/…/T/ (NOT /tmp).
  // Tests using mkdtemp() create dirs there — they must be allowed when
  // PROJECT_ALLOWED_ROOTS_APPEND=true activates allowlist mode (e.g. sync
  // public gate).  Resolve symlinks so the root matches realpath'd paths.
  try {
    const sysTmp = realpathSync(tmpdir());
    roots.add(sysTmp);
  } catch {
    // tmpdir resolution failed — fall through; /tmp still covers Linux/CI
  }

  return [...roots];
}

function LEGACY_ALLOWED_ROOTS(): string[] | null {
  const envRoots = process.env.PROJECT_ALLOWED_ROOTS;
  if (!envRoots?.trim()) return null;
  const custom = envRoots.split(delimiter).filter(Boolean);
  const append = process.env.PROJECT_ALLOWED_ROOTS_APPEND === 'true';
  return append ? [...new Set([...legacyDefaultRoots(), ...custom])] : custom;
}

// ---------------------------------------------------------------------------
// Public API (kept backward-compatible)
// ---------------------------------------------------------------------------

/**
 * Returns restriction info for error messages.
 * - Denylist mode: returns denied roots
 * - Allowlist mode: returns allowed roots
 */
export function getAllowedRoots(): string[] {
  const legacy = LEGACY_ALLOWED_ROOTS();
  if (legacy) return legacy;
  return DENIED_ROOTS();
}

/** Returns true if path validation uses denylist mode (default). */
export function isDenylistMode(): boolean {
  return LEGACY_ALLOWED_ROOTS() === null;
}

export type ProjectPathValidationFailureReason = 'not_found' | 'not_directory' | 'denied_root' | 'io_error';

export type ProjectPathValidationResult =
  | { ok: true; path: string }
  | { ok: false; reason: ProjectPathValidationFailureReason; message?: string };

interface ProjectPathValidationDeps {
  realpath?: typeof realpath;
  stat?: typeof stat;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

function errorMessage(err: unknown): string | undefined {
  return err instanceof Error ? err.message : undefined;
}

function isMissingPathError(err: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes(errorCode(err) ?? '');
}

/**
 * Check if a path is an allowed project directory and return diagnostic detail.
 *
 * 1. Resolves the path to absolute
 * 2. Uses realpath() to follow symlinks and canonicalize
 * 3. Checks the real path against denylist (or allowlist in legacy mode)
 * 4. Verifies the path is an existing directory
 */
export async function validateProjectPathDetailed(
  rawPath: string,
  deps: ProjectPathValidationDeps = {},
): Promise<ProjectPathValidationResult> {
  const realpathFn = deps.realpath ?? realpath;
  const statFn = deps.stat ?? stat;
  try {
    const absPath = resolve(rawPath);
    const realPath = await realpathFn(absPath);

    if (!isUnderAllowedRoot(realPath)) return { ok: false, reason: 'denied_root' };

    const info = await statFn(realPath);
    if (!info.isDirectory()) return { ok: false, reason: 'not_directory' };

    return { ok: true, path: realPath };
  } catch (err) {
    if (isMissingPathError(err)) return { ok: false, reason: 'not_found', message: errorMessage(err) };
    return { ok: false, reason: 'io_error', message: errorMessage(err) };
  }
}

/**
 * Check if a path is an allowed project directory.
 *
 * @returns The canonicalized real path if valid, or null if rejected.
 */
export async function validateProjectPath(rawPath: string): Promise<string | null> {
  const result = await validateProjectPathDetailed(rawPath);
  return result.ok ? result.path : null;
}

export function isPathUnderRoots(absPath: string, roots: string[], platformName = process.platform): boolean {
  const isWindows = platformName === 'win32';
  for (const root of roots) {
    const rel = isWindows ? win32.relative(root, absPath) : relative(root, absPath);
    if (rel === '') return true;
    if (isWindows && win32.isAbsolute(rel)) continue;
    if (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\')) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a path is allowed for project use.
 *
 * - Denylist mode (default): allowed unless under a denied root.
 * - Allowlist mode (PROJECT_ALLOWED_ROOTS set): allowed only if under an allowed root.
 */
export function isUnderAllowedRoot(absPath: string): boolean {
  const legacy = LEGACY_ALLOWED_ROOTS();
  if (legacy) {
    return isPathUnderRoots(absPath, legacy);
  }
  return !isPathUnderRoots(absPath, DENIED_ROOTS());
}

// Keep backward-compat export — returns legacy allowlist defaults for tests
export function getDefaultRootsForPlatform(platformName = platform(), opts?: { homeDir?: string }): string[] {
  if (opts?.homeDir) {
    const roots = new Set<string>([opts.homeDir]);
    if (platformName === 'win32') return [...roots];
    roots.add('/tmp');
    roots.add('/private/tmp');
    roots.add('/workspace');
    if (platformName === 'darwin') roots.add('/Volumes');
    return [...roots];
  }
  return legacyDefaultRoots(platformName);
}

/**
 * Cross-platform path equality.
 * Case-insensitive on Windows (NTFS is case-preserving but case-insensitive).
 * Accepts optional platformName for testability on non-Windows CI.
 */
export function pathsEqual(a: string, b: string, platformName = process.platform): boolean {
  if (platformName !== 'win32') return a === b;
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}
