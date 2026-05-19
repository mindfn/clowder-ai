/** Callback env keys injected per-invocation into cat-cafe MCP servers (single source of truth). */
export const MCP_CALLBACK_ENV_KEYS = [
  'CAT_CAFE_API_URL',
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_USER_ID',
  'CAT_CAFE_CAT_ID',
  'CAT_CAFE_THREAD_ID',
  'CAT_CAFE_SIGNAL_USER',
  'CAT_CAFE_RUN_TYPE',
  'CAT_CAFE_AUDIT_TOPIC',
] as const;
