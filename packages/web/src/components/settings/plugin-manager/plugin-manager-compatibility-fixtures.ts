import type { PluginInfo } from '@cat-cafe/shared';
import { officialPluginPresentation } from '../official-plugin-presentation';
import type { OfficialPluginInfo } from '../official-plugin-types';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

/** Navigation projections only. Existing compatibility owners still admit every operation. */
function compatibilityEntry(id: string, name: string, description: string): PluginManagerDesignFixture {
  return {
    id,
    displayName: name,
    description,
    icon: 'blocks',
    publisher: 'Clowder AI',
    packageName: id,
    source: 'local',
    trust: 'local-trusted',
    sourceAdapter: 'repository-local',
    availableVersion: '',
    installedVersion: null,
    artifact: 'absent',
    config: 'incomplete',
    auth: 'not-required',
    intent: 'disabled',
    live: 'stopped',
    capabilities: [],
    readme: { state: 'absent' },
    actions: { install: false, setEnabled: false, uninstall: false, blockingReasons: ['compatibility-detail'] },
  };
}

export const PERSONAL_PRO_COMPATIBILITY_ENTRY = compatibilityEntry(
  'personal-chrome-host',
  'ChatGPT 浏览器辅助',
  'Chrome 扩展与 Pro 对话绑定。猫咖 MCP 在 ChatGPT 中连接；dot 订阅在「ChatGPT 云端」中准备。',
);

export function repositoryCompatibilityEntry(plugin: PluginInfo): PluginManagerDesignFixture {
  return {
    ...compatibilityEntry(plugin.id, plugin.name, ''),
    description: plugin.description ?? '',
    icon: plugin.icon ?? 'blocks',
    ...(plugin.iconBg === undefined ? {} : { iconBg: plugin.iconBg }),
    installedVersion: plugin.version,
    availableVersion: plugin.version,
    artifact: 'installed',
    config: plugin.configured ? 'ready' : 'incomplete',
    intent: plugin.status === 'enabled' || plugin.status === 'partial' ? 'enabled' : 'disabled',
  };
}

export function officialCompatibilityEntry(plugin: OfficialPluginInfo): PluginManagerDesignFixture {
  return {
    ...compatibilityEntry(
      plugin.pluginId,
      officialPluginPresentation(plugin).name,
      officialPluginPresentation(plugin).description,
    ),
    availableVersion: plugin.availableVersion,
    installedVersion: plugin.instance?.installedVersion ?? null,
    artifact: plugin.instance ? 'installed' : 'absent',
  };
}
