import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolveCliCommand } from '../utils/cli-resolve.js';
import { readCodexAccountIdentity, sameCodexIdentity } from './codex-account-identity.js';

const POLICY_PROBE =
  'ObjC.import("Foundation"); ObjC.bindFunction("CFPreferencesAppValueIsForced", ["bool", ["id", "id"]]); JSON.stringify(["config_toml_base64", "requirements_toml_base64"].map(function(k) { return $.CFPreferencesAppValueIsForced($(k), $("com.openai.codex")); }));';
/** Explicit admission for the measured version/platform. Never disable an operator's native policy. */
export function assertCodexManagedPlatformSupport(home: string, command = 'codex'): void {
  if (process.platform !== 'darwin') throw new Error('codex_managed_platform_unsupported');
  if (['/etc/codex/managed_config.toml', '/etc/codex/requirements.toml'].some(existsSync))
    throw new Error('codex_managed_policy_unsupported');
  if (process.platform === 'darwin') {
    let flags: unknown;
    try {
      flags = JSON.parse(
        execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', POLICY_PROBE], {
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      );
    } catch {
      throw new Error('codex_managed_policy_unavailable');
    }
    if (!Array.isArray(flags) || flags.length !== 2 || flags.some((flag) => flag !== false))
      throw new Error('codex_managed_policy_unsupported');
  }
  const native = resolveCliCommand('codex');
  const selected = resolveCliCommand(command);
  if (!native || !selected || realpathSync(native) !== realpathSync(selected))
    throw new Error('codex_managed_native_carrier_required');
  const version = execFileSync(native, ['--version'], {
    encoding: 'utf8',
    timeout: 2000,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, NODE_ENV: process.env.NODE_ENV ?? 'production' },
  }).trim();
  if (version !== 'codex-cli 0.159.0') throw new Error('codex_managed_version_unsupported');
}
/** Recreated control/attachment hosts consume their original accepted environment before acquisition. */
export function assertCodexManagedCarrierSupport(
  env: Record<string, string | null> | undefined,
  command: string,
): void {
  if (!env?.CODEX_CAT_EXPECTED_USER_ID) return;
  const home = env.CODEX_CAT_EXPECTED_CREDENTIAL_HOME;
  const workspaceId = env.CODEX_CAT_EXPECTED_WORKSPACE_ID;
  if (!home || !workspaceId) throw new Error('codex_account_identity_unavailable');
  assertCodexManagedPlatformSupport(home, command);
  const identity = readCodexAccountIdentity(home);
  if (!sameCodexIdentity({ userId: env.CODEX_CAT_EXPECTED_USER_ID, workspaceId }, identity))
    throw new Error('codex_account_identity_unavailable');
}
