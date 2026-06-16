'use client';

import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useGuideStore } from '@/stores/guideStore';
import { apiFetch } from '@/utils/api-client';
import {
  connStatePill,
  DEFAULT_VISUAL,
  ExternalLinkIcon,
  formatHeartbeat,
  PLATFORM_VISUALS,
  type PlatformStatus,
  StepBadge,
  WifiIcon,
} from './HubConfigIcons';
import { HubConnectorPluginsSection } from './HubConnectorPluginsSection';
import { settingsResourceCardClass } from './SettingsResourceCard';
import { ActionRenderer } from './settings/primitives/ActionRenderer';
import { ConfigFieldRenderer } from './settings/primitives/ConfigFieldRenderer';
import { WeComBotSetupPanel } from './WeComBotSetupPanel';

const HubPermissionsTab = lazy(() => import('./HubPermissionsTab'));

const REDACTED_PLACEHOLDER = '••••••';

function ConnectorActionBar({
  platformId,
  saveResult,
  saving,
  onSave,
  testing,
  onTest,
}: {
  platformId: string;
  saveResult: { type: 'success' | 'error'; message: string } | null;
  saving: boolean;
  onSave: () => void;
  testing: boolean;
  onTest: () => void;
}) {
  return (
    <>
      {saveResult && (
        <div
          className={`rounded-2xl px-3 py-2 text-xs ${
            saveResult.type === 'success'
              ? 'bg-conn-emerald-bg text-conn-emerald-text border border-conn-emerald-ring'
              : 'bg-conn-red-bg text-conn-red-text border border-conn-red-ring'
          }`}
          data-testid="save-result"
        >
          {saveResult.message}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          className="console-button-secondary text-sm disabled:opacity-50"
          onClick={onTest}
          disabled={testing}
        >
          <WifiIcon />
          {testing ? '测试中...' : '测试连接'}
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="console-button-primary text-sm disabled:opacity-50"
          data-testid={`save-${platformId}`}
        >
          {saving ? '保存中...' : '保存配置'}
        </button>
      </div>
    </>
  );
}

export function HubConnectorConfigTab() {
  const activeGuideStep = useGuideStore((s) => {
    const session = s.session;
    if (!session || session.currentStepIndex >= session.flow.steps.length) return null;
    return session.flow.steps[session.currentStepIndex];
  });
  const [platforms, setPlatforms] = useState<PlatformStatus[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saveResult, setSaveResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const fetchStatus = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/connector/status');
      if (!res.ok) return;
      const data = await res.json();
      const all: PlatformStatus[] = data.platforms ?? [];
      setPlatforms(all.filter((p) => p.category !== 'plugin'));
    } catch {
      // fall through
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleExpand = (platformId: string) => {
    const guideToggleTarget = `connector.${platformId}`;
    if (expandedId === platformId) {
      if (activeGuideStep?.advance === 'click' && activeGuideStep.target === guideToggleTarget) {
        return;
      }
      setExpandedId(null);
      setFieldValues({});
      setSaveResult(null);
      return;
    }
    setExpandedId(platformId);
    setFieldValues({});
    setSaveResult(null);
  };

  const handleSave = async (platform: PlatformStatus) => {
    // F231: save to .cat-cafe config store via PUT /api/connectors/:id/config (not legacy /api/config/secrets)
    const fields = platform.fields
      .filter((f) => fieldValues[f.envName] !== undefined)
      .map((f) => ({ name: f.envName, value: fieldValues[f.envName] || null }));

    if (fields.length === 0) {
      setSaveResult({ type: 'error', message: '请填写至少一个配置项' });
      return;
    }

    if (fields.some((f) => f.value?.includes(REDACTED_PLACEHOLDER))) {
      setSaveResult({ type: 'error', message: '不能保存脱敏占位符，请输入新的完整凭据' });
      return;
    }

    setSaving(true);
    setSaveResult(null);
    try {
      const res = await apiFetch(`/api/connectors/${encodeURIComponent(platform.id)}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSaveResult({ type: 'error', message: data.error ?? '保存失败' });
        return;
      }
      setSaveResult({ type: 'success', message: '配置已保存，连接器正在自动重连...' });
      setFieldValues({});
      await fetchStatus();
    } catch {
      setSaveResult({ type: 'error', message: '网络错误' });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (platform: PlatformStatus) => {
    setTesting(true);
    setSaveResult(null);
    try {
      const res = await apiFetch(`/api/connector/${encodeURIComponent(platform.id)}/test`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => ({}))) as { valid?: boolean; error?: string };
      if (data.valid) {
        setSaveResult({ type: 'success', message: '连接正常' });
      } else {
        setSaveResult({ type: 'error', message: data.error || '连接失败' });
      }
    } catch {
      setSaveResult({ type: 'error', message: '网络错误' });
    } finally {
      setTesting(false);
    }
  };

  if (isLoading) {
    return <p className="text-center text-cafe-muted py-8 text-sm">加载中...</p>;
  }

  if (platforms.length === 0) {
    return <p className="text-center text-cafe-muted py-8 text-sm">无法加载平台配置信息</p>;
  }

  return (
    <div className="space-y-3">
      {platforms.map((platform) => {
        const isExpanded = expandedId === platform.id;
        const v = PLATFORM_VISUALS[platform.id] ?? DEFAULT_VISUAL;
        // Resolve current connection mode for mode-filtered steps
        const modeField = platform.fields.find((f) => f.envName === 'FEISHU_CONNECTION_MODE');
        const selectedMode = modeField
          ? (fieldValues['FEISHU_CONNECTION_MODE'] ?? modeField.currentValue ?? 'webhook')
          : undefined;
        const filteredSteps = platform.steps.filter((s) => !s.mode || s.mode === selectedMode);
        const guideSteps = filteredSteps.slice(0, -1);

        return (
          <div
            key={platform.id}
            className="console-list-card rounded-xl overflow-hidden shadow-[0_8px_22px_rgba(43,33,26,0.04)] hover:shadow-md"
            data-testid={`platform-card-${platform.id}`}
            data-guide-id={`connector.${platform.id}`}
            data-active={isExpanded ? 'true' : 'false'}
          >
            <button
              type="button"
              onClick={() => handleExpand(platform.id)}
              className="flex w-full items-center gap-3 px-4 py-3 transition-colors"
            >
              <span
                className="flex h-9 w-9 items-center justify-center rounded-xl shrink-0"
                style={{ backgroundColor: v.iconBg, color: v.iconColor }}
              >
                {v.icon}
              </span>
              <span className="flex-1 text-left min-w-0 space-y-1">
                <span className="block text-sm font-semibold text-cafe">
                  {platform.name}
                  {platform.nameEn !== platform.name ? ` ${platform.nameEn}` : ''}
                </span>
                {platform.lastHeartbeat && (
                  <span className="block text-xs text-cafe-muted">{formatHeartbeat(platform.lastHeartbeat)}</span>
                )}
              </span>
              <span
                className={`shrink-0 rounded-xl px-2.5 py-1 text-xs font-semibold ${connStatePill(platform).className}`}
              >
                {connStatePill(platform).label}
              </span>
            </button>

            {/* Unified expanded content — manifest-driven (AC-A22 + AC-A23) */}
            {isExpanded && (
              <div className="px-4 py-4 space-y-4">
                <div className={`${settingsResourceCardClass} overflow-hidden`}>
                  {/* Section header — themed from manifest */}
                  <div className="px-4 py-3 flex items-center gap-3" style={{ backgroundColor: v.iconBg }}>
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ color: v.iconColor }}>
                      {v.icon}
                    </div>
                    <div>
                      <div className="font-semibold text-sm">基础配置</div>
                      <div className="text-xs text-cafe-secondary">应用凭证与连接设置</div>
                    </div>
                  </div>

                  <div className="p-4 space-y-3.5">
                    {/* Guide steps from manifest */}
                    {guideSteps.map((step, idx) => (
                      <div key={step.text} className="space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <StepBadge num={idx + 1} />
                          <span className="text-sm font-medium text-cafe">{step.text}</span>
                        </div>
                        {idx === 0 && (
                          <div className="ml-[26px] space-y-2.5">
                            <a
                              href={platform.docsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="console-inline-link"
                            >
                              <ExternalLinkIcon />
                              <span>{new URL(platform.docsUrl).hostname} → 查看官方文档</span>
                            </a>
                            {/* Operations (ActionRenderer) — from YAML manifest */}
                            {platform.operations?.map((op) => (
                              <ActionRenderer
                                key={op.name}
                                connectorId={platform.id}
                                operation={op}
                                onStatusChange={() => void fetchStatus()}
                                themeColor={platform.themeColor}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    ))}

                    {/* Config fields (ConfigFieldRenderer) — from YAML manifest */}
                    {platform.fields.length > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5">
                          <StepBadge num={guideSteps.length + 1} />
                          <span className="text-sm font-medium text-cafe">填写应用凭证</span>
                        </div>
                        <div className="ml-[26px] space-y-2.5">
                          {platform.fields.map((field) => (
                            <ConfigFieldRenderer
                              key={field.envName}
                              field={field}
                              value={fieldValues[field.envName] ?? ''}
                              onChange={(envName, val) => setFieldValues((prev) => ({ ...prev, [envName]: val }))}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    {/* WeComBot legacy setup panel — retained until YAML operations added */}
                    {platform.id === 'wecom-bot' && (
                      <div className="ml-[26px]">
                        <WeComBotSetupPanel
                          configured={platform.configured}
                          onConnected={() => void fetchStatus()}
                          onDisconnected={() => void fetchStatus()}
                        />
                      </div>
                    )}
                  </div>
                </div>

                {platform.permissionLabel && (
                  <Suspense fallback={<p className="text-xs text-cafe-muted">加载中...</p>}>
                    <HubPermissionsTab connectorId={platform.id} connectorLabel={platform.permissionLabel} />
                  </Suspense>
                )}

                <ConnectorActionBar
                  platformId={platform.id}
                  saveResult={saveResult}
                  saving={saving}
                  onSave={() => handleSave(platform)}
                  testing={testing}
                  onTest={() => handleTest(platform)}
                />
              </div>
            )}
          </div>
        );
      })}

      <HubConnectorPluginsSection onPluginChange={fetchStatus} />

      <p className="mt-4 text-xs text-cafe-muted">配置保存后自动生效，无需重启</p>
    </div>
  );
}
