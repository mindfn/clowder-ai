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
import { PluginConfigPanel } from './PluginConfigPanel';

const STATUS_CONFIG: Record<PluginStatus, { label: string; bg: string; text: string }> = {
  enabled: { label: '已启用', bg: 'bg-conn-emerald-bg', text: 'text-conn-emerald-text' },
  configured: { label: '已配置', bg: 'bg-conn-amber-bg', text: 'text-conn-amber-text' },
  partial: { label: '部分启用', bg: 'bg-conn-amber-bg', text: 'text-conn-amber-text' },
  not_configured: { label: '未配置', bg: 'bg-cafe-surface-sunken', text: 'text-cafe-muted' },
};

export function PluginsContent() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchPlugins = useCallback(async () => {
    try {
      const res = await apiFetch('/api/plugins');
      const data: PluginInfo[] = res.ok
        ? (((await res.json()) as { plugins: PluginInfo[] }).plugins ?? [])
        : [];
      setPlugins(data);
    } catch {
      setPlugins([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPlugins();
  }, [fetchPlugins]);

  if (loading) return <p className="text-sm text-cafe-muted">加载中...</p>;

  if (plugins.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl bg-[var(--console-card-bg)] px-8 py-16 text-center">
        <HubIcon name="blocks" className="mb-3 h-10 w-10 text-cafe-muted opacity-40" />
        <p className="text-[15px] font-semibold text-cafe">暂无已安装的插件</p>
        <p className="mt-1 text-xs text-cafe-muted">插件在 plugins/ 目录下管理</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3.5" data-testid="plugins-list">
      {plugins.map((plugin) => {
        const statusCfg = STATUS_CONFIG[plugin.status];
        const isExpanded = expandedId === plugin.id;

        return (
          <article key={plugin.id} className={settingsResourceCardClass}>
            <button
              type="button"
              className={`${settingsResourceRowClass} w-full text-left`}
              onClick={() => setExpandedId(isExpanded ? null : plugin.id)}
            >
              <div className={settingsResourceAvatarClass} style={{ backgroundColor: plugin.iconBg ?? '#9ca3af' }}>
                <HubIcon name={plugin.icon ?? 'blocks'} className="h-5 w-5 text-[var(--cafe-surface)]" />
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

            {isExpanded && <PluginConfigPanel plugin={plugin} onUpdated={fetchPlugins} />}
          </article>
        );
      })}
    </div>
  );
}
