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

  if (error) {
    return (
      <p
        className="console-card rounded-[22px] px-4 py-3 text-xs"
        style={{ borderColor: 'var(--notice-error-border)', color: 'var(--notice-error-label)' }}
      >
        {error}
      </p>
    );
  }
  if (vars.length === 0) return null;

  return (
    <section className="console-section-shell rounded-[28px] p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cafe-muted">MCP Callback</p>
          <h3 className="text-lg font-semibold tracking-[-0.03em] text-cafe">Callback 环境变量</h3>
          <p className="max-w-3xl text-sm leading-6 text-cafe-secondary">
            回调鉴权和 outbox 投递相关配置（其中 TOKEN 注入 MCP 子进程，OUTBOX_* 为宿主进程参数）
          </p>
        </div>
        <span className="console-pill inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold text-cafe-secondary">
          {vars.length} vars
        </span>
      </div>
      <div className="mt-4 grid gap-3">
        {vars.map((v) => {
          const displayValue = v.sensitive ? '***' : (v.currentValue ?? v.defaultValue) || '未设置';
          const scopeLabel = v.name === 'CAT_CAFE_CALLBACK_TOKEN' ? '子进程 + 宿主' : '宿主进程';
          return (
            <article key={v.name} className="console-list-card rounded-[22px] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-mono text-[13px] font-semibold text-cafe">{v.name}</p>
                    <span className="console-status-chip" data-status={v.sensitive ? 'warning' : 'info'}>
                      {v.sensitive ? '敏感' : '可见'}
                    </span>
                    <span className="console-pill inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold text-cafe-secondary">
                      {scopeLabel}
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-cafe-secondary">{v.description}</p>
                </div>
              </div>
              <div className="mt-4 console-card-soft rounded-[18px] px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cafe-muted">当前值</p>
                <p className="mt-2 break-all font-mono text-[13px] text-cafe-secondary">{displayValue}</p>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
