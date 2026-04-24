'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface PluginDef {
  id: string;
  name: string;
  description: string;
  category: 'devops' | 'communication' | 'productivity';
  source: 'platform' | 'service';
  status: 'active' | 'configured' | 'available';
  statusLabel: string;
}

interface ServiceState {
  manifest: { id: string; enablesFeatures: string[] };
  status: 'running' | 'stopped' | 'unknown' | 'error';
}

const PLUGIN_CATALOG: Omit<PluginDef, 'status' | 'statusLabel'>[] = [
  {
    id: 'pr-tracking',
    name: 'GitHub PR Tracking',
    description: 'PR 生命周期追踪：创建、Review 状态、CI 结果自动同步到对话线程',
    category: 'devops',
    source: 'platform',
  },
  {
    id: 'review-router',
    name: 'Review Feedback Router',
    description: 'GitHub review decisions 和 inline comments 自动投递到对应猫的工作线程',
    category: 'devops',
    source: 'platform',
  },
  {
    id: 'ci-cd-monitor',
    name: 'CI/CD Monitor',
    description: 'GitHub Actions 运行状态监控，失败时自动通知相关猫排查',
    category: 'devops',
    source: 'platform',
  },
  {
    id: 'voice-companion',
    name: '语音陪伴',
    description: '语音输入/输出和实时陪伴对话模式',
    category: 'communication',
    source: 'service',
  },
  {
    id: 'browser-automation',
    name: 'Browser Automation',
    description: '通过 Chrome MCP 进行浏览器自动化操作和 UI 验证',
    category: 'productivity',
    source: 'service',
  },
];

const CATEGORY_LABELS: Record<string, string> = {
  devops: 'DevOps & 工程',
  communication: '通信',
  productivity: '效率工具',
};

const CATEGORY_META: Record<PluginDef['category'], { eyebrow: string; accent: string }> = {
  devops: { eyebrow: 'Platform', accent: 'var(--color-gemini-primary)' },
  communication: { eyebrow: 'Experience', accent: 'var(--color-cafe-accent)' },
  productivity: { eyebrow: 'Tools', accent: 'var(--color-codex-primary)' },
};

const STATUS_STYLES: Record<string, { dot: string; bg: string; text: string }> = {
  active: { dot: 'bg-emerald-500', bg: 'bg-emerald-50', text: 'text-emerald-700' },
  configured: { dot: 'bg-amber-500', bg: 'bg-amber-50', text: 'text-amber-700' },
  available: { dot: 'bg-gray-300', bg: 'bg-gray-50', text: 'text-gray-500' },
};

const SERVICE_FEATURE_MAP: Record<string, string[]> = {
  'voice-companion': ['voice-input', 'voice-output', 'voice-companion'],
  'browser-automation': ['browser-automation-mcp'],
};

export function resolvePluginStatuses(services: ServiceState[], apiReachable: boolean): PluginDef[] {
  const runningFeatures = new Set<string>();
  const knownFeatures = new Set<string>();
  for (const svc of services) {
    for (const f of svc.manifest.enablesFeatures) {
      knownFeatures.add(f);
      if (svc.status === 'running') runningFeatures.add(f);
    }
  }

  return PLUGIN_CATALOG.map((p) => {
    if (p.source === 'platform') {
      if (apiReachable) return { ...p, status: 'active' as const, statusLabel: '内置运行中' };
      return { ...p, status: 'available' as const, statusLabel: 'API 不可达' };
    }

    const features = SERVICE_FEATURE_MAP[p.id] ?? [];
    const hasRunning = features.some((f) => runningFeatures.has(f));
    const hasKnown = features.some((f) => knownFeatures.has(f));

    if (hasRunning) return { ...p, status: 'active' as const, statusLabel: '运行中' };
    if (hasKnown) return { ...p, status: 'configured' as const, statusLabel: '已配置' };
    return { ...p, status: 'available' as const, statusLabel: '可用' };
  });
}

export function PluginsContent() {
  const [plugins, setPlugins] = useState<PluginDef[]>([]);
  const [loading, setLoading] = useState(true);

  const resolveStatus = useCallback(async () => {
    let services: ServiceState[] = [];
    let apiReachable = false;
    try {
      const res = await apiFetch('/api/services');
      apiReachable = true;
      if (res.ok) {
        const data = (await res.json()) as { services: ServiceState[] };
        services = data.services;
      }
    } catch {
      /* unavailable */
    }

    setPlugins(resolvePluginStatuses(services, apiReachable));
    setLoading(false);
  }, []);

  useEffect(() => {
    resolveStatus();
  }, [resolveStatus]);

  if (loading) return <p className="text-sm text-cafe-muted">加载中...</p>;

  const grouped = Object.entries(CATEGORY_LABELS)
    .map(([cat, label]) => ({
      category: cat,
      label,
      items: plugins.filter((p) => p.category === cat),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="space-y-5">
      {grouped.map((group) => (
        <section key={group.category} className="console-section-shell rounded-[28px] p-5 md:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cafe-muted">
                {CATEGORY_META[group.category as PluginDef['category']].eyebrow}
              </p>
              <h3 className="text-lg font-semibold tracking-[-0.03em] text-cafe">{group.label}</h3>
              <p className="text-sm leading-6 text-cafe-secondary">
                把 Console 的内置能力和依赖服务统一放到一个可读的状态视图里。
              </p>
            </div>
            <span
              className="console-pill inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold"
              style={{ color: CATEGORY_META[group.category as PluginDef['category']].accent }}
            >
              {group.items.length} integrations
            </span>
          </div>
          <div className="mt-4 grid gap-3 xl:grid-cols-2">
            {group.items.map((plugin) => {
              const style = STATUS_STYLES[plugin.status];
              return (
                <article key={plugin.id} className="console-list-card rounded-[22px] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-cafe">{plugin.name}</p>
                        <span className="console-pill inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold text-cafe-secondary">
                          {plugin.source === 'platform' ? '内置能力' : '依赖服务'}
                        </span>
                      </div>
                      <p className="mt-1.5 text-sm leading-6 text-cafe-secondary">{plugin.description}</p>
                    </div>
                    <span className="console-status-chip" data-status={plugin.status}>
                      <span className={`inline-block h-1.5 w-1.5 rounded-full ${style.dot}`} />
                      {plugin.statusLabel}
                    </span>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2 text-[11px]">
                    <span className="console-pill inline-flex items-center rounded-full px-2.5 py-1 text-cafe-secondary">
                      {plugin.id}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ${style.bg} ${style.text}`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
                      status
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
