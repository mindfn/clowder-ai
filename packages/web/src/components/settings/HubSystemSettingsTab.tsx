'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { EnvVar } from './EnvSubComponents';
import { SettingsStatusStrip } from './primitives';
import { SystemSettingsGate2 } from './SystemSettingsGate2';

interface SystemSummaryResponse {
  groups: Record<string, string>;
  variables: EnvVar[];
}

export function HubSystemSettingsTab() {
  const [data, setData] = useState<SystemSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetch('/api/config/env-summary?surface=system')
      .then(async (response) => {
        if (response.ok) {
          setData((await response.json()) as SystemSummaryResponse);
          return;
        }
        setError(`加载失败 (${response.status})`);
      })
      .catch(() => setError('无法连接服务'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <SettingsStatusStrip tone="error">{error}</SettingsStatusStrip>;
  if (!data) return <SettingsStatusStrip tone="info">加载系统设置…</SettingsStatusStrip>;

  // #770 Gate 2: the curated status + five-decisions view replaces the env-var
  // dump (former SystemSettingsView). No post-save refetch by design (P0 D7) —
  // just-written values live in the view's local overrides.
  return <SystemSettingsGate2 variables={data.variables} />;
}
