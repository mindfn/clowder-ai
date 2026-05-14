'use client';

import type { PluginInfo } from '@cat-cafe/shared';
import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { ExternalLinkIcon, StepBadge } from '../HubConfigIcons';

interface Props {
  plugin: PluginInfo;
  onUpdated: () => void;
}

export function PluginConfigPanel({ plugin, onUpdated }: Props) {
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [result, setResult] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  const handleSave = async () => {
    const updates = plugin.config
      .filter((f) => fieldValues[f.envName] !== undefined)
      .map((f) => ({
        name: f.envName,
        value: fieldValues[f.envName] === '' ? null : fieldValues[f.envName]!,
      }));
    if (updates.length === 0) {
      setResult({ type: 'error', msg: '请填写至少一个配置项' });
      return;
    }
    setSaving(true);
    setResult(null);
    try {
      const res = await apiFetch(`/api/plugins/${plugin.id}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setResult({ type: 'error', msg: d.error ?? '保存失败' });
        return;
      }
      setResult({ type: 'success', msg: '配置已保存' });
      setFieldValues({});
      onUpdated();
    } catch {
      setResult({ type: 'error', msg: '网络错误' });
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async () => {
    const action = plugin.status === 'enabled' || plugin.status === 'partial' ? 'disable' : 'enable';
    setEnabling(true);
    setResult(null);
    try {
      const res = await apiFetch(`/api/plugins/${plugin.id}/${action}`, { method: 'POST' });
      const data = (await res.json()) as {
        status: string;
        resources?: { type: string; ok: boolean; error?: string }[];
      };
      if (data.status === 'success') {
        setResult({ type: 'success', msg: action === 'enable' ? '插件已启用' : '插件已禁用' });
      } else if (data.status === 'partial') {
        const failed = data.resources?.filter((r) => !r.ok).map((r) => `${r.type}: ${r.error}`);
        setResult({ type: 'error', msg: `部分资源失败: ${failed?.join(', ')}` });
      } else {
        setResult({ type: 'error', msg: '操作失败' });
      }
      onUpdated();
    } catch {
      setResult({ type: 'error', msg: '网络错误' });
    } finally {
      setEnabling(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await apiFetch(`/api/plugins/${plugin.id}/test`, { method: 'POST' });
      const data = (await res.json()) as { ok: boolean; status?: string; error?: string };
      if (data.ok) {
        setResult({ type: 'success', msg: `连接成功 · 状态: ${data.status}` });
      } else {
        setResult({ type: 'error', msg: data.error ?? `连接失败 · 状态: ${data.status ?? 'unknown'}` });
      }
    } catch {
      setResult({ type: 'error', msg: '网络错误' });
    } finally {
      setTesting(false);
    }
  };

  const isEnabled = plugin.status === 'enabled' || plugin.status === 'partial';
  const hasGuide = plugin.docsUrl || (plugin.setupSteps && plugin.setupSteps.length > 0);

  return (
    <div className="px-4 py-4 space-y-4">
      {hasGuide && (
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
            {plugin.setupSteps?.map((step, idx) => (
              <div key={idx} className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <StepBadge num={idx + 1} />
                  <span className="text-[13px] font-medium text-cafe">{step}</span>
                </div>
                {idx === 0 && plugin.docsUrl && (
                  <div className="ml-[26px]">
                    <a href={plugin.docsUrl} target="_blank" rel="noopener noreferrer" className="console-inline-link">
                      <ExternalLinkIcon />
                      <span>{new URL(plugin.docsUrl).hostname} → 查看官方文档</span>
                    </a>
                  </div>
                )}
              </div>
            ))}

            {plugin.config.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <StepBadge num={(plugin.setupSteps?.length ?? 0) + 1} />
                  <span className="text-[13px] font-medium text-cafe">填写应用凭证</span>
                </div>
                <div className="ml-[26px] space-y-2.5">
                  {plugin.config.map((f) => (
                    <div key={f.envName}>
                      <label
                        htmlFor={`plugin-${f.envName}`}
                        className="mb-1 block text-xs font-medium text-cafe-secondary"
                      >
                        {f.label}
                      </label>
                      <input
                        id={`plugin-${f.envName}`}
                        type={f.sensitive ? 'password' : 'text'}
                        placeholder={
                          f.sensitive
                            ? f.currentValue
                              ? '已设置（输入新值覆盖）'
                              : '未设置'
                            : (f.currentValue ?? '未设置')
                        }
                        value={fieldValues[f.envName] ?? ''}
                        onChange={(e) => setFieldValues((prev) => ({ ...prev, [f.envName]: e.target.value }))}
                        className="console-form-input py-2.5 text-[13px]"
                        data-testid={`field-${f.envName}`}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {!hasGuide && plugin.config.length > 0 && (
        <>
          <p className="mb-2 text-[12px] font-bold text-cafe-secondary">配置项</p>
          <div className="space-y-2">
            {plugin.config.map((f) => (
              <div key={f.envName}>
                <label htmlFor={`plugin-${f.envName}`} className="mb-1 block text-xs font-medium text-cafe-secondary">
                  {f.label}
                </label>
                <input
                  id={`plugin-${f.envName}`}
                  type={f.sensitive ? 'password' : 'text'}
                  placeholder={
                    f.sensitive ? (f.currentValue ? '已设置（输入新值覆盖）' : '未设置') : (f.currentValue ?? '未设置')
                  }
                  value={fieldValues[f.envName] ?? ''}
                  onChange={(e) => setFieldValues((prev) => ({ ...prev, [f.envName]: e.target.value }))}
                  className="console-form-input py-2.5 text-compact"
                  data-testid={`field-${f.envName}`}
                />
              </div>
            ))}
          </div>
        </>
      )}

      {plugin.resources.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {plugin.resources.map((r, i) => (
            <span
              key={i}
              className={`rounded-[13px] px-2.5 py-0.5 text-label font-medium ${
                r.enabled ? 'bg-conn-emerald-bg text-conn-emerald-text' : 'bg-cafe-surface-sunken text-cafe-muted'
              }`}
            >
              {r.type}
              {r.error ? ` (${r.error})` : ''}
            </span>
          ))}
        </div>
      )}

      {result && (
        <div
          className={`rounded-[16px] px-3 py-2 text-xs ${
            result.type === 'success'
              ? 'border border-conn-emerald-ring bg-conn-emerald-bg text-conn-emerald-text'
              : 'border border-conn-red-ring bg-conn-red-bg text-conn-red-text'
          }`}
        >
          {result.msg}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {plugin.hasHealthCheck && (
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={testing}
            className="console-button-secondary text-compact disabled:opacity-50"
          >
            {testing ? '测试中...' : '测试连接'}
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleToggle()}
          disabled={enabling || !plugin.configured}
          className="console-button-secondary text-compact disabled:opacity-50"
        >
          {enabling ? '处理中...' : isEnabled ? '禁用' : '启用'}
        </button>
        {plugin.config.length > 0 && (
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="console-button-primary text-compact disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存配置'}
          </button>
        )}
      </div>
    </div>
  );
}
