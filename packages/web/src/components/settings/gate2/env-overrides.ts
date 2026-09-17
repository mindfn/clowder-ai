import { useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { EnvVar } from '../EnvSubComponents';

export async function patchEnv(updates: Array<{ name: string; value: string }>): Promise<string | null> {
  try {
    const res = await apiFetch('/api/config/env', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? '保存失败';
  } catch {
    return '保存失败';
  }
}

/**
 * Local overrides for .env vars this page just wrote. env-summary is fetched
 * once by the parent and intentionally NOT refetched after a save (#770 P0
 * D7: a refetch returns the stale pre-restart currentValue and bounces the
 * UI) — so the just-written value lives here until the next real reload.
 */
export function useEnvOverrides() {
  const [envOverrides, setEnvOverrides] = useState<Record<string, string>>({});
  const effectiveEnvValue = useCallback(
    (envVarEntry: EnvVar | undefined) =>
      envVarEntry ? (envOverrides[envVarEntry.name] ?? envVarEntry.currentValue ?? '') : '',
    [envOverrides],
  );
  return { envOverrides, setEnvOverrides, effectiveEnvValue };
}
