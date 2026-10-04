import { createRoot } from 'react-dom/client';
import { PluginManagerContent } from '@/components/settings/plugin-manager/PluginManagerContent';
import { PLUGIN_MANAGER_DESIGN_FIXTURES } from '@/components/settings/plugin-manager/plugin-manager-fixtures';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/console-controls.css';
import '@/app/connector-tokens.css';
import '@/app/globals.css';

const ready = PLUGIN_MANAGER_DESIGN_FIXTURES[0];
const fixtures = [
  ready,
  {
    ...ready,
    id: 'failed',
    displayName: '连接失败的插件',
    intent: 'disabled' as const,
    live: 'stopped' as const,
    activationFailed: true,
    diagnostic: '连接被拒绝，请检查插件连接配置。',
  },
  { ...PLUGIN_MANAGER_DESIGN_FIXTURES[2], icon: 'blocks' as const },
];

const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <main className="h-screen p-4">
    <PluginManagerContent
      presentation="v2"
      fixtures={fixtures}
      onUninstall={(id) => document.documentElement.setAttribute('data-uninstalled', id)}
    />
  </main>,
);
