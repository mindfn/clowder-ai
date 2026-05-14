'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { ExternalLinkIcon, StepBadge } from '../HubConfigIcons';
import { SettingsPrimaryButton, SettingsStatusStrip, SettingsText } from './primitives';

const REDACTED_PLACEHOLDER = '••••••';

interface GitHubField {
  envName: string;
  label: string;
  sensitive: boolean;
  restartRequired?: boolean;
  currentValue: string | null;
}

interface GitHubPlatformStatus {
  id: string;
  fields: GitHubField[];
}

interface ConnectorStatusResponse {
  platforms?: GitHubPlatformStatus[];
}

function friendlyError(message: string, fallback: string): string {
  if (message.includes('DEFAULT_OWNER_USER_ID')) {
    return 'DEFAULT_OWNER_USER_ID 未配置，后端拒绝写入 GitHub token。请先配置 owner 后再保存。';
  }
  if (message.includes('configured owner')) {
    return '当前登录用户不是配置 owner，不能修改 GitHub token。';
  }
  return message.trim() || fallback;
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: unknown };
    if (typeof payload.error === 'string') return friendlyError(payload.error, fallback);
  } catch {
    // ignore non-json body
  }
  return fallback;
}

interface Props {
  docsUrl?: string;
  setupSteps?: string[];
}

export function GithubConfigPanel({ docsUrl, setupSteps }: Props) {
  const [fields, setFields] = useState<GitHubField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'info'; text: string } | null>(null);

  const fetchFields = useCallback(async () => {
    try {
      const res = await apiFetch('/api/connector/status');
      if (!res.ok) return;
      const data = (await res.json()) as ConnectorStatusResponse | GitHubPlatformStatus[];
      const platforms = Array.isArray(data) ? data : (data.platforms ?? []);
      const github = platforms.find((platform) => platform.id === 'github');
      setFields(github?.fields ?? []);
    } catch {
      // Config panel is additive; plugins page service cards remain usable if status fetch fails.
    }
  }, []);

  useEffect(() => {
    void fetchFields();
  }, [fetchFields]);

  const updateField = (envName: string, value: string) => {
    setValues((current) => ({ ...current, [envName]: value }));
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const updates = fields
        .map((field) => ({ name: field.envName, value: values[field.envName]?.trim() ?? '' }))
        .filter((update) => update.value.length > 0);
      if (updates.length === 0) {
        setMessage({ tone: 'info', text: '没有需要保存的 GitHub 配置。' });
        return;
      }
      if (updates.some((update) => update.value.includes(REDACTED_PLACEHOLDER))) {
        setMessage({ tone: 'error', text: '不能保存已脱敏占位符，请留空保持原值或输入新值。' });
        return;
      }
      const res = await apiFetch('/api/config/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      if (!res.ok) {
        setMessage({ tone: 'error', text: await readError(res, `保存失败（HTTP ${res.status}）`) });
        return;
      }
      setValues({});
      setMessage({ tone: 'success', text: 'GitHub 配置已保存，secret 字段已清空。' });
      await fetchFields();
    } catch {
      setMessage({ tone: 'error', text: '保存失败，请检查 API 连接后重试。' });
    } finally {
      setSaving(false);
    }
  };

  const messageTone = message?.tone === 'success' ? 'success' : message?.tone === 'error' ? 'error' : 'info';
  const hasGuide = docsUrl || (setupSteps && setupSteps.length > 0);

  const configFields = (
    <>
      {fields.length === 0 ? (
        <SettingsText as="p" tone="muted">
          加载配置项...
        </SettingsText>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {fields.map((field) => (
            <label
              key={field.envName}
              className="space-y-1 font-medium"
              style={{ fontSize: '0.75rem', color: 'var(--cafe-text-secondary)' }}
            >
              {field.label}
              <input
                name={field.envName}
                type={field.sensitive ? 'password' : 'text'}
                value={values[field.envName] ?? ''}
                onChange={(event) => updateField(field.envName, event.target.value)}
                placeholder={
                  field.sensitive
                    ? field.currentValue
                      ? '已配置，留空保持不变'
                      : '未配置'
                    : (field.currentValue ?? '未配置')
                }
                className="w-full"
                style={{
                  borderRadius: '0.5rem',
                  border: '1px solid var(--console-border-soft)',
                  backgroundColor: 'var(--cafe-surface-elevated)',
                  paddingInline: '0.75rem',
                  paddingBlock: '0.5rem',
                  fontSize: '0.875rem',
                  color: 'var(--cafe-text)',
                }}
                data-testid={`field-${field.envName}`}
              />
              {field.restartRequired && (
                <SettingsText as="span" tone="muted" className="block">
                  重启 API 后生效
                </SettingsText>
              )}
            </label>
          ))}
        </div>
      )}
    </>
  );

  return (
    <div
      className="space-y-3"
      style={{ borderTop: '1px solid var(--cafe-border)', paddingInline: '1rem', paddingBlock: '0.75rem' }}
    >
      {hasGuide ? (
        <div className="console-list-card overflow-hidden rounded-2xl shadow-[0_12px_30px_rgba(43,33,26,0.08)]">
          <div className="flex items-center gap-3 bg-conn-sky-bg px-4 py-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-conn-sky-ring text-conn-sky-text">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z"
                />
              </svg>
            </div>
            <div>
              <div className="text-sm font-semibold">基础配置</div>
              <div className="text-xs text-cafe-secondary">应用凭证与连接设置</div>
            </div>
          </div>
          <div className="space-y-3.5 p-4">
            {setupSteps?.map((step, idx) => (
              <div key={idx} className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <StepBadge num={idx + 1} />
                  <span className="text-[13px] font-medium text-cafe">{step}</span>
                </div>
                {idx === 0 && docsUrl && (
                  <div className="ml-[26px]">
                    <a href={docsUrl} target="_blank" rel="noopener noreferrer" className="console-inline-link">
                      <ExternalLinkIcon />
                      <span>{new URL(docsUrl).hostname} → 查看官方文档</span>
                    </a>
                  </div>
                )}
              </div>
            ))}

            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <StepBadge num={(setupSteps?.length ?? 0) + 1} />
                <span className="text-[13px] font-medium text-cafe">填写应用凭证</span>
              </div>
              <div className="ml-[26px]">{configFields}</div>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="space-y-1">
            <SettingsText as="p" variant="sm" tone="default" className="font-medium">
              GitHub Token
            </SettingsText>
            <SettingsText as="p" tone="secondary">
              保存后写入运行时 .env；secret 字段留空会保留现有值。标记为重启的字段需重启 API 后生效。
            </SettingsText>
          </div>
          {configFields}
        </>
      )}

      {message && (
        <SettingsStatusStrip tone={messageTone} size="xs" bordered>
          {message.text}
        </SettingsStatusStrip>
      )}

      <div className="flex justify-end">
        <SettingsPrimaryButton
          onClick={() => {
            void handleSave();
          }}
          disabled={saving || fields.length === 0}
        >
          {saving ? '保存中...' : '保存 GitHub 配置'}
        </SettingsPrimaryButton>
      </div>
    </div>
  );
}
