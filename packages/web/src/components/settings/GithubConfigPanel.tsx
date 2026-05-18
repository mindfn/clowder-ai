'use client';

import type { PluginInfo } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { ExternalLinkIcon, StepBadge } from '../HubConfigIcons';

interface GitHubField {
  envName: string;
  label: string;
  sensitive: boolean;
  currentValue: string | null;
}

interface GitHubPlatformStatus {
  id: string;
  fields: GitHubField[];
}

interface ConnectorStatusResponse {
  platforms?: GitHubPlatformStatus[];
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function GithubConfigPanel({ plugin }: { plugin: PluginInfo }) {
  const [fields, setFields] = useState<GitHubField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const fetchFields = useCallback(async () => {
    try {
      const res = await apiFetch('/api/connector/status');
      if (!res.ok) return;
      const data = (await res.json()) as ConnectorStatusResponse | GitHubPlatformStatus[];
      const platforms = Array.isArray(data) ? data : (data.platforms ?? []);
      const gh = platforms.find((p) => p.id === 'github');
      setFields(gh?.fields ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void fetchFields();
  }, [fetchFields]);

  const handleSave = useCallback(async () => {
    const updates = fields
      .filter((f) => values[f.envName] !== undefined)
      .map((f) => ({ name: f.envName, value: values[f.envName] || null }));
    if (updates.length === 0) {
      setResult({ type: 'error', message: '请填写至少一个配置项' });
      return;
    }

    setSaving(true);
    setResult(null);
    try {
      const res = await apiFetch('/api/config/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as Record<string, string>;
        setResult({ type: 'error', message: data.error ?? '保存失败' });
        return;
      }
      setValues({});
      setResult({ type: 'success', message: 'GitHub 配置已保存' });
      await fetchFields();
    } catch {
      setResult({ type: 'error', message: '网络错误' });
    } finally {
      setSaving(false);
    }
  }, [fields, values, fetchFields]);

  const hasSteps = plugin.setupSteps && plugin.setupSteps.length > 0;

  return (
    <div className="space-y-3.5 px-4 pb-4 pt-3">
      {hasSteps &&
        plugin.setupSteps?.map((step, idx) => (
          <div key={step} className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <StepBadge num={idx + 1} />
              <span className="text-[13px] font-medium text-cafe">{step}</span>
            </div>
            {idx === 0 && plugin.docsUrl && isSafeUrl(plugin.docsUrl) && (
              <div className="ml-[26px]">
                <a href={plugin.docsUrl} target="_blank" rel="noopener noreferrer" className="console-inline-link">
                  <ExternalLinkIcon />
                  <span>{safeHostname(plugin.docsUrl)} → 查看官方文档</span>
                </a>
              </div>
            )}
          </div>
        ))}

      {!hasSteps && plugin.docsUrl && isSafeUrl(plugin.docsUrl) && (
        <a href={plugin.docsUrl} target="_blank" rel="noopener noreferrer" className="console-inline-link">
          <ExternalLinkIcon />
          <span>{safeHostname(plugin.docsUrl)} → 查看官方文档</span>
        </a>
      )}

      <div>
        {hasSteps && (
          <div className="mb-2 flex items-center gap-1.5">
            <StepBadge num={(plugin.setupSteps?.length ?? 0) + 1} />
            <span className="text-[13px] font-medium text-cafe">填写应用凭证</span>
          </div>
        )}
        {!hasSteps && <p className="mb-2 text-[12px] font-bold text-cafe-secondary">配置项</p>}
        {fields.length === 0 ? (
          <p className="text-[12px] text-cafe-muted">加载配置项...</p>
        ) : (
          <div className={`${hasSteps ? 'ml-[26px]' : ''} space-y-2`}>
            {fields.map((field) => (
              <div key={field.envName}>
                <label
                  htmlFor={`plugin-config-${field.envName}`}
                  className="mb-1 block text-xs font-medium text-cafe-secondary"
                >
                  {field.label}
                </label>
                <input
                  id={`plugin-config-${field.envName}`}
                  type={field.sensitive ? 'password' : 'text'}
                  placeholder={
                    field.sensitive
                      ? field.currentValue
                        ? '已设置（输入新值覆盖）'
                        : '未配置'
                      : (field.currentValue ?? '未配置')
                  }
                  value={values[field.envName] ?? ''}
                  onChange={(e) => setValues((prev) => ({ ...prev, [field.envName]: e.target.value }))}
                  className="console-form-input py-2.5 text-compact"
                  data-testid={`field-${field.envName}`}
                />
              </div>
            ))}
            {result && (
              <div
                className={`rounded-[16px] px-3 py-2 text-xs ${
                  result.type === 'success'
                    ? 'border border-conn-emerald-ring bg-conn-emerald-bg text-conn-emerald-text'
                    : 'border border-conn-red-ring bg-conn-red-bg text-conn-red-text'
                }`}
              >
                {result.message}
              </div>
            )}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
                className="console-button-primary text-compact disabled:opacity-50"
              >
                {saving ? '保存中...' : '保存 GitHub 配置'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
