/**
 * #770: env vars that should NOT appear in the generic 「环境 & 文件」 dump
 * because they are already covered by a dedicated module UI.
 *
 * Keep this list in sync with the actual module UI sources:
 * - Memory switches: packages/web/src/components/memory/IndexStatus.tsx
 * - Prompt X-Ray: packages/web/src/components/HubObservabilityOverview.tsx
 * - Theme: packages/web/src/stores/themeStore.ts
 * - Accounts: packages/web/src/components/HubAccountsTab.tsx
 * - Push: packages/web/src/components/settings/PushServiceConfig.tsx
 * - Codex behavior: packages/web/src/components/hub-cat-editor-advanced.tsx
 * - Default cat: packages/web/src/components/settings/DefaultCatSelector.tsx (via members page)
 * - GitHub plugin: packages/api/src/plugins/github/plugin.yaml (PluginConfigPanel)
 * - Audit log privacy: packages/web/src/components/settings/OpsContent.tsx (AuditLogPrivacyToggle)
 *
 * Hard rule: a var is only added here after verifying the module UI both reads
 * AND persists it. If a claimed UI does not cover the var, leave it in the dump
 * and flag it — never orphan a config key.
 */
export const ENV_DUMP_DENYLIST = new Set([
  // --- F102/F163/F200 memory switches (IndexStatus.tsx) ---
  'EMBED_MODE',
  'F102_ABSTRACTIVE',
  'F102_DURABLE_CANDIDATES',
  'F102_TOPIC_SEGMENTS',
  'F200_CONSUMPTION_RERANK',
  'F163_AUTHORITY_BOOST',
  'F163_ALWAYS_ON_INJECTION',
  'F163_RETRIEVAL_RERANK',
  'F163_COMPRESSION',
  'F163_PROMOTION_GATE',
  'F163_CONTRADICTION_DETECTION',
  'F163_REVIEW_QUEUE',
  'F102_API_BASE',

  // --- GitHub plugin (PluginConfigPanel renders plugin.yaml config) ---
  'GITHUB_TOKEN',
  'GITHUB_MCP_PAT',
  'GITHUB_SETUP_NOISE_BOT_LOGINS',

  // --- Codex per-cat / global behavior (HubCatEditor + ConfigStore) ---
  'CAT_CODEX_SANDBOX_MODE',
  'CAT_CODEX_APPROVAL_POLICY',
  'CAT_CAFE_CODEX_CARRIER',
  'CODEX_AUTH_MODE',

  // --- Accounts / credentials (HubAccountsTab) ---
  'OPENAI_API_KEY',
  'F102_API_KEY',

  // --- Push service (PushServiceConfig.tsx) ---
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT',

  // --- Prompt X-Ray (HubObservabilityOverview.tsx) ---
  'PROMPT_CAPTURE',
  'PROMPT_CAPTURE_CATS',

  // --- Theme (F056 Theme Tuner / themeStore) ---
  'THEME_CONFIG',

  // --- Default cat selector ---
  'DEFAULT_CAT_ID',

  // --- Audit log privacy (OpsContent.tsx AuditLogPrivacyToggle) ---
  'AUDIT_LOG_INCLUDE_PROMPT_SNIPPETS',
]);
