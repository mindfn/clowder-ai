'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { HubIcon } from '../hub-icons';
import {
  SettingsResourceIconButton,
  SettingsResourceToggleSwitch,
  settingsResourceActionGroupClass,
  settingsResourceCardClass,
} from '../SettingsResourceCard';
import { InstallPreviewModal } from './InstallPreviewModal';

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
    models?: {
      name: string;
      size: string;
      autoDownload: boolean;
      isDefault?: boolean;
      description?: string;
    }[];
    estimatedMinutes?: number;
  };
  scripts?: {
    install?: string;
    start?: string;
    stop?: string;
    uninstall?: string;
  };
  configVars?: string[];
}

type ServiceStatus = 'running' | 'starting' | 'installing' | 'uninstalling' | 'stopped' | 'unknown' | 'error';
type InstallStatus = 'none' | 'installing' | 'installed' | 'failed';

interface ServiceState {
  manifest: ServiceManifest;
  status: ServiceStatus;
  installed: boolean;
  installStatus: InstallStatus;
  enabled: boolean;
  selectedModel?: string;
  lastChecked: number | null;
  healthDetail?: Record<string, unknown>;
  error?: string;
  /** Set by the async install close handler when exit code !== 0. */
  lastInstallError?: string;
  /** Human-readable remediation hint from detectInstallFailureHint(). */
  lastInstallTroubleshootHint?: string;
}

const STATUS_CONFIG: Record<ServiceStatus, { dot: string; label: string }> = {
  running: { dot: 'bg-conn-emerald-text', label: '运行中' },
  starting: { dot: 'bg-conn-amber-text', label: '启动中' },
  installing: { dot: 'bg-conn-amber-text', label: '安装中' },
  uninstalling: { dot: 'bg-conn-amber-text', label: '卸载中' },
  stopped: { dot: 'bg-cafe-surface-sunken', label: '未启动' },
  error: { dot: 'bg-conn-red-text', label: '异常' },
  unknown: { dot: 'bg-cafe-surface-sunken', label: '未知' },
};

const ROW_CLASS = 'flex items-center gap-4 px-5 py-4';

interface ServiceStatusPanelProps {
  filterFeatures?: string[];
  title?: string;
}

export function ServiceStatusPanel({ filterFeatures, title }: ServiceStatusPanelProps) {
  const addToast = useToastStore((s) => s.addToast);
  const [services, setServices] = useState<ServiceState[]>([]);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<Map<string, string>>(new Map());
  const pollRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const [installPreview, setInstallPreview] = useState<ServiceManifest | null>(null);

  const fetchServices = useCallback(async () => {
    try {
      const res = await apiFetch('/api/services');
      if (res.ok) {
        const data = (await res.json()) as { services?: ServiceState[] };
        let list = data.services ?? [];
        if (filterFeatures?.length) {
          list = list.filter((s) => s.manifest?.enablesFeatures?.some((f) => filterFeatures.includes(f)) ?? false);
        }
        setServices(list);
      }
    } catch {
      /* network error */
    } finally {
      setLoading(false);
    }
  }, [filterFeatures]);

  useEffect(() => {
    fetchServices();
  }, [fetchServices]);

  useEffect(() => {
    const ref = pollRef.current;
    return () => {
      for (const iv of ref.values()) clearInterval(iv);
      ref.clear();
    };
  }, []);

  const startLogPoll = useCallback((id: string) => {
    if (pollRef.current.has(id)) return;
    const iv = setInterval(async () => {
      try {
        const r = await apiFetch(`/api/services/${id}/logs`);
        if (r.ok) {
          const data = (await r.json()) as { lines: string[] };
          const lastLine = data.lines.filter((l) => l.trim()).pop();
          // tqdm progress bars (huggingface_hub snapshot_download, etc.)
          // use \r (carriage return) to overwrite the same TTY line in-place.
          // When piped into the per-service log file the whole sequence
          // collapses into one logical line — the panel would otherwise
          // render every frame concatenated. Split on \r and take the most
          // recent frame so the UI shows the live progress as a single
          // up-to-date line.
          const last = lastLine
            ?.split(/\r/)
            .map((s) => s.trim())
            .filter(Boolean)
            .at(-1);
          if (last) setProgress((prev) => new Map(prev).set(id, last));
        }
      } catch {
        /* ignore */
      }
    }, 2000);
    pollRef.current.set(id, iv);
  }, []);

  const stopLogPoll = useCallback((id: string) => {
    const iv = pollRef.current.get(id);
    if (iv) {
      clearInterval(iv);
      pollRef.current.delete(id);
    }
    setProgress((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Auto-attach log polling to any service the API reports as actively
  // installing / uninstalling. Backend `installingServices` Set drives
  // s.status='installing' as soon as POST /install hits the server (well
  // before the spawn completes), so this single source of truth covers
  // both the freshly-clicked case and post-page-refresh recovery.
  useEffect(() => {
    const ref = pollRef.current;
    for (const s of services) {
      const id = s.manifest.id;
      const inFlight = s.status === 'installing' || s.status === 'uninstalling';
      if (inFlight && !ref.has(id)) startLogPoll(id);
      else if (!inFlight && ref.has(id)) stopLogPoll(id);
    }
  }, [services, startLogPoll, stopLogPoll]);

  // Detect installStatus transition 'installing' → 'failed' and toast the
  // captured failure tail + troubleshoot hint once. Because /install is
  // async (returns immediately with status='installing'), the failure
  // never comes back in the POST response itself — we surface it here
  // via the 3s polling.
  const prevInstallStatusRef = useRef<Record<string, InstallStatus | undefined>>({});
  useEffect(() => {
    const prev = prevInstallStatusRef.current;
    for (const s of services) {
      const id = s.manifest.id;
      const prevStatus = prev[id];
      if (prevStatus === 'installing' && s.installStatus === 'failed' && s.lastInstallError) {
        const detail = s.lastInstallError;
        const message = s.lastInstallTroubleshootHint ? `${detail}\n\n${s.lastInstallTroubleshootHint}` : detail;
        addToast({
          type: 'error',
          title: `${s.manifest.name} 安装失败`,
          message,
          duration: s.lastInstallTroubleshootHint ? 15000 : 8000,
        });
      }
      prev[id] = s.installStatus;
    }
  }, [services, addToast]);

  // Auto-refetch /api/services every 3s while any service is transitioning
  // (installing / uninstalling / starting). Otherwise the user has to
  // manually refresh after a long install/start to see the new state.
  // Stops as soon as everything settles into running / stopped / error.
  useEffect(() => {
    const hasTransitional = services.some(
      (s) => s.status === 'installing' || s.status === 'uninstalling' || s.status === 'starting',
    );
    if (!hasTransitional) return;
    const iv = setInterval(() => {
      void fetchServices();
    }, 3000);
    return () => clearInterval(iv);
  }, [services, fetchServices]);

  const awaitServiceHealth = useCallback(
    async (id: string): Promise<{ status: string; error?: string }> => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        await fetchServices();
        const res = await apiFetch(`/api/services/${id}/health`);
        if (!res.ok) continue;
        const state = (await res.json()) as { status: string; error?: string };
        if (state.status === 'running' || state.status === 'error') return state;
      }
      return { status: 'timeout' };
    },
    [fetchServices],
  );

  const pollStartStatus = useCallback(
    async (id: string, displayName: string) => {
      startLogPoll(id);
      const result = await awaitServiceHealth(id);
      if (result.status === 'error') {
        addToast({
          type: 'error',
          title: `${displayName} 启动失败`,
          message: result.error ?? '服务异常，请查看日志',
          duration: 8000,
        });
      } else if (result.status === 'timeout') {
        addToast({
          type: 'error',
          title: `${displayName} 启动超时`,
          message: '服务未能在预期时间内启动，请检查日志',
          duration: 8000,
        });
      }
      stopLogPoll(id);
    },
    [addToast, awaitServiceHealth, startLogPoll, stopLogPoll],
  );

  const pollStopStatus = useCallback(async (id: string) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const healthRes = await apiFetch(`/api/services/${id}/health`);
      if (!healthRes.ok) break;
      const state = (await healthRes.json()) as { status: string };
      if (state.status !== 'running') break;
    }
  }, []);

  const handleAction = useCallback(
    async (
      id: string,
      action: 'start' | 'stop' | 'install' | 'uninstall',
      opts?: { model?: string; name?: string; port?: number },
    ): Promise<boolean> => {
      const displayName = opts?.name ?? id;
      const longRunning = action === 'install' || action === 'uninstall';
      if (longRunning) startLogPoll(id);
      let ok = false;
      try {
        const fetchOpts: RequestInit = { method: 'POST' };
        const payload: Record<string, unknown> = {};
        if (opts?.model) payload.model = opts.model;
        if (typeof opts?.port === 'number') payload.port = opts.port;
        if (Object.keys(payload).length > 0) {
          fetchOpts.headers = { 'Content-Type': 'application/json' };
          fetchOpts.body = JSON.stringify(payload);
        }
        const res = await apiFetch(`/api/services/${id}/${action}`, fetchOpts);
        ok = res.ok;
        // Backend now returns { ok, state } on success: state is the
        // post-action snapshot (status='installing' / 'starting' / etc).
        // We splice it straight into the services array — single source
        // of truth lives on the server, no shadow `acting` Set needed.
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          state?: ServiceState;
          error?: string;
          output?: string;
          troubleshootHint?: string;
        };
        if (body.state) {
          setServices((prev) => prev.map((s) => (s.manifest.id === id ? (body.state as ServiceState) : s)));
        }
        if (!res.ok && (action === 'start' || action === 'install')) {
          const detail = body.output?.trim().split('\n').filter(Boolean).pop();
          const baseMessage = detail || body.error || `HTTP ${res.status}`;
          const message = body.troubleshootHint ? `${baseMessage}\n\n${body.troubleshootHint}` : baseMessage;
          addToast({
            type: 'error',
            title: `${displayName} ${action === 'start' ? '启动' : '安装'}失败`,
            message,
            duration: body.troubleshootHint ? 15000 : 8000,
          });
        }
        // Don't refetch — body.state already gave us the post-action
        // snapshot. The 3s transitional poll keeps tracking until the
        // background install/start completes.
        if (res.ok && action === 'start') await pollStartStatus(id, displayName);
        if (res.ok && action === 'stop') await pollStopStatus(id);
        // After polling settles, fetch once more so installStatus /
        // lastInstallError / etc. reach the UI for the final state.
        await fetchServices();
      } catch {
        stopLogPoll(id);
      } finally {
        if (longRunning) stopLogPoll(id);
      }
      return ok;
    },
    [addToast, fetchServices, pollStartStatus, pollStopStatus, startLogPoll, stopLogPoll],
  );

  const handleToggle = useCallback(
    async (s: ServiceState) => {
      const m = s.manifest;
      const nextEnabled = !s.enabled;

      if (nextEnabled && s.installStatus !== 'installed') {
        setInstallPreview(m);
        return;
      }

      try {
        const res = await apiFetch(`/api/services/${m.id}/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: nextEnabled }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          addToast({
            type: 'error',
            title: `${m.name} ${nextEnabled ? '启用' : '禁用'}失败`,
            message: (body as { error?: string }).error ?? `HTTP ${res.status}`,
            duration: 5000,
          });
          return;
        }

        // /toggle returns { ok, state } — splice it into the services
        // array so the UI reflects enabled flip immediately.
        const body = (await res.json().catch(() => ({}))) as { state?: ServiceState };
        if (body.state) {
          setServices((prev) => prev.map((s2) => (s2.manifest.id === m.id ? (body.state as ServiceState) : s2)));
        }

        if (nextEnabled && s.status !== 'running' && s.status !== 'starting') {
          const ok = await handleAction(m.id, 'start', { name: m.name });
          if (!ok) {
            await apiFetch(`/api/services/${m.id}/toggle`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled: false }),
            });
            await fetchServices();
          }
        } else if (!nextEnabled && s.status === 'running') {
          const ok = await handleAction(m.id, 'stop', { name: m.name });
          if (!ok) {
            await apiFetch(`/api/services/${m.id}/toggle`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled: true }),
            });
            await fetchServices();
          }
        }
      } catch {
        addToast({ type: 'error', title: '网络错误', message: `无法连接到服务管理 API`, duration: 5000 });
      }
    },
    [fetchServices, handleAction, addToast],
  );

  if (loading) return null;
  if (services.length === 0) return null;

  return (
    <div className="space-y-3">
      {title && <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cafe-muted">{title}</p>}
      {services.map((s) => {
        const m = s.manifest;
        const isTransitional = s.status === 'starting' || s.status === 'installing' || s.status === 'uninstalling';
        // `busy` (button disabled) follows the single server-side source of
        // truth: while any in-flight transition is on this card, the button
        // is disabled. installingServices / startingServices / uninstallingServices
        // are set the moment POST hits the server, so the response.state we
        // splice into the array shows isTransitional=true immediately.
        const busy = isTransitional;
        const cfg = STATUS_CONFIG[s.status] ?? STATUS_CONFIG.unknown;
        const installFailed = s.installStatus === 'failed';
        const notInstalled = !s.installed && !installFailed;
        // In-flight install/uninstall wins over stale 'failed' label. When
        // the user retries after a failed install, status flips to
        // 'installing' but installStatus stays 'failed' until the new spawn
        // either succeeds or fails — without this priority the card would
        // simultaneously show '安装失败' (label) and '安装中...' (button),
        // which is confusing.
        const statusLabel = isTransitional
          ? cfg.label
          : installFailed
            ? '安装失败'
            : notInstalled
              ? '未安装'
              : cfg.label;
        const statusDot = isTransitional
          ? cfg.dot
          : installFailed
            ? 'bg-conn-red-text'
            : notInstalled
              ? 'bg-cafe-surface-sunken'
              : cfg.dot;
        const toggleDisabled = busy || isTransitional;

        return (
          <div key={m.id} className={settingsResourceCardClass}>
            <div className={ROW_CLASS}>
              <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusDot}`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-cafe">{m.name}</p>
                <p className="mt-0.5 truncate text-xs text-cafe-muted">
                  {m.type}
                  {m.port ? ` · :${m.port}` : ''} · {statusLabel}
                  {(() => {
                    if (notInstalled || installFailed) return '';
                    const runtimeModel = (s.healthDetail?.model as string) || s.selectedModel;
                    return runtimeModel ? ` · ${runtimeModel.split('/').pop()}` : '';
                  })()}
                </p>
                {progress.get(m.id) && (
                  <p className="mt-1 truncate text-[11px] text-cafe-secondary font-mono">{progress.get(m.id)}</p>
                )}
                {s.error && <p className="mt-0.5 truncate text-[11px] text-conn-red-text">{s.error}</p>}
              </div>
              <div className={settingsResourceActionGroupClass}>
                {notInstalled || installFailed ? (
                  // Button is always rendered when the service isn't installed
                  // (or last install failed). isTransitional flips it to a
                  // disabled "安装中..." / "卸载中..." label so users keep
                  // the visual anchor; previously we hid the button entirely
                  // when status === 'installing', which left an empty card
                  // and stranded users when state was wrong.
                  <button
                    type="button"
                    disabled={busy || isTransitional}
                    onClick={() => setInstallPreview(m)}
                    className="console-button-secondary px-3 py-1.5 text-xs disabled:opacity-40"
                  >
                    {s.status === 'installing'
                      ? '安装中...'
                      : s.status === 'uninstalling'
                        ? '卸载中...'
                        : installFailed
                          ? '重试安装'
                          : '安装'}
                  </button>
                ) : s.installed ? (
                  <>
                    <SettingsResourceToggleSwitch
                      enabled={s.enabled}
                      busy={toggleDisabled}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggle(s);
                      }}
                    />
                    {!s.enabled && !isTransitional && !!m.scripts?.uninstall && (
                      <SettingsResourceIconButton
                        disabled={busy}
                        onClick={() => handleAction(m.id, 'uninstall', { name: m.name })}
                        title="卸载"
                        aria-label="卸载"
                        tone="danger"
                      >
                        <HubIcon name="trash" className="h-4 w-4" />
                      </SettingsResourceIconButton>
                    )}
                  </>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
      {installPreview && (
        <InstallPreviewModal
          open={!!installPreview}
          serviceId={installPreview.id}
          serviceName={installPreview.name}
          estimatedMinutes={installPreview.prerequisites?.estimatedMinutes}
          onConfirm={async ({ model: selectedModel, port }) => {
            const id = installPreview.id;
            const name = installPreview.name;
            setInstallPreview(null);
            const ok = await handleAction(id, 'install', { model: selectedModel, name, port });
            if (ok && selectedModel) {
              await apiFetch(`/api/services/${id}/toggle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: false, model: selectedModel }),
              });
            }
            await fetchServices();
          }}
          onCancel={() => setInstallPreview(null)}
        />
      )}
    </div>
  );
}
