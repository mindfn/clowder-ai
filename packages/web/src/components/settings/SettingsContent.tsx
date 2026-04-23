'use client';

import { useCallback, useEffect, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { CatOverviewTab, type ConfigData, SystemTab } from '../config-viewer-tabs';
import { HubAccountsTab } from '../HubAccountsTab';
import { HubCapabilityTab } from '../HubCapabilityTab';
import { HubCatEditor } from '../HubCatEditor';
import { HubCoCreatorEditor } from '../HubCoCreatorEditor';
import { HubConnectorConfigTab } from '../HubConnectorConfigTab';
import { MarketplacePanel } from '../marketplace/marketplace-panel';
import { PushSettingsPanel } from '../PushSettingsPanel';
import { VoiceSettingsPanel } from '../VoiceSettingsPanel';
import { OpsContent } from './OpsContent';
import { SettingsPlaceholder } from './SettingsPlaceholder';

interface SettingsContentProps {
  section: string;
}

export function SettingsContent({ section }: SettingsContentProps) {
  const { cats, refresh } = useCatData();
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [coCreatorEditorOpen, setCoCreatorEditorOpen] = useState(false);
  const [editingCat, setEditingCat] = useState<(typeof cats)[number] | null>(null);
  const [createDraft, setCreateDraft] = useState<Parameters<typeof HubCatEditor>[0]['draft']>(null);
  const [togglingCatId, setTogglingCatId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setFetchError(null);
    try {
      const res = await apiFetch('/api/config');
      if (res.ok) {
        const d = (await res.json()) as { config: ConfigData };
        setConfig(d.config);
      } else {
        setFetchError('配置加载失败');
      }
    } catch {
      setFetchError('网络错误');
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleEditorSaved = useCallback(async () => {
    await Promise.all([fetchData(), refresh()]);
  }, [fetchData, refresh]);

  const handleToggleAvailability = useCallback(
    async (cat: (typeof cats)[number]) => {
      setTogglingCatId(cat.id);
      setFetchError(null);
      try {
        const res = await apiFetch(`/api/cats/${cat.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ available: cat.roster?.available === false }),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          setFetchError((payload.error as string) ?? `成员状态切换失败 (${res.status})`);
          return;
        }
        await Promise.all([fetchData(), refresh()]);
      } catch {
        setFetchError('成员状态切换失败');
      } finally {
        setTogglingCatId(null);
      }
    },
    [fetchData, refresh],
  );

  const configError = fetchError ? (
    <p className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{fetchError}</p>
  ) : null;

  switch (section) {
    case 'members':
      if (configError) return configError;
      return (
        <>
          {config ? (
            <CatOverviewTab
              config={config}
              cats={cats}
              onAddMember={() => {
                setEditingCat(null);
                setCreateDraft(null);
                setEditorOpen(true);
              }}
              onEditCoCreator={() => setCoCreatorEditorOpen(true)}
              onEditMember={(cat) => {
                setCreateDraft(null);
                setEditingCat(cat);
                setEditorOpen(true);
              }}
              onToggleAvailability={handleToggleAvailability}
              togglingCatId={togglingCatId}
            />
          ) : (
            <p className="text-sm text-cafe-muted">加载中...</p>
          )}
          <HubCatEditor
            open={editorOpen}
            cat={editingCat}
            draft={createDraft}
            onClose={() => {
              setEditorOpen(false);
              setEditingCat(null);
              setCreateDraft(null);
            }}
            onSaved={handleEditorSaved}
          />
          <HubCoCreatorEditor
            open={coCreatorEditorOpen}
            coCreator={config?.coCreator}
            onClose={() => setCoCreatorEditorOpen(false)}
            onSaved={handleEditorSaved}
          />
        </>
      );
    case 'accounts':
      return <HubAccountsTab />;
    case 'im':
      return <HubConnectorConfigTab />;
    case 'skills':
      return (
        <>
          <HubCapabilityTab section="skills" />
          <div className="mt-4">
            <MarketplacePanel />
          </div>
        </>
      );
    case 'mcp':
      return <HubCapabilityTab section="mcp" />;
    case 'plugins':
      return (
        <SettingsPlaceholder
          section="插件/集成"
          description="GitHub PR Tracking、Email Watcher、Calendar 同步等第三方集成的启用/禁用、配置和连接状态管理"
        />
      );
    case 'voice':
      return <VoiceSettingsPanel />;
    case 'system':
      if (configError) return configError;
      return config ? (
        <SystemTab config={config} onConfigChange={fetchData} />
      ) : (
        <p className="text-sm text-cafe-muted">加载中...</p>
      );
    case 'notify':
      return <PushSettingsPanel />;
    case 'ops':
      return <OpsContent />;
    default:
      return <SettingsPlaceholder section={section} description="此分区即将上线" />;
  }
}
