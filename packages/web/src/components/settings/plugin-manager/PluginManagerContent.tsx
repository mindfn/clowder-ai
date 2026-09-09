'use client';

import { pluginDescriptionVariants, resolvePluginDescription } from '@cat-cafe/shared';
import { useMemo, useState } from 'react';
import { ConnectorPluginInstallButton } from '../../ConnectorPluginInstallButton';
import { HubIcon } from '../../hub-icons';
import {
  SettingsResourceToggleSwitch,
  settingsResourceActionGroupClass,
  settingsResourceCardClass,
  settingsResourceRowClass,
} from '../../SettingsResourceCard';
import { SettingsDeleteButton } from '../primitives/SettingsDeleteButton';
import { SettingsPrimaryButton } from '../primitives/SettingsPrimaryButton';
import { SettingsText } from '../primitives/SettingsText';
import { PluginManagerDetailCard } from './PluginManagerDetailCard';
import { PluginVisual } from './PluginVisual';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

function matchesSearch(plugin: PluginManagerDesignFixture, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return true;
  return `${plugin.displayName} ${pluginDescriptionVariants(plugin.description).join(' ')} ${plugin.packageName} ${plugin.capabilities
    .map((capability) => `${capability.name} ${capability.description}`)
    .join(' ')}`
    .toLocaleLowerCase()
    .includes(normalized);
}

function PluginListActions({
  plugin,
  installed,
  canInstall,
  canSetEnabled,
  canUninstall,
  busy,
  onInstall,
  onSetEnabled,
  onUninstall,
}: {
  plugin: PluginManagerDesignFixture;
  installed: boolean;
  canInstall: boolean;
  canSetEnabled: boolean;
  canUninstall: boolean;
  busy: boolean;
  onInstall: (() => void) | undefined;
  onSetEnabled: ((enabled: boolean) => void) | undefined;
  onUninstall: (() => void) | undefined;
}) {
  if (canInstall) {
    return (
      <SettingsPrimaryButton onClick={() => onInstall?.()} disabled={busy}>
        安装
      </SettingsPrimaryButton>
    );
  }
  if (!installed && !canUninstall) return null;
  return (
    <>
      {canUninstall && (
        <SettingsDeleteButton
          onClick={() => onUninstall?.()}
          disabled={busy}
          aria-label={`${plugin.artifact === 'quarantined' ? '移除' : '卸载'}${plugin.displayName}`}
        />
      )}
      {installed && canSetEnabled && (
        <SettingsResourceToggleSwitch
          enabled={plugin.intent === 'enabled'}
          busy={busy}
          disabled={!canSetEnabled}
          onClick={(event) => {
            event.stopPropagation();
            onSetEnabled?.(plugin.intent !== 'enabled');
          }}
          ariaLabel={`${plugin.intent === 'enabled' ? '禁用' : '启用'}${plugin.displayName}`}
          ariaPressed={plugin.intent === 'enabled'}
        />
      )}
    </>
  );
}

function PluginListRow({
  plugin,
  selected,
  onSelect,
  onInstall,
  onSetEnabled,
  onUninstall,
  busy,
  locale,
}: {
  plugin: PluginManagerDesignFixture;
  selected: boolean;
  onSelect: () => void;
  onInstall?: () => void;
  onSetEnabled?: (enabled: boolean) => void;
  onUninstall?: () => void;
  busy: boolean;
  locale: string;
}) {
  const installed = plugin.artifact === 'installed';
  const canInstall = plugin.actions?.install ?? !installed;
  const canSetEnabled = plugin.actions?.setEnabled ?? installed;
  const canUninstall = plugin.actions?.uninstall ?? installed;
  const description = resolvePluginDescription(plugin.description, locale);
  return (
    <article
      data-plugin-id={plugin.id}
      data-plugin-list-row="true"
      role="listitem"
      aria-current={selected ? 'true' : undefined}
      className={`${settingsResourceCardClass} h-[88px] overflow-hidden transition-colors ${
        selected ? '' : 'hover:bg-[var(--console-hover-bg)]'
      }`}
      style={selected ? { backgroundColor: 'var(--console-active-bg)' } : undefined}
    >
      <div className={`${settingsResourceRowClass} h-full w-full`}>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={onSelect}>
          <PluginVisual icon={plugin.icon} iconBg={plugin.iconBg} name={plugin.displayName} />
          <span className="min-w-0 flex-1">
            <SettingsText as="span" variant="sm" tone="default" className="block truncate font-semibold">
              {plugin.displayName}
            </SettingsText>
            <span data-plugin-description="true" className="mt-0.5 line-clamp-2 block overflow-hidden">
              <SettingsText as="span" variant="xs" tone="secondary">
                {description}
              </SettingsText>
            </span>
          </span>
        </button>
        <div className={settingsResourceActionGroupClass}>
          <PluginListActions
            plugin={plugin}
            installed={installed}
            canInstall={canInstall}
            canSetEnabled={canSetEnabled}
            canUninstall={canUninstall}
            busy={busy}
            onInstall={onInstall}
            onSetEnabled={onSetEnabled}
            onUninstall={onUninstall}
          />
        </div>
      </div>
    </article>
  );
}

export function PluginManagerContent({
  fixtures,
  catalogStatus = 'fresh',
  catalogMessage,
  loading = false,
  error,
  busyPluginId = null,
  onPluginSelect,
  onSearchChange,
  onInstall,
  onSetEnabled,
  onUninstall,
  onConfigure,
  locale = 'zh-CN',
}: {
  fixtures: readonly PluginManagerDesignFixture[];
  catalogStatus?: 'fresh' | 'stale' | 'degraded' | 'unavailable';
  catalogMessage?: string;
  loading?: boolean;
  error?: string | null;
  busyPluginId?: string | null;
  onPluginSelect?: (pluginId: string) => void;
  onSearchChange?: (query: string) => void;
  onInstall?: (pluginId: string) => void;
  onSetEnabled?: (pluginId: string, enabled: boolean) => void;
  onUninstall?: (pluginId: string) => void;
  onConfigure?: (pluginId: string, updates: readonly { key: string; value: string | null }[]) => void;
  locale?: string;
}) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(fixtures[0]?.id ?? '');
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const visible = useMemo(() => fixtures.filter((plugin) => matchesSearch(plugin, query)), [fixtures, query]);
  const selected = visible.find((plugin) => plugin.id === selectedId) ?? visible[0] ?? null;

  return (
    <section data-testid="plugin-manager" className="flex h-full min-h-0 flex-1 flex-col gap-3.5 overflow-hidden">
      <div data-plugin-manager-toolbar className="flex justify-end">
        <ConnectorPluginInstallButton
          endpoint="/api/plugin-manager/plugins/install/upload"
          label="离线安装"
          docsHref={false}
        />
      </div>

      {catalogStatus !== 'fresh' && (
        <div className="flex items-start gap-2 rounded-xl bg-conn-amber-bg px-3 py-2.5">
          <HubIcon name="alert-triangle" className="mt-0.5 h-4 w-4 shrink-0 text-conn-amber-text" />
          <SettingsText as="p" variant="sm" tone="amber">
            {catalogMessage ?? '目录暂时不可用；已安装插件仍可管理，未安装列表会在连接恢复后刷新。'}
          </SettingsText>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-xl bg-conn-red-bg px-3 py-2.5 text-sm text-conn-red-text">
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 gap-3.5 overflow-hidden lg:grid-cols-[minmax(17rem,0.82fr)_minmax(0,1.5fr)]">
        <div
          data-mobile-panel="list"
          className={`${mobileDetailOpen ? 'hidden' : 'flex'} min-h-0 min-w-0 flex-col gap-2 lg:flex`}
        >
          <div>
            <label className={`${settingsResourceCardClass} flex min-w-0 items-center gap-2 px-3 py-2.5`}>
              <HubIcon name="search" className="h-4 w-4 shrink-0 text-cafe-muted" />
              <input
                aria-label="搜索插件"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  onSearchChange?.(event.target.value);
                }}
                placeholder="搜索插件"
                className="min-w-0 flex-1 bg-transparent text-sm text-cafe outline-none placeholder:text-cafe-muted"
              />
            </label>
          </div>
          <SettingsText as="p" variant="sm" tone="default" className="px-1 font-semibold">
            插件列表
          </SettingsText>
          <div
            data-plugin-scroll-region="list"
            role="list"
            aria-label="插件列表"
            className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1"
          >
            {loading && (
              <div data-testid="plugin-manager-loading" className="space-y-2">
                {[0, 1, 2].map((item) => (
                  <div key={item} className={`${settingsResourceCardClass} h-[88px] animate-pulse`} />
                ))}
              </div>
            )}
            {!loading && visible.length === 0 && (
              <div className={`${settingsResourceCardClass} px-4 py-10 text-center`}>
                <SettingsText as="p" variant="sm" tone="muted">
                  没有符合条件的插件
                </SettingsText>
              </div>
            )}
            {visible.map((plugin) => (
              <PluginListRow
                key={plugin.id}
                plugin={plugin}
                selected={plugin.id === selected?.id}
                locale={locale}
                onSelect={() => {
                  setSelectedId(plugin.id);
                  setMobileDetailOpen(true);
                  onPluginSelect?.(plugin.id);
                }}
                onInstall={() => onInstall?.(plugin.id)}
                onSetEnabled={(enabled) => onSetEnabled?.(plugin.id, enabled)}
                onUninstall={() => onUninstall?.(plugin.id)}
                busy={busyPluginId === plugin.id}
              />
            ))}
          </div>
        </div>

        <div
          data-mobile-panel="detail"
          className={`${mobileDetailOpen ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-col gap-2 lg:flex`}
        >
          <button
            type="button"
            onClick={() => setMobileDetailOpen(false)}
            className="flex items-center gap-2 px-1 text-xs font-semibold text-cafe-secondary transition hover:text-cafe lg:hidden"
          >
            <HubIcon name="arrow-left" className="h-4 w-4" />
            返回插件列表
          </button>
          <div data-plugin-scroll-region="detail" className="min-h-0 flex-1 overflow-y-auto pr-1">
            {selected ? (
              <PluginManagerDetailCard
                key={selected.id}
                plugin={selected}
                locale={locale}
                busy={busyPluginId === selected.id}
                onSaveConfig={
                  selected.configFields?.length ? (updates) => onConfigure?.(selected.id, updates) : undefined
                }
              />
            ) : loading ? (
              <div className={`${settingsResourceCardClass} min-h-48 animate-pulse`} />
            ) : (
              <div className={`${settingsResourceCardClass} flex min-h-48 items-center justify-center p-6`}>
                <SettingsText as="p" variant="sm" tone="muted">
                  选择一个插件查看详情
                </SettingsText>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
