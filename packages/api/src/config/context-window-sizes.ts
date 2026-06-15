/**
 * Context Window Size Fallback Table
 * F24: Hardcoded model → context window mapping for cats whose CLI
 * doesn't report window size (Codex exec, Gemini -p).
 *
 * Claude CLI reports exact values via modelUsage[model].contextWindow,
 * so these entries are fallback only.
 * Update when new models are released or window sizes change.
 */

export const CONTEXT_WINDOW_SIZES: Record<string, number> = {
  // Claude (exact values from CLI, these are fallback)
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,
  // Codex/GPT
  'gpt-5.3': 128_000,
  'gpt-5.2': 128_000,
  'gpt-5.1-codex': 400_000,
  o3: 200_000,
  'o4-mini': 200_000,
  // Gemini
  'gemini-2.5-pro': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
  'gemini-3-pro': 1_000_000,
  'gemini-3.1-pro-preview': 1_000_000,
};

export function getContextWindowFallback(model: string): number | undefined {
  if (CONTEXT_WINDOW_SIZES[model]) return CONTEXT_WINDOW_SIZES[model];
  // Try prefix match (e.g. 'claude-opus-4-6-20260101' matches 'claude-opus-4-6')
  for (const [key, value] of Object.entries(CONTEXT_WINDOW_SIZES)) {
    if (model.startsWith(key)) return value;
  }
  return undefined;
}
