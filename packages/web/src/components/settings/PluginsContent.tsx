'use client';

import { type PluginInfo, resolvePluginDescription } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { HubIcon } from '../hub-icons';
import { GitHubIcon } from '../icons/ConnectorIcons';
import {
  SettingsResourceToggleSwitch,
  settingsResourceActionGroupClass,
  settingsResourceAvatarClass,
  settingsResourceCardClass,
  settingsResourceRowClass,
} from '../SettingsResourceCard';
import { OfficialPluginsPanel } from './OfficialPluginsPanel';
import type { OfficialPluginInfo } from './official-plugin-types';
import { PersonalChromePluginPanel } from './PersonalChromePluginPanel';
import { PluginConfigPanel } from './PluginConfigPanel';
import { PluginManagerContent } from './plugin-manager/PluginManagerContent';
import { PluginManagerLiveContent } from './plugin-manager/PluginManagerLiveContent';
import {
  officialCompatibilityEntry,
  PERSONAL_PRO_COMPATIBILITY_ENTRY,
  repositoryCompatibilityEntry,
} from './plugin-manager/plugin-manager-compatibility-fixtures';
import { resolvePluginManagerDesignGate } from './plugin-manager/plugin-manager-design-gate';
import { PLUGIN_MANAGER_DESIGN_FIXTURES } from './plugin-manager/plugin-manager-fixtures';
import { SettingsBadge } from './primitives/SettingsBadge';
import { SettingsText } from './primitives/SettingsText';

function pluginToggleFailure(data: { status?: string; error?: string }, actionLabel: string): string | undefined {
  if (data.status === 'partial') return data.error ?? `插件${actionLabel}部分成功`;
  if (data.status === 'failed') return data.error ?? `插件${actionLabel}失败`;
  return undefined;
}

export { resolvePluginManagerDesignGate } from './plugin-manager/plugin-manager-design-gate';

function RepositoryPluginCard({
  plugin,
  expanded,
  busy,
  onExpandedChange,
  onToggle,
  onUpdated,
}: {
  plugin: PluginInfo;
  expanded: boolean;
  busy: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onToggle: (plugin: PluginInfo) => void;
  onUpdated: () => Promise<void>;
}) {
  const runtimeEnabled = plugin.status === 'enabled' || plugin.status === 'partial';
  const showResourceToggle = plugin.resources.length > 0 && (plugin.configured || runtimeEnabled);
  const description = plugin.description ? resolvePluginDescription(plugin.description, 'zh-CN') : undefined;

  return (
    <article className={settingsResourceCardClass}>
      <div className={`${settingsResourceRowClass} w-full`}>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3"
          style={{ textAlign: 'left' }}
          onClick={() => onExpandedChange(!expanded)}
        >
          <div
            className={settingsResourceAvatarClass}
            style={{ backgroundColor: plugin.iconBg ?? '#9ca3af', color: 'var(--cafe-image-foreground)' }}
          >
            {plugin.icon === 'github' ? (
              <GitHubIcon className="h-5 w-5" color="var(--cafe-image-foreground)" />
            ) : plugin.icon && typeof plugin.icon === 'object' ? (
              // Terminal Manager rewrites package-relative icon paths to a Host-owned URL.
              // eslint-disable-next-line @next/next/no-img-element
              // biome-ignore lint/performance/noImgElement: package assets are runtime URLs, not build-time imports.
              <img src={plugin.icon.src} alt="" className="h-5 w-5 object-contain" />
            ) : (
              <HubIcon name={plugin.icon ?? 'blocks'} className="h-5 w-5" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <SettingsText as="p" variant="sm" tone="default" className="font-semibold">
              {plugin.name}
            </SettingsText>
            {description && (
              <SettingsText as="p" tone="secondary" className="mt-0.5">
                {description}
              </SettingsText>
            )}
          </div>
        </button>
        <div className={settingsResourceActionGroupClass}>
          <SettingsBadge tone={plugin.configured ? 'amber' : 'slate'} className="shrink-0 font-medium">
            {plugin.configured ? '已配置' : '未配置'}
          </SettingsBadge>
          {showResourceToggle && (
            <SettingsResourceToggleSwitch
              enabled={runtimeEnabled}
              busy={busy}
              onClick={(event) => {
                event.stopPropagation();
                onToggle(plugin);
              }}
            />
          )}
        </div>
      </div>

      {expanded && <PluginConfigPanel plugin={plugin} onUpdated={onUpdated} />}
    </article>
  );
}

export function PluginsContent() {
  const [designGate, setDesignGate] = useState({
    resolved: false,
    enabled: false,
    live: false,
    degradedCatalog: false,
  });
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [officialPlugins, setOfficialPlugins] = useState<OfficialPluginInfo[]>([]);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const fetchPlugins = useCallback(async () => {
    try {
      const res = await apiFetch('/api/plugins');
      const payload = res.ok ? ((await res.json()) as { plugins?: PluginInfo[] }) : {};
      if (!Array.isArray(payload.plugins)) throw new Error('plugin_list_unavailable');
      setPlugins(payload.plugins);
      setReadError(null);
    } catch {
      setReadError('现有插件状态读取失败，保留最后确认状态。');
    }
  }, []);

  const handleToggle = useCallback(
    async (plugin: PluginInfo) => {
      const isEnabled = plugin.status === 'enabled' || plugin.status === 'partial';
      const action = isEnabled ? 'disable' : 'enable';
      const actionLabel = action === 'enable' ? '启用' : '禁用';
      setTogglingId(plugin.id);
      setToggleError(null);
      try {
        const res = await apiFetch(`/api/plugins/${plugin.id}/${action}`, { method: 'POST' });
        if (!res.ok) {
          setToggleError(`插件${actionLabel}失败 (${res.status})`);
          return;
        }
        const data = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
        const failure = pluginToggleFailure(data, actionLabel);
        if (failure) setToggleError(failure);
        await fetchPlugins();
      } catch {
        setToggleError('网络错误');
      } finally {
        setTogglingId(null);
      }
    },
    [fetchPlugins],
  );

  useEffect(() => {
    setDesignGate(resolvePluginManagerDesignGate(window.location.search));
  }, []);

  useEffect(() => {
    if (!designGate.resolved) return;
    if (designGate.enabled || designGate.live) {
      return;
    }
    void fetchPlugins();
  }, [designGate.enabled, designGate.live, designGate.resolved, fetchPlugins]);

  useEffect(() => {
    if (!designGate.resolved || designGate.enabled || designGate.live) return;
    void apiFetch('/api/plugins/official')
      .then(async (response) => {
        if (!response.ok) return;
        const payload = (await response.json()) as { plugins?: OfficialPluginInfo[] };
        setOfficialPlugins((payload.plugins ?? []).filter((plugin) => plugin.pluginId !== 'official.chatgpt-dot'));
      })
      .catch(() => undefined);
  }, [designGate.resolved, designGate.enabled, designGate.live]);

  if (!designGate.resolved) {
    return (
      <div className="flex flex-col gap-3.5" data-testid="plugins-list">
        <SettingsText as="p" variant="sm" tone="muted">
          加载插件中...
        </SettingsText>
      </div>
    );
  }

  if (designGate.enabled) {
    return (
      <PluginManagerContent
        fixtures={PLUGIN_MANAGER_DESIGN_FIXTURES}
        catalogStatus={designGate.degradedCatalog ? 'degraded' : 'fresh'}
      />
    );
  }

  if (designGate.live) return <PluginManagerLiveContent />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {readError && (
        <p role="alert" className="mb-2 text-sm text-conn-red-text">
          {readError}{' '}
          <button type="button" className="underline" onClick={() => void fetchPlugins()}>
            重试读取
          </button>
        </p>
      )}
      <PluginManagerLiveContent
        compatibilityFixtures={[
          PERSONAL_PRO_COMPATIBILITY_ENTRY,
          ...officialPlugins.map(officialCompatibilityEntry),
          ...plugins
            .filter((plugin) => !officialPlugins.some((official) => official.pluginId === plugin.id))
            .map(repositoryCompatibilityEntry),
        ]}
        renderCompatibilityDetail={(pluginId, presentation) => {
          if (pluginId === 'personal-chrome-host') return <PersonalChromePluginPanel />;
          if (officialPlugins.some((plugin) => plugin.pluginId === pluginId))
            return <OfficialPluginsPanel onlyPluginId={pluginId} visual={presentation} />;
          const plugin = plugins.find((candidate) => candidate.id === pluginId);
          if (!plugin) return undefined;
          return (
            <>
              {toggleError && (
                <p role="alert" className="text-sm text-conn-red-text">
                  {toggleError}
                </p>
              )}
              <RepositoryPluginCard
                plugin={plugin}
                expanded
                busy={togglingId === pluginId}
                onExpandedChange={() => {}}
                onToggle={handleToggle}
                onUpdated={fetchPlugins}
              />
            </>
          );
        }}
      />
    </div>
  );
}
