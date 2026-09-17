import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SettingsPrimaryButton, SettingsStatusStrip } from '../primitives';
import { DecisionRow } from './DecisionRow';

function isAbsolutePath(value: string): boolean {
  return /^(\/|[A-Za-z]:[\\/])/.test(value);
}

export function DeniedRootsDecision() {
  const [deniedRoots, setDeniedRoots] = useState<string[] | null>(null);
  const [deniedInput, setDeniedInput] = useState('');
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const loadDeniedRoots = useCallback(() => {
    apiFetch('/api/config/denied-roots')
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { deniedRoots: string[] };
        setDeniedRoots(body.deniedRoots);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadDeniedRoots();
  }, [loadDeniedRoots]);

  const putDeniedRoots = async (roots: string[]) => {
    setMessage(null);
    try {
      const res = await apiFetch('/api/config/denied-roots', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deniedRoots: roots }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; deniedRoots?: string[] };
      if (!res.ok) {
        setMessage({ tone: 'error', text: body.error ?? '保存失败' });
        return false;
      }
      setDeniedRoots(body.deniedRoots ?? roots);
      return true;
    } catch {
      setMessage({ tone: 'error', text: '保存失败' });
      return false;
    }
  };

  const addDeniedRoot = async () => {
    const trimmed = deniedInput.trim();
    if (!trimmed) return;
    if (!isAbsolutePath(trimmed)) {
      setMessage({ tone: 'error', text: '需要绝对路径（以 / 开头）' });
      return;
    }
    if ((deniedRoots ?? []).includes(trimmed)) {
      setDeniedInput('');
      return;
    }
    if (await putDeniedRoots([...(deniedRoots ?? []), trimmed])) setDeniedInput('');
  };

  const removeDeniedRoot = async (root: string) => {
    await putDeniedRoots((deniedRoots ?? []).filter((entry) => entry !== root));
  };

  return (
    <DecisionRow label="禁止访问目录" smallPrint="平台默认的系统目录始终会被拦截">
      <div className="space-y-2">
        {(deniedRoots ?? []).map((root) => (
          <div key={root} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-cafe" title={root}>
              {root}
            </span>
            <button
              type="button"
              aria-label={`移除 ${root}`}
              onClick={() => void removeDeniedRoot(root)}
              className="shrink-0 rounded px-1.5 text-xs text-cafe-muted hover:text-cafe"
            >
              ✕
            </button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <input
            type="text"
            aria-label="添加禁止访问目录"
            value={deniedInput}
            placeholder="绝对路径，如 /private/tmp"
            onChange={(event) => setDeniedInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void addDeniedRoot();
            }}
            className="h-8 w-full min-w-0 rounded-lg border border-transparent bg-[var(--console-field-bg)] px-2 font-mono text-xs text-cafe"
          />
          <SettingsPrimaryButton onClick={() => void addDeniedRoot()} disabled={!deniedInput.trim()}>
            添加
          </SettingsPrimaryButton>
        </div>
        {message && <SettingsStatusStrip tone={message.tone}>{message.text}</SettingsStatusStrip>}
      </div>
    </DecisionRow>
  );
}
