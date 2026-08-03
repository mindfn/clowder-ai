export const DEFAULT_CLI_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_CLI_TIMEOUT_LABEL = `${DEFAULT_CLI_TIMEOUT_MS} (30分钟)`;

/**
 * Invocation hard timeout = cliTimeout × INVOCATION_TIMEOUT_MULTIPLIER.
 * Node setTimeout overflows silently at 2^31 - 1 ms (fires as 1ms timer).
 * Both constants are defined here so every entry point (env PATCH,
 * ConfigStore `/config set`, runtime parser) enforces the same ceiling.
 */
export const INVOCATION_TIMEOUT_MULTIPLIER = 2;

/** Max safe CLI_TIMEOUT_MS = floor((2^31 - 1) / INVOCATION_TIMEOUT_MULTIPLIER) ≈ 12.4 days. */
export const MAX_CLI_TIMEOUT_MS = Math.floor((2 ** 31 - 1) / INVOCATION_TIMEOUT_MULTIPLIER);

export function parseCliTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  if (parsed > MAX_CLI_TIMEOUT_MS) return undefined;
  return parsed;
}

export function readCliTimeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return parseCliTimeoutMs(env.CLI_TIMEOUT_MS);
}

export function resolveCliTimeoutMs(overrideMs: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  return overrideMs ?? readCliTimeoutMsFromEnv(env) ?? DEFAULT_CLI_TIMEOUT_MS;
}
