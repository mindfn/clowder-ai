'use client';

import type { PluginInfo, PluginStatus } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { HubIcon } from '../hub-icons';
import {
  settingsResourceActionGroupClass,
  settingsResourceAvatarClass,
  settingsResourceCardClass,
  settingsResourceRowClass,
} from '../SettingsResourceCard';
import { GithubConfigPanel } from './GithubConfigPanel';
import { PluginConfigPanel } from './PluginConfigPanel';

const STATUS_CONFIG: Record<PluginStatus, { label: string; bg: string; text: string }> = {
  enabled: { label: '已启用', bg: 'bg-conn-emerald-bg', text: 'text-conn-emerald-text' },
  configured: { label: '已配置', bg: 'bg-conn-amber-bg', text: 'text-conn-amber-text' },
  partial: { label: '部分启用', bg: 'bg-conn-amber-bg', text: 'text-conn-amber-text' },
  not_configured: { label: '未配置', bg: 'bg-cafe-surface-sunken', text: 'text-cafe-muted' },
};

const PLUGIN_ICONS: Record<string, { icon: string; bg: string }> = {
  github: { icon: 'git-branch', bg: '#24292e' },
  'weixin-mp': { icon: 'megaphone', bg: '#07c160' },
};

const BUILTIN_PLUGINS: PluginInfo[] = [
  {
    id: 'github',
    name: 'GitHub',
    version: '1.0.0',
    description: 'PR Tracking, Review Router, CI/CD Monitor',
    status: 'configured',
    configured: true,
    config: [],
    resources: [],
    hasHealthCheck: false,
  },
];

export function PluginsContent() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchPlugins = useCallback(async () => {
    try {
      const res = await apiFetch('/api/plugins');
      const dynamicPlugins: PluginInfo[] = res.ok
        ? (((await res.json()) as { plugins: PluginInfo[] }).plugins ?? [])
        : [];
      const dynamicIds = new Set(dynamicPlugins.map((p) => p.id));
      setPlugins([...BUILTIN_PLUGINS.filter((p) => !dynamicIds.has(p.id)), ...dynamicPlugins]);
    } catch {
      setPlugins(BUILTIN_PLUGINS);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPlugins();
  }, [fetchPlugins]);

  if (loading) return <p className="text-sm text-cafe-muted">加载中...</p>;

  return (
    <div className="flex flex-col gap-3.5" data-testid="plugins-list">
      {plugins.map((plugin) => {
        const statusCfg = STATUS_CONFIG[plugin.status];
        const iconCfg = PLUGIN_ICONS[plugin.id];
        const isExpanded = expandedId === plugin.id;

        return (
          <article key={plugin.id} className={settingsResourceCardClass}>
            <button
              type="button"
              className={`${settingsResourceRowClass} w-full text-left`}
              onClick={() => setExpandedId(isExpanded ? null : plugin.id)}
            >
              <div className={settingsResourceAvatarClass} style={{ backgroundColor: iconCfg?.bg ?? '#9ca3af' }}>
                <HubIcon name={iconCfg?.icon ?? 'blocks'} className="h-5 w-5 text-[var(--cafe-surface)]" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-cafe">{plugin.name}</p>
                {plugin.description && <p className="mt-0.5 text-xs text-cafe-secondary">{plugin.description}</p>}
              </div>
              <div className={settingsResourceActionGroupClass}>
                <span
                  className={`flex-shrink-0 rounded-[13px] px-2.5 py-0.5 text-label font-medium ${statusCfg.bg} ${statusCfg.text}`}
                >
                  {statusCfg.label}
                </span>
              </div>
            </button>

            {isExpanded &&
              (plugin.id === 'github' ? (
                <GithubConfigPanel />
              ) : (
                <PluginConfigPanel plugin={plugin} onUpdated={fetchPlugins} />
              ))}
          </article>
        );
      })}
    </div>
  );
}
