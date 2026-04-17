'use client';

import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { BuiltinAccountClient } from './hub-accounts.types';
import { builtinClientLabel } from './hub-accounts.view';
import { TagEditor } from './hub-tag-editor';

const CLIENT_OPTIONS: BuiltinAccountClient[] = ['anthropic', 'openai', 'google', 'kimi', 'dare', 'opencode'];

interface UnifiedAuthModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (profileId: string) => void;
}

export function UnifiedAuthModal({ open, onClose, onCreated }: UnifiedAuthModalProps) {
  const [clientId, setClientId] = useState<BuiltinAccountClient>('anthropic');
  const [displayName, setDisplayName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const resetForm = () => {
    setClientId('anthropic');
    setDisplayName('');
    setBaseUrl('');
    setApiKey('');
    setModels([]);
    setError(null);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const canSubmit = displayName.trim() && baseUrl.trim() && apiKey.trim() && models.length > 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: displayName.trim(),
          authType: 'api_key',
          clientId,
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim(),
          models,
        }),
      });
      const body = (await res.json()) as { profile?: { id?: string }; error?: string };
      if (!res.ok) throw new Error(body.error ?? `创建失败 (${res.status})`);
      if (body.profile?.id) {
        resetForm();
        onCreated(body.profile.id);
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 px-4" onClick={handleClose}>
      <div
        className="w-full max-w-md rounded-[20px] border border-[#F1E7DF] bg-[#FFFDFC] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-[#8A776B]">新增 API Key 认证</h4>
          <button
            type="button"
            onClick={handleClose}
            className="text-lg leading-none text-[#C4B5A8] hover:text-[#8A776B]"
          >
            &times;
          </button>
        </div>

        <p className="mb-3 text-[11px] leading-5 text-[#B59A88]">
          内建 OAuth 账号已自动配置，此处仅添加 API Key 账号。
        </p>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-[#8A776B]">目标客户端</label>
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value as BuiltinAccountClient)}
              className="w-full rounded-lg border border-[#E8DCCF] bg-white px-3 py-2 text-sm text-[#5C4D42]"
            >
              {CLIENT_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {builtinClientLabel(c)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-[#8A776B]">名称</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="如 my-glm"
              className="w-full rounded-lg border border-[#E8DCCF] bg-white px-3 py-2 text-sm placeholder:text-[#C4B5A8]"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-[#8A776B]">API 服务地址</label>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              className="w-full rounded-lg border border-[#E8DCCF] bg-white px-3 py-2 text-sm placeholder:text-[#C4B5A8]"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-[#8A776B]">API Key</label>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setError(null);
              }}
              placeholder="sk-..."
              className="w-full rounded-lg border border-[#E8DCCF] bg-white px-3 py-2 text-sm placeholder:text-[#C4B5A8]"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-[#8A776B]">可用模型 *</label>
            <TagEditor
              tags={models}
              tone="purple"
              addLabel="+ 添加模型"
              placeholder="输入模型名"
              emptyLabel="(至少添加 1 个模型)"
              onChange={setModels}
              minCount={0}
            />
          </div>
        </div>

        {error && <p className="mt-3 text-xs text-red-500">{error}</p>}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={saving || !canSubmit}
          className="mt-4 w-full rounded-lg bg-[#D49266] py-2 text-sm font-semibold text-white transition hover:bg-[#c47f52] disabled:opacity-50"
        >
          {saving ? '创建中...' : '创建'}
        </button>
      </div>
    </div>
  );
}
