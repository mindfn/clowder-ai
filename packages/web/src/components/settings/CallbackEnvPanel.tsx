'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface EnvVar {
  name: string;
  defaultValue: string;
  description: string;
  category: string;
  sensitive: boolean;
  currentValue: string | null;
}

interface EnvSummaryResponse {
  variables: EnvVar[];
}

export function CallbackEnvPanel() {
  const [vars, setVars] = useState<EnvVar[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/config/env-summary');
        if (cancelled) return;
        if (!res.ok) {
          setError('加载失败');
          return;
        }
        const data = (await res.json()) as EnvSummaryResponse;
        setVars(data.variables.filter((v) => v.name.startsWith('CAT_CAFE_CALLBACK_')));
      } catch {
        if (!cancelled) setError('网络错误');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="text-xs text-red-500">{error}</p>;
  if (vars.length === 0) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-cafe-black mb-1">Callback 环境变量</h3>
      <p className="text-xs text-cafe-muted mb-3">
        回调鉴权和 outbox 投递相关配置（其中 TOKEN 注入 MCP 子进程，OUTBOX_* 为宿主进程参数）
      </p>
      <div className="rounded-lg border border-cafe-border overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-cafe-surface-elevated text-left">
              <th className="px-3 py-2 font-medium text-cafe-secondary">变量名</th>
              <th className="px-3 py-2 font-medium text-cafe-secondary">当前值</th>
              <th className="px-3 py-2 font-medium text-cafe-secondary">说明</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cafe-border">
            {vars.map((v) => (
              <tr key={v.name} className="hover:bg-cafe-surface-elevated/50 transition-colors">
                <td className="px-3 py-2 font-mono text-cafe-black whitespace-nowrap">{v.name}</td>
                <td className="px-3 py-2 font-mono text-cafe-secondary">
                  {v.sensitive ? (
                    <span className="text-cafe-muted">***</span>
                  ) : (
                    <span>{v.currentValue ?? v.defaultValue}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-cafe-muted">{v.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
