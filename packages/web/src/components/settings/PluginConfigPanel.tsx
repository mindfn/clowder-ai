'use client';

import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { PluginInfo } from '@cat-cafe/shared';

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
      .filter((f) => fieldValues[f.envName] !== undefined && fieldValues[f.envName] !== '')
      .map((f) => ({ name: f.envName, value: fieldValues[f.envName] ?? null }));
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
      const data = (await res.json()) as { status: string; resources?: { type: string; ok: boolean; error?: string }[] };
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

  return (
    <div className="space-y-3 border-t border-cafe px-4 pb-4 pt-3">
      {plugin.config.length > 0 && (
        <div className="space-y-2.5 rounded-lg bg-cafe-surface-elevated p-3">
          {plugin.config.map((f) => (
            <div key={f.envName}>
              <label htmlFor={`plugin-${f.envName}`} className="mb-1 block text-[11px] font-semibold text-cafe-muted">
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
                className="h-[34px] w-full rounded-lg border border-cafe bg-white px-3 text-[13px] text-cafe focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              />
            </div>
          ))}
        </div>
      )}

      {plugin.resources.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {plugin.resources.map((r, i) => (
            <span
              key={i}
              className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${
                r.enabled
                  ? 'bg-conn-emerald-bg text-conn-emerald-text'
                  : 'bg-cafe-surface-sunken text-cafe-muted'
              }`}
            >
              {r.type}{r.error ? ` (${r.error})` : ''}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        {plugin.hasHealthCheck && (
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="rounded-lg border border-cafe bg-cafe-surface px-3 py-1.5 text-xs font-semibold text-cafe-secondary transition-colors hover:bg-cafe-surface-elevated disabled:opacity-50"
          >
            {testing ? '测试中...' : '测试连接'}
          </button>
        )}
        {plugin.config.length > 0 && (
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg border border-cafe bg-cafe-surface px-3 py-1.5 text-xs font-semibold text-cafe-secondary transition-colors hover:bg-cafe-surface-elevated disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存配置'}
          </button>
        )}
        <button
          type="button"
          onClick={handleToggle}
          disabled={enabling || !plugin.configured}
          className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-colors disabled:opacity-50"
          style={{ backgroundColor: isEnabled ? '#94a3b8' : '#E29578' }}
        >
          {enabling ? '处理中...' : isEnabled ? '禁用' : '启用'}
        </button>
      </div>

      {result && (
        <div
          className={`rounded-lg px-3 py-2 text-xs ${
            result.type === 'success'
              ? 'border border-green-200 bg-green-50 text-green-700'
              : 'border border-red-200 bg-red-50 text-red-700'
          }`}
        >
          {result.msg}
        </div>
      )}
    </div>
  );
}
