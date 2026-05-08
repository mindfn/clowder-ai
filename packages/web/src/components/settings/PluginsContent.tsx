'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { HubIcon } from '../hub-icons';
import { SettingsPageHeader } from './SettingsPageHeader';

interface ServiceEntry {
  manifest: { id: string; enablesFeatures: string[] };
  status: 'running' | 'stopped' | 'error' | 'unknown';
}

export interface PluginStatus {
  id: string;
  label: string;
  icon: string;
  source: 'platform' | 'service';
  status: 'active' | 'configured' | 'available';
  statusLabel: string;
  featureKeys: string[];
}

const PLATFORM_PLUGINS: Omit<PluginStatus, 'status' | 'statusLabel'>[] = [
  { id: 'github', label: 'GitHub', icon: 'github', source: 'platform', featureKeys: [] },
];

const SERVICE_PLUGINS: Omit<PluginStatus, 'status' | 'statusLabel'>[] = [
  {
    id: 'voice-companion',
    label: '语音伴侣',
    icon: 'mic',
    source: 'service',
    featureKeys: ['voice-input', 'voice-output', 'voice-companion', 'connector-stt'],
  },
];

export function resolvePluginStatuses(services: ServiceEntry[], apiReachable: boolean): PluginStatus[] {
  const result: PluginStatus[] = [];

  for (const def of PLATFORM_PLUGINS) {
    if (apiReachable) {
      result.push({ ...def, status: 'active', statusLabel: '已连接' });
    } else {
      result.push({ ...def, status: 'available', statusLabel: 'API 不可达' });
    }
  }

  for (const def of SERVICE_PLUGINS) {
    const matching = services.filter((s) => s.manifest.enablesFeatures.some((f) => def.featureKeys.includes(f)));
    if (matching.length === 0) {
      result.push({ ...def, status: 'available', statusLabel: '未连接' });
    } else if (matching.some((s) => s.status === 'running')) {
      result.push({ ...def, status: 'active', statusLabel: '已连接' });
    } else {
      result.push({ ...def, status: 'configured', statusLabel: '已配置' });
    }
  }

  return result;
}

const STATUS_STYLES: Record<PluginStatus['status'], string> = {
  active: 'bg-conn-emerald-bg text-conn-emerald-text border-conn-emerald-ring',
  configured: 'bg-conn-amber-bg text-conn-amber-text border-conn-amber-ring',
  available: 'bg-[var(--console-card-bg)] text-cafe-muted border-[var(--console-border-soft)]',
};

export function PluginsContent() {
  const [services, setServices] = useState<ServiceEntry[]>([]);
  const [apiReachable, setApiReachable] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchServices = useCallback(async () => {
    try {
      const res = await apiFetch('/api/services');
      if (res.ok) {
        const data = (await res.json()) as { services: ServiceEntry[] };
        setServices(data.services ?? []);
        setApiReachable(true);
      } else {
        setApiReachable(false);
      }
    } catch {
      setApiReachable(false);
    }
  }, []);

  useEffect(() => {
    void fetchServices();
  }, [fetchServices]);

  const plugins = resolvePluginStatuses(services, apiReachable);

  return (
    <div className="space-y-5">
      <SettingsPageHeader title="插件/集成" subtitle="插件状态、外部集成以及安装结果" />
      <div className="space-y-2">
        {plugins.map((plugin) => (
          <div key={plugin.id}>
            <button
              type="button"
              className="w-full rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-4 py-3 text-left transition-colors hover:border-[var(--console-border-strong)]"
              onClick={() => setExpandedId(expandedId === plugin.id ? null : plugin.id)}
            >
              <div className="flex items-center gap-3">
                <HubIcon name={plugin.icon} className="h-5 w-5 text-cafe-secondary" />
                <span className="flex-1 text-sm font-medium text-cafe">{plugin.label}</span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[plugin.status]}`}
                >
                  {plugin.statusLabel}
                </span>
              </div>
            </button>
            {expandedId === plugin.id && plugin.id === 'github' && (
              <div className="px-4 py-3 text-xs text-cafe-muted">GitHub 配置面板（规划中）</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
