/**
 * #1092 / PR#1099 review P1 — session-scoped MCP credential files for ACP.
 *
 * Why session-scoped (not per-thread+cat): a deterministic <threadId>_<catId>.json
 * path collapses per-invocation identity into per-(thread,cat). When a newer
 * invocation starts while a superseded ACP process can still issue callbacks,
 * the old process re-reads the shared file, picks up the newest invocation's
 * credentials, and defeats the registry.isLatest() stale guard — exactly the
 * late-write class that guard exists to block.
 *
 * Design: one credential file per ACP session, nonce generated BEFORE session/new:
 *   <threadId>_<catId>_<nonce>.json
 * The path is injected into that session's MCP server env at session creation
 * (the MCP subprocess env is frozen for the life of the process). Resuming a
 * session rewrites the SAME file with fresh credentials (the #1092 refresh),
 * while superseded processes keep their own file, which stops receiving
 * updates — their late callbacks carry the old invocationId and are correctly
 * rejected by registry.isLatest().
 *
 * The sessionId→path binding is in-memory (module scope). That is sufficient:
 * the binding only needs to outlive the pooled CLI process, and pooled
 * processes die with the API. After an API restart, a resume cold-starts a
 * fresh CLI process whose MCP servers are spawned with whatever path we
 * inject at that point.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import { findMonorepoRoot } from '../../../../../../utils/monorepo-root.js';

const log = createModuleLogger('acp-credential-file');

/** In-memory binding: ACP sessionId → credential file path (see module doc). */
const sessionFileBindings = new Map<string, string>();

/** Backstop against unbounded growth — evicts oldest binding (insertion order). */
const MAX_BINDINGS = 1000;

/**
 * Files older than this are swept opportunistically at write time. Any live
 * session's file is rewritten on every resume (mtime refreshed), and idle ACP
 * processes are pool-evicted after 30min — 48h is deliberately conservative.
 */
const SWEEP_AGE_MS = 48 * 60 * 60 * 1000;

export interface PreparedCredentialEnv {
  /** callbackEnv copy with CAT_CAFE_CREDENTIAL_FILE pointing at the session-scoped file. */
  env: Record<string, string>;
  /** Absolute path of the session credential file — bind it once the sessionId is known. */
  path: string;
}

interface CredentialPayload {
  threadId: string;
  catId: string;
  invocationId: string;
  callbackToken: string;
}

function credentialDir(): string {
  const override = process.env.CAT_CAFE_MCP_CREDS_DIR?.trim();
  if (override) return override;
  return resolve(findMonorepoRoot(process.cwd()), '.cat-cafe', 'mcp-creds');
}

/**
 * Resolve the session-scoped credential file path without writing credentials.
 * Call before session/new or session/load so the returned env can be
 * materialized into the session's MCP server configs.
 *
 * - Resuming a known session → its bound path (same file the live MCP
 *   subprocess already points at).
 * - New session (or unknown resume target) → fresh nonce path.
 *
 * Returns null when callbackEnv lacks invocation credentials (nothing to
 * protect).
 */
export function resolveSessionCredentialFile(
  callbackEnv: Record<string, string> | undefined,
  resumeSessionId?: string,
): PreparedCredentialEnv | null {
  const payload = parseCredentialPayload(callbackEnv);
  if (!callbackEnv || !payload) return null;

  const dir = credentialDir();
  const bound = resumeSessionId ? sessionFileBindings.get(resumeSessionId) : undefined;
  const path = bound ?? join(dir, `${payload.threadId}_${payload.catId}_${randomUUID()}.json`);
  return { env: { ...callbackEnv, CAT_CAFE_CREDENTIAL_FILE: path }, path };
}

export function writeSessionCredentialFile(callbackEnv: Record<string, string> | undefined, path: string): boolean {
  const payload = parseCredentialPayload(callbackEnv);
  if (!payload) return false;
  try {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ invocationId: payload.invocationId, callbackToken: payload.callbackToken, ts: Date.now() }),
      { mode: 0o600 }, // owner-only — contains secrets
    );
    sweepStaleFiles(dir);
    return true;
  } catch (err) {
    log.warn(
      {
        threadId: payload.threadId,
        catId: payload.catId,
        invocationId: payload.invocationId,
        err: err instanceof Error ? err.message : String(err),
      },
      '#1092: credential file write failed — MCP server will use process.env fallback',
    );
    return false;
  }
}

export function prepareSessionCredentialFile(
  callbackEnv: Record<string, string> | undefined,
  resumeSessionId?: string,
): PreparedCredentialEnv | null {
  const prepared = resolveSessionCredentialFile(callbackEnv, resumeSessionId);
  if (!prepared) return null;
  if (!writeSessionCredentialFile(callbackEnv, prepared.path)) return null;
  return prepared;
}

/**
 * Record which credential file a session's MCP servers were created with.
 * Call after session/new and session/load resolve the authoritative sessionId
 * (a resume may return a different id than requested — bind both).
 */
export function bindSessionCredentialFile(sessionId: string | undefined, path: string): void {
  if (!sessionId) return;
  if (!sessionFileBindings.has(sessionId) && sessionFileBindings.size >= MAX_BINDINGS) {
    const oldest = sessionFileBindings.keys().next().value;
    if (oldest !== undefined) sessionFileBindings.delete(oldest);
  }
  sessionFileBindings.set(sessionId, path);
}

/** Best-effort GC of credential files whose sessions are long dead. */
function sweepStaleFiles(dir: string): void {
  try {
    const cutoff = Date.now() - SWEEP_AGE_MS;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const filePath = join(dir, name);
      try {
        if (statSync(filePath).mtimeMs < cutoff) unlinkSync(filePath);
      } catch {
        /* best-effort — file may have been removed concurrently */
      }
    }
  } catch {
    /* best-effort — sweep must never break an invocation */
  }
}

function parseCredentialPayload(callbackEnv: Record<string, string> | undefined): CredentialPayload | null {
  const threadId = callbackEnv?.CAT_CAFE_THREAD_ID;
  const catId = callbackEnv?.CAT_CAFE_CAT_ID;
  const invocationId = callbackEnv?.CAT_CAFE_INVOCATION_ID;
  const callbackToken = callbackEnv?.CAT_CAFE_CALLBACK_TOKEN;
  if (!threadId || !catId || !invocationId || !callbackToken) return null;
  return { threadId, catId, invocationId, callbackToken };
}
