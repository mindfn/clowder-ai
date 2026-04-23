'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface ServiceManifest {
  id: string;
  name: string;
  type: 'python' | 'node' | 'binary';
  port?: number;
  enablesFeatures: string[];
  prerequisites?: {
    runtime?: string;
    venvPath?: string;
    packages?: string[];
  };
  scripts?: {
    start?: string;
    stop?: string;
  };
  configVars?: string[];
}

type ServiceStatus = 'running' | 'stopped' | 'unknown' | 'error';

interface ServiceState {
  manifest: ServiceManifest;
  status: ServiceStatus;
  lastChecked: number | null;
  healthDetail?: Record<string, unknown>;
  error?: string;
}

const STATUS_CONFIG: Record<ServiceStatus, { dot: string; label: string }> = {
  running: { dot: 'bg-emerald-500', label: '运行中' },
  stopped: { dot: 'bg-gray-400', label: '未启动' },
  error: { dot: 'bg-red-500', label: '异常' },
  unknown: { dot: 'bg-gray-300', label: '未知' },
};

interface ServiceStatusPanelProps {
  filterFeatures?: string[];
  title?: string;
  expandable?: boolean;
}

export function ServiceStatusPanel({ filterFeatures, title, expandable }: ServiceStatusPanelProps) {
  const [services, setServices] = useState<ServiceState[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const fetchServices = useCallback(async () => {
    try {
      const res = await apiFetch('/api/services');
      if (res.ok) {
        const data = (await res.json()) as { services: ServiceState[] };
        let list = data.services;
        if (filterFeatures?.length) {
          list = list.filter((s) => s.manifest.enablesFeatures.some((f) => filterFeatures.includes(f)));
        }
        setServices(list);
      }
    } catch {
      /* network error — leave empty */
    } finally {
      setLoading(false);
    }
  }, [filterFeatures]);

  useEffect(() => {
    fetchServices();
  }, [fetchServices]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchServices();
    setRefreshing(false);
  }, [fetchServices]);

  const handleHealthCheck = useCallback(async (id: string) => {
    try {
      const res = await apiFetch(`/api/services/${id}/health`);
      if (res.ok) {
        const updated = (await res.json()) as ServiceState;
        setServices((prev) => prev.map((s) => (s.manifest.id === id ? updated : s)));
      }
    } catch {
      /* ignore */
    }
  }, []);

  if (loading) return null;
  if (services.length === 0) return null;

  const showDetail = expandable ?? !filterFeatures;

  return (
    <div className="rounded-xl border border-cafe-border bg-cafe-surface p-3">
      <div className="flex items-center justify-between mb-2">
        {title && <p className="text-xs font-medium text-cafe-secondary">{title}</p>}
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="text-xs text-cafe-muted hover:text-cafe-secondary transition-colors disabled:opacity-40"
        >
          {refreshing ? '刷新中...' : '刷新'}
        </button>
      </div>
      <div className="space-y-1.5">
        {services.map((s) => {
          const cfg = STATUS_CONFIG[s.status];
          const isExpanded = expanded === s.manifest.id;
          return (
            <div key={s.manifest.id}>
              <div className="flex items-center justify-between text-xs">
                <button
                  type="button"
                  onClick={() => showDetail && setExpanded(isExpanded ? null : s.manifest.id)}
                  className={`text-cafe-primary text-left ${showDetail ? 'hover:text-cafe-accent cursor-pointer' : ''}`}
                >
                  {showDetail && (
                    <svg
                      className={`inline-block w-3 h-3 mr-1 text-cafe-muted transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path
                        fillRule="evenodd"
                        d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                        clipRule="evenodd"
                      />
                    </svg>
                  )}
                  {s.manifest.name}
                </button>
                <span className="flex items-center gap-1.5 text-cafe-muted">
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
                  {cfg.label}
                  {s.manifest.port && s.status === 'running' && (
                    <span className="text-cafe-muted/60">:{s.manifest.port}</span>
                  )}
                  {s.error && <span className="text-red-500 truncate max-w-[120px]">{s.error}</span>}
                </span>
              </div>
              {showDetail && isExpanded && (
                <ServiceDetail service={s} onHealthCheck={() => handleHealthCheck(s.manifest.id)} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ServiceDetail({ service, onHealthCheck }: { service: ServiceState; onHealthCheck: () => void }) {
  const m = service.manifest;
  return (
    <div className="ml-4 mt-1.5 mb-2 pl-3 border-l-2 border-cafe-border space-y-1.5 text-xs text-cafe-muted">
      <div className="flex gap-4">
        <span>
          类型: <span className="text-cafe-secondary">{m.type}</span>
        </span>
        {m.port && (
          <span>
            端口: <span className="text-cafe-secondary">{m.port}</span>
          </span>
        )}
      </div>

      {m.enablesFeatures.length > 0 && (
        <div>
          <span>功能: </span>
          <span className="text-cafe-secondary">{m.enablesFeatures.join(', ')}</span>
        </div>
      )}

      {m.prerequisites?.runtime && (
        <div>
          <span>运行环境: </span>
          <span className="text-cafe-secondary">{m.prerequisites.runtime}</span>
        </div>
      )}

      {m.prerequisites?.packages && m.prerequisites.packages.length > 0 && (
        <div>
          <span>依赖: </span>
          <span className="font-mono text-cafe-secondary">{m.prerequisites.packages.join(', ')}</span>
        </div>
      )}

      {m.scripts?.start && (
        <div>
          <span>启动: </span>
          <code className="text-cafe-secondary bg-cafe-surface-elevated px-1 py-0.5 rounded">{m.scripts.start}</code>
        </div>
      )}

      {m.configVars && m.configVars.length > 0 && (
        <div>
          <span>配置变量: </span>
          <span className="font-mono text-cafe-secondary">{m.configVars.join(', ')}</span>
        </div>
      )}

      <button
        type="button"
        onClick={onHealthCheck}
        className="mt-1 px-2 py-0.5 rounded border border-cafe-border text-cafe-secondary
                   hover:bg-cafe-surface-elevated transition-colors"
      >
        检查健康
      </button>
    </div>
  );
}
