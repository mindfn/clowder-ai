'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { ProfileItem, ProviderProfilesResponse } from '../hub-provider-profiles.types';
import { builtinAccountIdForClient, filterAccounts, type ClientValue } from '../hub-cat-editor.model';

interface ConfigStepProps {
  client: string;
  defaultModel?: string;
  onComplete: (config: { accountRef: string; model: string }) => void;
}

export function ConfigStep({ client, defaultModel, onComplete }: ConfigStepProps) {
  const [profiles, setProfiles] = useState<ProfileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [model, setModel] = useState(defaultModel ?? '');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/provider-profiles')
      .then(async (res) => (await res.json()) as ProviderProfilesResponse)
      .then((body) => {
        if (!cancelled) setProfiles(body.providers);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const available = useMemo(
    () => filterAccounts(client as ClientValue, profiles),
    [client, profiles],
  );

  useEffect(() => {
    if (!selectedProfileId && available.length > 0) {
      setSelectedProfileId(builtinAccountIdForClient(client as ClientValue) ?? available[0]?.id ?? '');
    }
  }, [available, client, selectedProfileId]);

  const selectedProfile = available.find((p) => p.id === selectedProfileId);

  const selectableModels = useMemo(() => {
    const fromProfile = selectedProfile?.models?.map((m) => m.trim()).filter(Boolean) ?? [];
    const current = model.trim();
    if (current && !fromProfile.includes(current)) return [current, ...fromProfile];
    return fromProfile;
  }, [model, selectedProfile]);

  useEffect(() => {
    if (!model.trim() && selectableModels.length > 0) {
      setModel(selectableModels[0] ?? '');
    }
  }, [model, selectableModels]);

  const handleTest = async () => {
    if (!selectedProfileId) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiFetch(`/api/provider-profiles/${encodeURIComponent(selectedProfileId)}/test`, {
        method: 'POST',
      });
      const body = (await res.json()) as { ok: boolean; message?: string; error?: string };
      setTestResult({ ok: body.ok, message: body.ok ? '连接成功！' : (body.error ?? body.message ?? '连接失败') });
    } catch {
      setTestResult({ ok: false, message: '网络错误' });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return <p className="py-8 text-center text-sm text-gray-400">加载认证配置...</p>;
  }

  const canProceed = selectedProfileId && model.trim() && testResult?.ok;

  return (
    <div>
      <h4 className="mb-1 text-sm font-semibold text-gray-700">认证和模型配置</h4>
      <p className="mb-4 text-xs text-gray-500">选择账号并验证连通性</p>

      {available.length === 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
          未找到可用的认证配置。请在 Console 的 Provider Profiles 中添加。
        </div>
      ) : (
        <>
          <div className="mb-3 space-y-2">
            {available.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setSelectedProfileId(p.id);
                  setTestResult(null);
                }}
                className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition ${
                  selectedProfileId === p.id
                    ? 'border-amber-400 bg-amber-50'
                    : 'border-gray-200 hover:border-amber-200'
                }`}
              >
                <span className="font-medium">{p.displayName ?? p.name ?? p.id}</span>
                <span className="text-xs text-gray-400">{p.builtin ? '内置' : 'API Key'}</span>
              </button>
            ))}
          </div>

          <div className="mb-3">
            <label htmlFor="quest-model" className="mb-1 block text-xs font-medium text-gray-600">模型</label>
            {selectableModels.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {selectableModels.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setModel(m)}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                      model === m
                        ? 'border-purple-400 bg-purple-50 text-purple-700'
                        : 'border-gray-200 text-gray-500 hover:border-purple-200'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            ) : (
              <input
                id="quest-model"
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="输入模型名称..."
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
              />
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || !selectedProfileId}
              className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-700 transition hover:bg-amber-100 disabled:opacity-50"
            >
              {testing ? '测试中...' : '测试连接'}
            </button>
            {testResult && (
              <span className={`text-sm ${testResult.ok ? 'text-green-600' : 'text-red-500'}`}>
                {testResult.message}
              </span>
            )}
          </div>

          {canProceed && (
            <button
              type="button"
              onClick={() => onComplete({ accountRef: selectedProfileId, model: model.trim() })}
              className="mt-4 w-full rounded-lg bg-amber-500 py-2.5 text-sm font-semibold text-white transition hover:bg-amber-600"
            >
              创建猫猫
            </button>
          )}
        </>
      )}
    </div>
  );
}
