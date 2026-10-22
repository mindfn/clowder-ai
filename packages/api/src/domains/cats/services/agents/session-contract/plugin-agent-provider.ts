/** Internal / unstable: data only. The Host owns transport construction. */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
export const AGENT_PROVIDER_DECLARATION_FILE = 'agent-provider.json';
const acpSchema = z.strictObject({
  command: z.string().min(1),
  startupArgs: z.array(z.string()),
  mcpWhitelist: z.array(z.string()).optional(),
});
export interface AgentProviderDeclaration {
  id: string;
  transport: 'acp';
  acp: z.infer<typeof acpSchema>;
}
export type AgentProviderDeclarationResult =
  | { ok: true; declaration: AgentProviderDeclaration }
  | { ok: false; code: 'invalid_declaration' | 'transport_not_allowed' | 'package_command_forbidden'; reason: string };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function parseAgentProviderDeclaration(
  raw: unknown,
  ctx: { packageRoot: string },
): AgentProviderDeclarationResult {
  const invalid = { ok: false, code: 'invalid_declaration', reason: 'Invalid agent provider declaration' } as const;
  if (!record(raw) || Object.keys(raw).some((key) => !['id', 'transport', 'acp'].includes(key))) return invalid;
  if (typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw.id) || typeof raw.transport !== 'string')
    return invalid;
  if (raw.transport !== 'acp')
    return { ok: false, code: 'transport_not_allowed', reason: 'Only ACP transport is allowed' };
  if (!record(raw.acp)) return invalid;
  const parsed = acpSchema.safeParse(raw.acp);
  if (!parsed.success) return invalid;
  const inside = (path: string) => {
    const rel = relative(resolve(ctx.packageRoot), resolve(path));
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
  };
  const { command, startupArgs } = parsed.data;
  if (
    (/[\\/]/.test(command) && (!isAbsolute(command) || inside(command))) ||
    startupArgs.some((arg) => isAbsolute(arg) && inside(arg))
  )
    return {
      ok: false,
      code: 'package_command_forbidden',
      reason: 'Package commands and package script arguments are forbidden',
    };
  return { ok: true, declaration: { id: raw.id, transport: 'acp', acp: parsed.data } };
}
