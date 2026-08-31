---
topics: [env-registry, config-consolidation, app-like-settings, "#770"]
created: 2026-08-31
owner: opus (design) / kimi (impl)
---

# #770 Config Consolidation — Execution Spec (app-like config)

## Goal (co-creator vision, 2026-08-31)

Config should feel like a normal desktop app: **sensible defaults + only surface the few
things a user actually decides + each setting lives in its own module's page + no "env wall"**.
No desktop app makes the user fill in dozens/hundreds of env vars.

Do the **whole** consolidation in ONE pass (no incremental follow-ups). Land it in
`feat/770-terminal-consolidation`.

## End state

- The old **「环境 & 文件」 env-var dump** (`HubEnvFilesTab` / `EnvSubComponents`, currently
  ~95 visible vars, 79 read-only) → **near-zero user-facing env vars**.
- Every user-relevant setting is edited in its **module page** (memory / accounts / plugins /
  voice / push / theme / members).
- System read-only knobs (ports/paths/TTL) → a **collapsed "系统信息（高级）" read-only** area,
  not the main surface.
- Internal / dead / deploy-level / niche-sidecar vars → **hidden** (`hubVisible:false`), still
  settable via `.env` for the rare self-hoster.
- A **guard** so the wall can't regrow.

## Design decisions (opus — reversible, flag if you disagree)

1. **Self-hosted sidecar endpoints** (`TTS_URL`, `WHISPER_URL`, `AUDIO_SERVICE_URL`,
   `NEXT_PUBLIC_LLM_POSTPROCESS_URL`, `NEXT_PUBLIC_WHISPER_URL`) → **hide** (bucket ②). They
   remain env-settable; we do NOT build UI for them and we do NOT delete the capability. If we
   later decide to drop sidecar support entirely, that's a separate deliberate removal.
2. **System read-only vars** → collapsed "系统信息（高级）" read-only section (bucket ③), not
   fully hidden — preserves at-a-glance visibility for support/debug (what port am I on?).

---

## Buckets (all 95 visible vars)

> Counts are the current `hubVisible` set. `kimi` must **verify each ① module UI actually
> renders + persists the var before removing it from the dump** — if a claimed module UI does
> NOT cover it, do NOT remove; flag it for opus. Never orphan a var.

### ① Remove from the dump — already covered by a dedicated module UI (~35)

| var(s) | target module UI (claimed by 770-env-config-inventory.md — VERIFY) |
|---|---|
| `EMBED_MODE`, `F102_ABSTRACTIVE`, `F102_DURABLE_CANDIDATES`, `F102_TOPIC_SEGMENTS`, `F200_CONSUMPTION_RERANK`, `F163_AUTHORITY_BOOST`, `F163_ALWAYS_ON_INJECTION`, `F163_RETRIEVAL_RERANK`, `F163_COMPRESSION`, `F163_PROMOTION_GATE`, `F163_CONTRADICTION_DETECTION`, `F163_REVIEW_QUEUE`, `F102_API_BASE` | 记忆系统专用模块 UI |
| `GITHUB_TOKEN`, `GITHUB_MCP_PAT`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_SELF_LOGIN`, `GITHUB_REPO_ALLOWLIST`, `GITHUB_REPO_INBOX_CAT_ID`, `GITHUB_SETUP_NOISE_BOT_LOGINS` | GitHub PluginConfigPanel（若 repo-inbox 字段缺 → 归 ⑤ 补 UI） |
| `CAT_CODEX_SANDBOX_MODE`, `CAT_CODEX_APPROVAL_POLICY`, `CAT_CAFE_CODEX_CARRIER`, `CODEX_AUTH_MODE` | HubCatEditor / 成员设置 |
| `OPENAI_API_KEY`, `F102_API_KEY` | HubAccountsTab / 账号 |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | PushServiceConfig |
| `PROMPT_CAPTURE`, `PROMPT_CAPTURE_CATS` | Prompt X-Ray 面板 |
| `THEME_CONFIG` | F056 Theme Tuner |
| `GENSHIN_VOICE_DIR`, `CHARACTER_VOICE_DIR` | 语音模块 UI |
| `DEFAULT_CAT_ID` | DefaultCatSelector |

### ② Hide (`hubVisible:false`) — internal / dead / deploy / sidecar (~32) — zero risk

- **Memory internal service paths**: `EMBED_URL`, `GLOBAL_KNOWLEDGE_DB`, `TASK_OUTCOME_DB`, `EVENT_MEMORY_DB`, `EMBED_PORT`
- **DEAD GitHub IMAP channel** (removed v0.9.0 / #596): `GITHUB_REVIEW_IMAP_USER`, `GITHUB_REVIEW_IMAP_PASS`, `GITHUB_REVIEW_IMAP_HOST`, `GITHUB_REVIEW_IMAP_PORT`, `GITHUB_REVIEW_IMAP_PROXY`, `GITHUB_REVIEW_POLL_INTERVAL_MS` + `GITHUB_AUTHORITATIVE_REVIEW_LOGINS` (F140 deprecated)
- **DEAD**: `MODE_SWITCH_REQUIRES_APPROVAL` (F101 removed consumer)
- **Sidecar endpoints** (decision 1): `TTS_URL`, `WHISPER_URL`, `AUDIO_SERVICE_URL`, `NEXT_PUBLIC_LLM_POSTPROCESS_URL`, `NEXT_PUBLIC_WHISPER_URL`
- **Internal/deploy misc**: `LISTEN_MODE_DB`, `QUOTA_OFFICIAL_REFRESH_ENABLED`, `CLAUDE_CREDENTIALS_PATH`, `CODEX_CREDENTIALS_PATH`, `ANTIGRAVITY_AUTO_APPROVE`, `ANTIGRAVITY_AUTO_RESUME`, `ANTIGRAVITY_YOLO_RUN_COMMAND`, `SIGNALS_ROOT_DIR`, `CAT_CAFE_SIGNAL_USER`, `TRANSCRIPT_DIR`, `WEB_PUSH_TIMEOUT_MS`, `PROMETHEUS_PORT`, `LOG_DIR`
> Do NOT physically delete deprecated registry entries (maintainer policy) — only `hubVisible:false`.

### ③ Collapse into "系统信息（高级）" read-only section (~28)

- server: `API_SERVER_PORT`, `PREVIEW_GATEWAY_PORT`(keep editable), `API_SERVER_HOST`, `CORS_ALLOW_PRIVATE_NETWORK`, `PROJECT_ALLOWED_ROOTS`, `PROJECT_ALLOWED_ROOTS_APPEND`, `PROJECT_DENIED_ROOTS`, `FRONTEND_URL`, `FRONTEND_PORT`, `DEFAULT_OWNER_USER_ID`, `LOG_LEVEL`, `PREVIEW_GATEWAY_ENABLED`
- storage: `REDIS_URL`, `REDIS_KEY_PREFIX`, `MEMORY_STORE`, `MESSAGE_TTL_SECONDS`, `THREAD_TTL_SECONDS`, `TASK_TTL_SECONDS`, `SUMMARY_TTL_SECONDS`, `BACKLOG_TTL_SECONDS`, `DRAFT_TTL_SECONDS`, `DATA_DIR`, `CACHE_DIR`, `ANNOTATION_DATA_DIR`, `DOCS_ROOT`
- cli: `CLI_TIMEOUT_MS`, `CAT_CAFE_DATA_DIR` · budget: `MAX_A2A_DEPTH`
> This is the existing `HubSystemSettingsTab` (P4). It should become the ONLY home for these;
> the dump must stop re-listing them. Default-collapsed.

### ⑤ Build a small dedicated UI (1–2)

- `AUDIT_LOG_INCLUDE_PROMPT_SNIPPETS` — audit-log privacy toggle (ops/审计设置)
- GitHub repo-inbox fields, IF PluginConfigPanel doesn't already cover them (verify in ①)

---

## Guard (so the wall can't regrow)

- Add a lint/test: any new `ENV_VARS` entry must either declare a module section (via
  `env-sections.ts`) OR set `hubVisible:false` with a justification comment. New vars default
  to hidden.
- Keeps "future config is app-like" a durable invariant, not a one-time cleanup.

## Implementation order (one pass, tests green each step)

1. **② Hide** (biggest visible reduction, lowest risk) → confirm each is still `.env`-settable.
2. **① Remove** from the dump — verify each module UI covers the var first; orphan check.
3. **③** Make `HubSystemSettingsTab` the sole home for system vars; dump stops re-listing them;
   default-collapse the advanced section.
4. **⑤** audit-log toggle (+ repo-inbox fields if needed).
5. **Guard** + test.
6. `pnpm build` + targeted tests + web `tsc/lint`; then opus review; then co-creator 体验验收.

## Red-lines (unchanged)

- P1 (6 deleted) / P3 (hidden) / 8 deprecated-marked stay intact.
- No orphaned var (every removed-from-dump var has a working module home).
- Every step passes tests before commit; no unverified progress.
- The dump's final user-facing editable count should be ~0 (excl. the advanced collapsed area).
