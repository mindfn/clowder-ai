'use client';

import { useCallback, useEffect, useState } from 'react';
import { useGuideStore } from '@/stores/guideStore';
import { apiFetch } from '@/utils/api-client';
import { FeishuQrPanel } from './FeishuQrPanel';
import {
  ChevronDown,
  ChevronRight,
  DEFAULT_VISUAL,
  ExternalLinkIcon,
  LockIcon,
  PLATFORM_VISUALS,
  StatusDotConnected,
  StatusDotIdle,
  StepBadge,
  WifiIcon,
} from './HubConfigIcons';
import { WeComBotSetupPanel } from './WeComBotSetupPanel';
import { WeixinQrPanel } from './WeixinQrPanel';

interface PlatformFieldStatus {
  envName: string;
  label: string;
  sensitive: boolean;
  currentValue: string | null;
}

interface PlatformStepStatus {
  text: string;
  mode?: string;
}

interface PlatformStatus {
  id: string;
  name: string;
  nameEn: string;
  configured: boolean;
  fields: PlatformFieldStatus[];
  docsUrl: string;
  steps: PlatformStepStatus[];
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
  const [saveResult, setSaveResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const fetchStatus = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/connector/status');
      if (!res.ok) return;
      const data = await res.json();
      setPlatforms(data.platforms ?? []);
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
    // F136 Phase 2: all connector fields go through /api/config/secrets (hot-reload enabled)
    const updates = platform.fields
      .filter((f) => fieldValues[f.envName] !== undefined)
      .map((f) => ({ name: f.envName, value: fieldValues[f.envName] || null }));

    if (updates.length === 0) {
      setSaveResult({ type: 'error', message: '请填写至少一个配置项' });
      return;
    }

    setSaving(true);
    setSaveResult(null);
    try {
      const res = await apiFetch('/api/config/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
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
            className="console-list-card rounded-[24px] overflow-hidden"
            data-testid={`platform-card-${platform.id}`}
            data-guide-id={`connector.${platform.id}`}
            data-active={isExpanded ? 'true' : 'false'}
          >
            <button
              type="button"
              onClick={() => handleExpand(platform.id)}
              className="flex w-full items-center gap-3 px-4 py-4 transition-colors"
            >
              <span
                className="console-pill flex h-10 w-10 items-center justify-center rounded-[14px] shrink-0"
                style={{ backgroundColor: v.iconBg, color: v.iconColor }}
              >
                {v.icon}
              </span>
              <span className="flex-1 text-left min-w-0">
                <span className="block text-[15px] font-semibold text-cafe">
                  {platform.name} {platform.nameEn !== platform.name ? platform.nameEn : ''}
                </span>
                <span
                  className={`flex items-center gap-1 text-xs ${platform.configured ? 'text-conn-emerald-text' : 'text-cafe-muted'}`}
                >
                  {platform.configured ? <StatusDotConnected /> : <StatusDotIdle />}
                  {platform.configured ? '已配置' : '未配置'}
                </span>
              </span>
              <span className="console-pill flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-cafe-muted">
                {isExpanded ? <ChevronDown /> : <ChevronRight />}
              </span>
            </button>

            {/* F132 Phase E: WeCom Bot guided setup — dedicated panel with validate+connect */}
            {isExpanded && platform.id === 'wecom-bot' && (
              <div className="console-code-pane space-y-3.5 px-4 py-4">
                {guideSteps.map((step, idx) => (
                  <div key={idx} className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <StepBadge num={idx + 1} />
                      <span className="text-[13px] font-medium text-cafe">{step.text}</span>
                    </div>
                    {idx === 0 && (
                      <div className="ml-[26px]">
                        <a
                          href={platform.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="console-inline-link"
                        >
                          <ExternalLinkIcon />
                          <span>developer.work.weixin.qq.com → WeCom AI Bot docs</span>
                        </a>
                      </div>
                    )}
                    {idx === guideSteps.length - 1 && (
                      <div className="ml-[26px]">
                        <WeComBotSetupPanel
                          configured={platform.configured}
                          onConnected={() => void fetchStatus()}
                          onDisconnected={() => void fetchStatus()}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {isExpanded && platform.id === 'weixin' && (
              <div className="console-code-pane space-y-3.5 px-4 py-4">
                {filteredSteps.map((step, idx) => (
                  <div key={idx} className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <StepBadge num={idx + 1} />
                      <span className="text-[13px] font-medium text-cafe">{step.text}</span>
                    </div>
                    {idx === 0 && (
                      <div className="ml-[26px]">
                        <div data-guide-id="connector.weixin.qr-panel">
                          <WeixinQrPanel configured={platform.configured} />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {isExpanded && platform.id !== 'weixin' && platform.id !== 'wecom-bot' && (
              <div className="console-code-pane space-y-3.5 px-4 py-4">
                {guideSteps.map((step, idx) => (
                  <div key={idx} className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <StepBadge num={idx + 1} />
                      <span className="text-[13px] font-medium text-cafe">{step.text}</span>
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
                        {platform.id === 'feishu' && (
                          <FeishuQrPanel
                            configured={platform.configured}
                            onConfirmed={() => void fetchStatus()}
                            onDisconnected={() => void fetchStatus()}
                          />
                        )}
                      </div>
                    )}
                  </div>
                ))}

                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <StepBadge num={guideSteps.length + 1} />
                    <span className="text-[13px] font-medium text-cafe">填写应用凭证</span>
                  </div>
                  <div className="ml-[26px] space-y-2.5">
                    {platform.fields.map((field) => (
                      <div key={field.envName}>
                        <label
                          htmlFor={`config-${field.envName}`}
                          className="block text-xs font-medium text-cafe-secondary mb-1"
                        >
                          {field.label}
                          {field.sensitive && (
                            <span className="text-conn-amber-text ml-1 inline-flex align-middle">
                              <LockIcon />
                            </span>
                          )}
                        </label>
                        {field.envName === 'FEISHU_CONNECTION_MODE' ? (
                          <select
                            id={`config-${field.envName}`}
                            value={fieldValues[field.envName] ?? field.currentValue ?? 'webhook'}
                            onChange={(e) => setFieldValues((prev) => ({ ...prev, [field.envName]: e.target.value }))}
                            className="console-form-input py-2.5 text-[13px]"
                            data-testid={`field-${field.envName}`}
                          >
                            <option value="webhook">Webhook（需公网 URL）</option>
                            <option value="websocket">WebSocket 长连接（无需公网）</option>
                          </select>
                        ) : (
                          <input
                            id={`config-${field.envName}`}
                            type={field.sensitive ? 'password' : 'text'}
                            placeholder={
                              field.sensitive
                                ? field.currentValue
                                  ? '已设置（输入新值覆盖）'
                                  : '未设置'
                                : (field.currentValue ?? '未设置')
                            }
                            value={fieldValues[field.envName] ?? ''}
                            onChange={(e) => setFieldValues((prev) => ({ ...prev, [field.envName]: e.target.value }))}
                            className="console-form-input py-2.5 text-[13px]"
                            data-testid={`field-${field.envName}`}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <StepBadge num={filteredSteps.length} />
                    <span className="text-[13px] font-medium text-cafe">测试连接并保存</span>
                  </div>
                  {saveResult && (
                    <div
                      className={`ml-[26px] rounded-[16px] px-3 py-2 text-xs ${
                        saveResult.type === 'success'
                          ? 'bg-conn-emerald-bg text-conn-emerald-text border border-conn-emerald-ring'
                          : 'bg-conn-red-bg text-conn-red-text border border-conn-red-ring'
                      }`}
                      data-testid="save-result"
                    >
                      {saveResult.message}
                    </div>
                  )}
                  <div className="flex items-center gap-2 ml-[26px]">
                    <button
                      type="button"
                      className="console-button-secondary text-[13px]"
                      onClick={() => setSaveResult({ type: 'success', message: '连接测试功能即将上线' })}
                    >
                      <WifiIcon />
                      测试连接
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSave(platform)}
                      disabled={saving}
                      className="console-button-primary text-[13px] disabled:opacity-50"
                      data-testid={`save-${platform.id}`}
                    >
                      {saving ? '保存中...' : '保存配置'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div className="console-card-soft flex items-center gap-2 rounded-[18px] px-3.5 py-3">
        <StatusDotConnected />
        <span className="text-xs font-medium text-conn-emerald-text">配置保存后自动生效，无需重启</span>
      </div>
    </div>
  );
}
