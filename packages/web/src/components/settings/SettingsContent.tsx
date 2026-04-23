'use client';

import { useCallback, useEffect, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { BrakeSettingsPanel } from '../BrakeSettingsPanel';
import { CatOverviewTab, type ConfigData, SystemTab } from '../config-viewer-tabs';
import { HubAccountsTab } from '../HubAccountsTab';
import { HubCapabilityTab } from '../HubCapabilityTab';
import { HubCatEditor } from '../HubCatEditor';
import { HubClaudeRescueSection } from '../HubClaudeRescueSection';
import { HubCoCreatorEditor } from '../HubCoCreatorEditor';
import { HubCommandsTab } from '../HubCommandsTab';
import { HubEnvFilesTab } from '../HubEnvFilesTab';
import { HubGovernanceTab } from '../HubGovernanceTab';
import { HubLeaderboardTab } from '../HubLeaderboardTab';
import { HubMemoryTab } from '../HubMemoryTab';
import { HubRoutingPolicyTab } from '../HubRoutingPolicyTab';
import { HubToolUsageTab } from '../HubToolUsageTab';
import { MarketplacePanel } from '../marketplace/marketplace-panel';
import { PushSettingsPanel } from '../PushSettingsPanel';
import { VoiceSettingsPanel } from '../VoiceSettingsPanel';
import { SettingsPlaceholder } from './SettingsPlaceholder';

interface SettingsContentProps {
  section: string;
}

export function SettingsContent({ section }: SettingsContentProps) {
  const { cats, getCatById, refresh } = useCatData();
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

  if (fetchError) {
    return <p className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{fetchError}</p>;
  }

  switch (section) {
    case 'members':
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
      return <HubEnvFilesTab />;
    case 'skills':
      return (
        <>
          <HubCapabilityTab />
          <div className="mt-4">
            <MarketplacePanel />
          </div>
        </>
      );
    case 'mcp':
      return <SettingsPlaceholder section="MCP 管理" description="MCP 连接配置（STDIO/HTTP 模式）、市场、健康监控" />;
    case 'plugins':
      return <SettingsPlaceholder section="插件/集成" description="GitHub PR Tracking、Email、Calendar 等第三方集成" />;
    case 'voice':
      return <VoiceSettingsPanel />;
    case 'system':
      return config ? (
        <SystemTab config={config} onConfigChange={fetchData} />
      ) : (
        <p className="text-sm text-cafe-muted">加载中...</p>
      );
    case 'notify':
      return <PushSettingsPanel />;
    case 'ops':
      return (
        <div className="space-y-6">
          <HubRoutingPolicyTab />
          <HubLeaderboardTab />
          <HubMemoryTab />
          <HubGovernanceTab />
          <BrakeSettingsPanel />
          <HubClaudeRescueSection />
          <HubCommandsTab />
          <HubToolUsageTab />
        </div>
      );
    default:
      return <SettingsPlaceholder section={section} description="此分区即将上线" />;
  }
}
