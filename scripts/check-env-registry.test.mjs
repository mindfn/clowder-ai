/**
 * check:env-registry — CI gate for env var registration completeness.
 *
 * Scans `packages/api/src` and `packages/mcp-server/src` for `process.env.XXX`
 * references and verifies each is either:
 *   1. Registered in `env-registry.ts` ENV_VARS array, OR
 *   2. Listed in the ALLOWLIST below (with a reason).
 *
 * Run: `node --test scripts/check-env-registry.test.mjs`
 * Wire: `pnpm check:env-registry` in root package.json
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

// ── Allowlist: vars used in code that should NOT be in env-registry ──
// Each entry MUST have a reason (enforced by test below).
const ALLOWLIST = new Map([
  ['HOME', 'OS-provided home directory'],
  ['SHELL', 'OS-provided shell path'],
  ['PATH', 'OS-provided executable search path'],
  ['USER', 'OS-provided username'],
  ['USERNAME', 'Windows OS-provided username'],
  ['USERPROFILE', 'Windows OS-provided home directory (F212 sanitizer path redaction)'],
  ['LANG', 'OS-provided locale'],
  ['LC_ALL', 'OS-provided locale override'],
  ['APPDATA', 'Windows OS variable (cli-spawn-win.ts)'],
  ['LOCALAPPDATA', 'Windows OS variable (cli-resolve.ts)'],
  ['SYSTEMROOT', 'Windows OS variable (project-path.ts)'],
  ['PROGRAMFILES', 'Windows OS variable (ImageExporter.ts Chrome detection)'],
  ['PATHEXT', 'Windows OS variable (capability-orchestrator.ts executable extension lookup)'],
  ['NODE_ENV', 'Node.js standard'],
  ['https_proxy', 'Standard proxy convention (lowercase variant of HTTPS_PROXY)'],
  ['http_proxy', 'Standard proxy convention (lowercase variant of HTTP_PROXY)'],
  ['all_proxy', 'Standard proxy convention (lowercase variant of ALL_PROXY)'],
  ['npm_execpath', 'Package-manager metadata injected by npm/pnpm; not user-configurable'],
  ['npm_config_user_agent', 'Package-manager metadata injected by npm/pnpm; not user-configurable'],
  ['INIT_CWD', 'Package-manager metadata injected by npm/pnpm; original invocation directory'],
  ['COGVIDEO_API_KEY', 'F139 MediaHub CogVideoX provider — mcp-server-local credential'],
  // F240: Per-connector env vars migrated to YAML manifests (connector.yaml / plugin.yaml).
  // Runtime still reads process.env as fallback in resolveConnectorEnv() chain, but
  // documentation/display is now driven by the YAML config.fields declarations.
  ['TELEGRAM_BOT_TOKEN', 'F240: defined in connectors/telegram/connector.yaml'],
  ['FEISHU_APP_ID', 'F240: defined in connectors/feishu/connector.yaml'],
  ['FEISHU_APP_SECRET', 'F240: defined in connectors/feishu/connector.yaml'],
  ['FEISHU_VERIFICATION_TOKEN', 'F240: defined in connectors/feishu/connector.yaml'],
  ['FEISHU_BOT_OPEN_ID', 'F240: defined in connectors/feishu/connector.yaml'],
  ['FEISHU_ADMIN_OPEN_IDS', 'F240: defined in connectors/feishu/connector.yaml'],
  ['FEISHU_CONNECTION_MODE', 'F240: defined in connectors/feishu/connector.yaml'],
  [
    'FEISHU_GROUP_BOT_MENTIONS_JSON',
    'F240: connector-scoped power-user env (#1035 — JSON map for outbound @alias resolution; .env-only, not surfaced in Hub UI)',
  ],
  ['DINGTALK_APP_KEY', 'F240: defined in connectors/dingtalk/connector.yaml'],
  ['DINGTALK_APP_SECRET', 'F240: defined in connectors/dingtalk/connector.yaml'],
  ['XIAOYI_AK', 'F240: defined in connectors/xiaoyi/connector.yaml'],
  ['XIAOYI_SK', 'F240: defined in connectors/xiaoyi/connector.yaml'],
  ['XIAOYI_AGENT_ID', 'F240: defined in connectors/xiaoyi/connector.yaml'],
  ['WEIXIN_BOT_TOKEN', 'F240: defined in connectors/weixin/connector.yaml'],
  ['WECOM_BOT_ID', 'F240: defined in connectors/wecom/connector.yaml'],
  ['WECOM_BOT_SECRET', 'F240: defined in connectors/wecom/connector.yaml'],
  ['WECOM_CORP_ID', 'F240: defined in connectors/wecom/connector.yaml'],
  ['WECOM_AGENT_ID', 'F240: defined in connectors/wecom/connector.yaml'],
  ['WECOM_AGENT_SECRET', 'F240: defined in connectors/wecom/connector.yaml'],
  ['WECOM_TOKEN', 'F240: defined in connectors/wecom/connector.yaml'],
  ['WECOM_ENCODING_AES_KEY', 'F240: defined in connectors/wecom/connector.yaml'],
  // ── #770: Infrastructure env vars — set by launcher/bootstrap, not user-configurable ──
  ['CAT_CAFE_RUNTIME_ROOT', '#770: internal — set by launcher/bootstrap'],
  ['CAT_CAFE_WORKSPACE_ROOT', '#770: internal — set by launcher/bootstrap'],
  ['CAT_CAFE_API_URL', '#770: internal — set by launcher/bootstrap'],
  ['CAT_CAFE_CONFIG_ROOT', '#770: internal — set by launcher/bootstrap'],
  ['CAT_CAFE_HOME', '#770: internal — set by launcher/bootstrap'],
  ['CAT_CAFE_SERVICES_CONFIG', '#770: internal — service config path, set by bootstrap'],
  ['CAT_CAFE_GLOBAL_CONFIG_ROOT', '#770: internal — global config dir, set by bootstrap'],
  ['CAT_CAFE_SKIP_HOMEDIR_MIGRATION', '#770: internal — one-time migration flag'],
  ['CAT_CAFE_MCP_SERVER_PATH', '#770: internal — MCP server binary path, set by bootstrap'],
  ['CAT_CAFE_INVOCATION_REGISTRY', '#770: internal — invocation registry path, set by bootstrap'],
  ['CAT_CAFE_TMUX_PATH', '#770: internal — tmux binary path, set by bootstrap'],
  ['CAT_CAFE_TMUX_AGENT', '#770: internal — tmux agent flag, set by bootstrap'],
  ['CAT_CAFE_DIAGNOSTICS', '#770: internal — diagnostics mode flag'],
  ['CAT_CAFE_HOOK_TOKEN', '#770: internal — webhook auth token, set by bootstrap'],
  ['CAT_CAFE_REPO_ROOT', '#770: internal — repo root path, set by bootstrap'],
  ['CAT_CAFE_REPO_FULL_NAME', '#770: internal — repo full name (owner/repo), set by bootstrap'],
  ['CAT_CAFE_RIPGREP_PATH', '#770: internal — ripgrep binary path, set by bootstrap'],
  ['CAT_CAFE_PREFLIGHT_TIMEOUT_MS', '#770: internal — preflight timeout tuning, not user-facing'],
  ['CAT_CAFE_SIGNAL_USER', '#770: internal — signal user ID, set by bootstrap'],
  ['CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT', '#770: internal — debug toggle for shared state preflight'],
  ['CAT_CAFE_RUNTIME_SESSION_SEAL_REAPER_INTERVAL_MS', '#770: internal — session reaper interval tuning'],
  ['CAT_CAFE_TEST_REAL_HOME', '#770: internal — test harness override for real home dir'],
  // ── #770: Per-invocation env — injected by session bootstrap into agent process ──
  ['CAT_CAFE_AGENT_KEY_FILE', '#770: per-invocation — injected into agent env by session bootstrap'],
  ['CAT_CAFE_AGENT_KEY_FILES', '#770: per-invocation — injected into agent env by session bootstrap'],
  ['CAT_CAFE_AGENT_KEY_SECRET', '#770: per-invocation — agent auth secret, injected by session bootstrap'],
  ['CAT_CAFE_CAT_ID', '#770: per-invocation — cat identity, injected by session bootstrap'],
  ['CAT_CAFE_USER_ID', '#770: per-invocation — user identity, injected by session bootstrap'],
  ['CAT_CAFE_INVOCATION_ID', '#770: per-invocation — invocation ID, injected by session bootstrap'],
  ['CAT_CAFE_CALLBACK_TOKEN', '#770: per-invocation — callback auth token, injected by session bootstrap'],
  ['CAT_CAFE_THREAD_ID', '#770: per-invocation — thread ID, injected by session bootstrap'],
  ['CAT_CAFE_REMOTE_PORT', '#770: per-invocation — MCP remote port, injected by session bootstrap'],
  ['CAT_CAFE_REMOTE_TOKEN', '#770: per-invocation — MCP remote auth token, injected by session bootstrap'],
  ['CAT_CAFE_DESKTOP_MODE', '#770: per-invocation — desktop mode flag, injected by session bootstrap'],
  ['CAT_CAFE_READONLY', '#770: per-invocation — read-only flag, injected by session bootstrap'],
  // ── #770: MCP callback subsystem — internal agent infrastructure ──
  ['CAT_CAFE_CALLBACK_OUTBOX_ENABLED', '#770: callback subsystem — outbox toggle, internal agent infra'],
  ['CAT_CAFE_CALLBACK_OUTBOX_DIR', '#770: callback subsystem — outbox dir, internal agent infra'],
  ['CAT_CAFE_CALLBACK_OUTBOX_MAX_FLUSH_BATCH', '#770: callback subsystem — flush batch size tuning'],
  ['CAT_CAFE_CALLBACK_OUTBOX_MAX_ATTEMPTS', '#770: callback subsystem — retry attempt limit tuning'],
  ['CAT_CAFE_CALLBACK_RETRY_DELAYS_MS', '#770: callback subsystem — retry delay tuning'],
  ['CAT_CAFE_CALLBACK_FETCH_TIMEOUT_MS', '#770: callback subsystem — fetch timeout tuning'],
  // ── #770: CLI supervisor — internal process management ──
  ['CAT_CAFE_SUPERVISOR_PARENT_PID', '#770: CLI supervisor — parent PID for orphan detection'],
  ['CAT_CAFE_SUPERVISOR_POLL_MS', '#770: CLI supervisor — poll interval tuning'],
  ['CAT_CAFE_SUPERVISOR_KILL_GRACE_MS', '#770: CLI supervisor — kill grace period tuning'],
  // ── #770: Agent provider internals — per-provider config, not user-facing ──
  ['CAT_CAFE_AGY_PROFILE_ROOT', '#770: provider — AGY profile root, internal agent config'],
  ['CAT_CAFE_AGY_CWD_ROOT', '#770: provider — AGY working directory root, internal agent config'],
  ['ANTIGRAVITY_AUTO_APPROVE', '#770: provider — Antigravity auto-approve toggle'],
  ['ANTIGRAVITY_AUTO_RESUME', '#770: provider — Antigravity auto-resume toggle'],
  ['ANTIGRAVITY_NATIVE_EXECUTOR', '#770: provider — Antigravity native executor mode'],
  ['ANTIGRAVITY_YOLO_RUN_COMMAND', '#770: provider — Antigravity YOLO run command'],
  ['ANTIGRAVITY_BRAIN_HOME', '#770: provider — Antigravity brain home directory'],
  ['ANTIGRAVITY_PORT', '#770: provider — Antigravity LS port'],
  ['ANTIGRAVITY_CSRF_TOKEN', '#770: provider — Antigravity CSRF token'],
  ['ANTIGRAVITY_TLS', '#770: provider — Antigravity TLS toggle'],
  ['ANTIGRAVITY_TRACE_RAW', '#770: provider — Antigravity raw trace toggle'],
  ['CODEX_HOME', '#770: provider — Codex home directory'],
  ['KIMI_SHARE_DIR', '#770: provider — Kimi share directory'],
  ['KIMI_CONFIG_FILE', '#770: provider — Kimi config file path'],
  ['GEMINI_ADAPTER', '#770: provider — Gemini adapter mode'],
  ['PINCHTAB_CDP_PORT', '#770: provider — PinchTab CDP debug port'],
  ['CDP_DEBUG', '#770: provider — Chrome DevTools Protocol debug flag'],
  // ── #770: Internal tuning / startup-only paths — not for end-user settings UI ──
  ['MAX_PROMPT_TOKENS', '#770: internal tuning — prompt token budget'],
  ['DEFAULT_CAT_ID', '#770: internal — default cat ID fallback'],
  ['CAT_TEMPLATE_PATH', '#770: internal — cat template file path'],
  ['GENSHIN_VOICE_DIR', '#770: internal — Genshin voice asset directory'],
  ['CHARACTER_VOICE_DIR', '#770: internal — character voice asset directory'],
  ['REDIS_PORT', '#770: internal — Redis port (governance pack)'],
  ['REDIS_DEV_PORT', '#770: internal — Redis dev port (governance pack)'],
  ['MAX_A2A_DEPTH', '#770: internal tuning — A2A routing depth limit'],
  ['MAX_CONTEXT_MSG_CHARS', '#770: internal tuning — context message char limit'],
  ['TRANSCRIPT_DIR', '#770: internal — transcript directory path'],
  ['AUDIT_LOG_INCLUDE_PROMPT_SNIPPETS', '#770: internal — audit log prompt snippet toggle'],
  ['AUDIT_LOG_DIR', '#770: internal — audit log directory path'],
  ['CLI_RAW_ARCHIVE_DIR', '#770: internal — CLI raw archive directory path'],
  ['LOG_DIR', '#770: internal — log directory path'],
  ['LOG_LEVEL', '#770: internal — log level (Pino)'],
  ['SIGNALS_ROOT_DIR', '#770: internal — Signals data directory path'],
  ['WEB_PUBLIC_DIR', '#770: internal — web public asset directory path'],
  ['CONNECTOR_MEDIA_DIR', '#770: internal — connector media directory path'],
  ['TTS_CACHE_DIR', '#770: internal — TTS cache directory path'],
  ['ANNOTATION_DATA_DIR', '#770: internal — annotation data directory path'],
  ['RUNTIME_REPO_PATH', '#770: internal — workspace git repo path'],
  ['CHROME_EXECUTABLE_PATH', '#770: internal — Chrome executable path for image export'],
  ['ALLOWED_WORKSPACE_DIRS', '#770: internal — workspace dirs injected into agent env'],
  ['WORKSPACE_LINKED_ROOTS', '#770: internal — workspace linked roots for security'],
  ['ANTHROPIC_PROXY_PORT', '#770: internal — Anthropic proxy port'],
  ['ANTHROPIC_PROXY_ENABLED', '#770: internal — Anthropic proxy toggle'],
  ['ANTHROPIC_PROXY_UPSTREAMS_PATH', '#770: internal — Anthropic proxy upstreams config path'],
  ['GAME_NARRATOR_ENABLED', '#770: internal — game narrator feature toggle'],
  ['CAT_BRANCH_ROLLBACK_RETRY_DELAYS_MS', '#770: internal tuning — branch rollback retry delays'],
  ['F233_BALL_CUSTODY_PROBE_INTERVAL_MS', '#770: internal tuning — F233 ball custody probe interval'],
  ['F233_FEAT_TRAJECTORY_COLLECTOR_INTERVAL_MS', '#770: internal tuning — F233 feat trajectory collector interval'],
  ['WEB_PUSH_TIMEOUT_MS', '#770: internal tuning — web push timeout'],
  ['COMMUNITY_PUBLISH_DEFAULT_REPO', '#770: internal — community publish default repo'],
  ['COMMUNITY_PUBLISH_REPO_ALLOWLIST', '#770: internal — community publish repo allowlist'],
  ['COMMUNITY_NARRATOR_THREAD_ID', '#770: internal — community narrator thread ID'],
  // ── #770: Credentials/tokens — managed via credentials.json or dedicated auth flows ──
  ['GITHUB_TOKEN', '#770: credential — managed via gh auth / credentials.json'],
  ['GITHUB_AUTHORITATIVE_REVIEW_LOGINS', '#770: internal — GitHub review authoritative logins'],
  ['VAPID_PUBLIC_KEY', '#770: credential — VAPID web push public key'],
  ['VAPID_PRIVATE_KEY', '#770: credential — VAPID web push private key'],
  ['VAPID_SUBJECT', '#770: credential — VAPID web push subject'],
  // ── #770: External service URLs — infrastructure, not end-user settings ──
  ['TTS_URL', '#770: service URL — TTS (MlxAudio) service address'],
  ['WHISPER_URL', '#770: service URL — Whisper STT service address'],
  ['AUDIO_SERVICE_URL', '#770: service URL — audio service address'],
  ['NEXT_PUBLIC_API_URL', '#770: service URL — Next.js public API URL (build-time)'],
  // ── #770: Standard env vars (uppercase variants) ──
  ['HTTPS_PROXY', '#770: standard — proxy convention (uppercase variant)'],
  ['HTTP_PROXY', '#770: standard — proxy convention (uppercase variant)'],
  ['ALL_PROXY', '#770: standard — proxy convention (uppercase variant)'],
]);

// ── Extract registered names from env-registry.ts ──
function loadRegisteredNames() {
  const src = readFileSync(join(ROOT, 'packages/api/src/config/env-registry.ts'), 'utf-8');
  const names = new Set();
  // Match: name: 'VAR_NAME' or name: "VAR_NAME"
  for (const m of src.matchAll(/name:\s*['"]([A-Z_][A-Z0-9_]*)['"],?/g)) {
    names.add(m[1]);
  }
  return names;
}

// ── Recursively collect .ts files ──
function collectTsFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

// ── Extract process.env references from source files ──
function extractEnvRefs(dirs) {
  /** @type {Map<string, string[]>} varName → [file:line, ...] */
  const refs = new Map();

  for (const dir of dirs) {
    const absDir = join(ROOT, dir);
    try {
      statSync(absDir);
    } catch {
      continue;
    }
    for (const file of collectTsFiles(absDir)) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      let inBlockComment = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trimStart();
        // Track multi-line block comments
        if (inBlockComment) {
          if (line.includes('*/')) {
            inBlockComment = false;
          }
          continue;
        }
        // Single-line block comment: /** ... */ or /* ... */ on one line
        if (trimmed.startsWith('/*') && line.includes('*/')) continue;
        // Start of multi-line block comment (no closing on same line)
        if (trimmed.startsWith('/*')) {
          inBlockComment = true;
          continue;
        }
        // Skip pure line comments
        if (trimmed.startsWith('//')) continue;
        // Strip inline comments before matching (trailing // and inline /* */)
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
        // Match process.env.VAR_NAME and process.env['VAR_NAME']
        const dotMatches = code.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g);
        const bracketMatches = code.matchAll(/process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g);
        for (const m of [...dotMatches, ...bracketMatches]) {
          const name = m[1];
          if (!refs.has(name)) refs.set(name, []);
          refs.get(name).push(`${file.replace(ROOT + '/', '')}:${i + 1}`);
        }
      }
    }
  }

  return refs;
}

// ── Tests ──
describe('env-registry completeness', () => {
  const registeredNames = loadRegisteredNames();
  const envRefs = extractEnvRefs(['packages/api/src', 'packages/mcp-server/src']);
  const repoInboxEnvNames = ['GITHUB_WEBHOOK_SECRET', 'GITHUB_REPO_ALLOWLIST', 'GITHUB_REPO_INBOX_CAT_ID'];
  const githubSelfFilterEnvNames = ['GITHUB_SELF_LOGIN'];
  const weixinRuntimeFlagNames = [
    'WEIXIN_VOICE_ITEM_MODE',
    'WEIXIN_ENABLE_UNSAFE_VOICE_MODES',
    'WEIXIN_CAPTURE_INBOUND_VOICE_MEDIA',
  ];

  it('every allowlist entry has a non-empty reason', () => {
    for (const [name, reason] of ALLOWLIST) {
      assert.ok(reason && reason.length > 0, `ALLOWLIST entry "${name}" has no reason`);
    }
  });

  it('keeps GitHub Repo Inbox process env vars in env-registry', () => {
    for (const name of repoInboxEnvNames) {
      assert.ok(registeredNames.has(name), `${name} should be registered in env-registry.ts`);
      assert.ok(!ALLOWLIST.has(name), `${name} is runtime user config and must not be allowlisted`);
    }
  });

  it('keeps GitHub feedback self-filter fallback in env-registry', () => {
    for (const name of githubSelfFilterEnvNames) {
      assert.ok(registeredNames.has(name), `${name} should be registered in env-registry.ts`);
      assert.ok(!ALLOWLIST.has(name), `${name} is runtime user config and must not be allowlisted`);
    }
  });

  it('keeps Weixin runtime voice flags in env-registry', () => {
    for (const name of weixinRuntimeFlagNames) {
      assert.ok(registeredNames.has(name), `${name} should stay registered; it is not a connector credential`);
      assert.ok(!ALLOWLIST.has(name), `${name} is not declared in connectors/weixin/connector.yaml`);
    }
  });

  it('every process.env.XXX is registered or allowlisted', () => {
    const missing = [];
    for (const [name, locations] of envRefs) {
      if (!registeredNames.has(name) && !ALLOWLIST.has(name)) {
        missing.push({ name, locations: locations.slice(0, 3) });
      }
    }
    if (missing.length > 0) {
      const lines = missing.map((m) => `  ${m.name} (${m.locations.join(', ')})`);
      assert.fail(
        `${missing.length} env var(s) used in code but not registered in env-registry.ts:\n` +
          lines.join('\n') +
          '\n\nFix: add to ENV_VARS in packages/api/src/config/env-registry.ts, ' +
          'or add to ALLOWLIST in this script with a reason.',
      );
    }
  });

  it('no allowlist entry that is actually registered (redundant)', () => {
    const redundant = [];
    for (const name of ALLOWLIST.keys()) {
      if (registeredNames.has(name)) {
        redundant.push(name);
      }
    }
    if (redundant.length > 0) {
      assert.fail(`These ALLOWLIST entries are already registered (remove from allowlist): ${redundant.join(', ')}`);
    }
  });
});
