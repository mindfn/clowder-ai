'use client';

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

interface Props {
  docsUrl?: string;
  setupSteps?: string[];
}

export function GithubConfigPanel({ docsUrl, setupSteps }: Props) {
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

  const hasGuide = docsUrl || (setupSteps && setupSteps.length > 0);

  const configFields = (
    <>
      {fields.length === 0 ? (
        <p className="text-[12px] text-cafe-muted">加载配置项...</p>
      ) : (
        <div className="space-y-2.5">
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
                className="console-form-input py-2.5 text-[13px]"
                data-testid={`field-${field.envName}`}
              />
            </div>
          ))}
        </div>
      )}
    </>
  );

  return (
    <div className="px-4 py-4 space-y-4">
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
          <p className="mb-2 text-[12px] font-bold text-cafe-secondary">配置项</p>
          {configFields}
        </>
      )}

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
  );
}
