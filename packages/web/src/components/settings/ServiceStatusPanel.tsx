'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface ServiceManifest {
  id: string;
  name: string;
  type: 'python' | 'node' | 'binary';
  port?: number;
  enablesFeatures: string[];
}

type ServiceStatus = 'running' | 'stopped' | 'unknown' | 'error';

interface ServiceState {
  manifest: ServiceManifest;
  status: ServiceStatus;
  lastChecked: number | null;
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
}

export function ServiceStatusPanel({ filterFeatures, title }: ServiceStatusPanelProps) {
  const [services, setServices] = useState<ServiceState[]>([]);
  const [loading, setLoading] = useState(true);

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

  if (loading) return null;
  if (services.length === 0) return null;

  return (
    <div className="rounded-xl border border-cafe-border bg-cafe-surface p-3">
      {title && <p className="text-xs font-medium text-cafe-secondary mb-2">{title}</p>}
      <div className="space-y-1.5">
        {services.map((s) => {
          const cfg = STATUS_CONFIG[s.status];
          return (
            <div key={s.manifest.id} className="flex items-center justify-between text-xs">
              <span className="text-cafe-primary">{s.manifest.name}</span>
              <span className="flex items-center gap-1.5 text-cafe-muted">
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
                {cfg.label}
                {s.manifest.port && s.status === 'running' && (
                  <span className="text-cafe-muted/60">:{s.manifest.port}</span>
                )}
                {s.error && <span className="text-red-500 truncate max-w-[120px]">{s.error}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
