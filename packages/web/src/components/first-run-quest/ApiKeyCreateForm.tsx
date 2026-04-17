'use client';

import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface EditProfileData {
  id: string;
  displayName?: string;
  baseUrl?: string;
}

interface ApiKeyCreateFormProps {
  onCreated: (profileId: string) => void;
  editProfile?: EditProfileData;
  /** Target client identity (anthropic/openai/google/…) — persisted as account metadata. */
  clientId?: string;
}

export function ApiKeyCreateForm({ onCreated, editProfile, clientId }: ApiKeyCreateFormProps) {
  const isEdit = Boolean(editProfile);
  const [displayName, setDisplayName] = useState(editProfile?.displayName ?? '');
  const [baseUrl, setBaseUrl] = useState(editProfile?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!baseUrl.trim()) {
      setError('请输入 API 服务地址');
      return;
    }
    if (!isEdit && !apiKey.trim()) {
      setError('请输入 API Key');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (isEdit) {
        const patch: Record<string, string> = {};
        if (displayName.trim()) patch.displayName = displayName.trim();
        if (baseUrl.trim()) patch.baseUrl = baseUrl.trim();
        if (apiKey.trim()) patch.apiKey = apiKey.trim();
        const res = await apiFetch(`/api/accounts/${encodeURIComponent(editProfile!.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `更新失败 (${res.status})`);
        }
        onCreated(editProfile!.id);
      } else {
        const name = displayName.trim() || 'API Key';
        const res = await apiFetch('/api/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            displayName: name,
            authType: 'api_key',
            ...(clientId ? { clientId } : {}),
            baseUrl: baseUrl.trim(),
            apiKey: apiKey.trim(),
          }),
        });
        const body = (await res.json()) as { profile?: { id?: string }; error?: string };
        if (!res.ok) throw new Error(body.error ?? `创建失败 (${res.status})`);
        const newId = body.profile?.id;
        if (newId) onCreated(newId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2.5">
      <div>
        <label className="mb-0.5 block text-[11px] text-gray-500">名称（可选）</label>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="My API Key"
          className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
        />
      </div>
      <div>
        <label className="mb-0.5 block text-[11px] text-gray-500">API 服务地址</label>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.anthropic.com"
          className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
        />
      </div>
      <div>
        <label className="mb-0.5 block text-[11px] text-gray-500">API Key{isEdit && '（留空保持不变）'}</label>
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            setError(null);
          }}
          placeholder={isEdit ? '••••••••••••' : 'sk-...'}
          className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
        />
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={saving || (!isEdit && !apiKey.trim())}
        className="w-full rounded-lg bg-amber-500 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-600 disabled:opacity-50"
      >
        {saving ? (isEdit ? '保存中...' : '创建中...') : isEdit ? '保存' : '创建'}
      </button>
    </div>
  );
}
