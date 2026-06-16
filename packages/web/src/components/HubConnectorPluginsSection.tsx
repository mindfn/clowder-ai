'use client';

/**
 * HubConnectorPluginsSection — F231 Phase B-3
 *
 * Renders plugin management UI below the built-in connector list:
 * - Lists installed external plugins with uninstall action
 * - Upload button to install/update plugins from tar.gz archives
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface InstalledPlugin {
  id: string;
  name: string;
  hasManifest: boolean;
  hasEntry: boolean;
}

interface PluginListResponse {
  plugins: InstalledPlugin[];
}

export function HubConnectorPluginsSection({ onPluginChange }: { onPluginChange?: () => void }) {
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchPlugins = useCallback(async () => {
    try {
      const res = await apiFetch('/api/connectors/plugins');
      if (res.ok) {
        const data: PluginListResponse = await res.json();
        setPlugins(data.plugins);
      }
    } catch {
      /* silent */
    } finally {
      setLoaded(true);
    }
  }, []);

  // Load plugin list on mount
  useEffect(() => {
    fetchPlugins();
  }, [fetchPlugins]);

  const handleUpload = async (file: File) => {
    setUploading(true);
    setMessage(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await apiFetch('/api/connectors/plugins/install', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: 'success', text: `${data.action === 'updated' ? '更新' : '安装'}成功: ${data.id}` });
        fetchPlugins();
        onPluginChange?.();
      } else {
        setMessage({ type: 'error', text: data.error ?? '安装失败' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: `上传失败: ${(err as Error).message}` });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleUninstall = async (id: string, clearConfig: boolean) => {
    setUninstallingId(id);
    setMessage(null);
    try {
      const qs = clearConfig ? '?clearConfig=true' : '';
      const res = await apiFetch(`/api/connectors/plugins/${id}${qs}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: 'success', text: `已卸载: ${id}${clearConfig ? ' (配置已清除)' : ''}` });
        fetchPlugins();
        onPluginChange?.();
      } else {
        setMessage({ type: 'error', text: data.error ?? '卸载失败' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: `卸载失败: ${(err as Error).message}` });
    } finally {
      setUninstallingId(null);
    }
  };

  return (
    <div className="mt-6 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-cafe-primary">扩展插件</h3>
        <label
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-cafe-border px-3 py-1.5 text-xs font-medium text-cafe-secondary transition-colors hover:bg-cafe-hover ${uploading ? 'pointer-events-none opacity-50' : ''}`}
        >
          <UploadIcon />
          {uploading ? '安装中...' : '安装插件'}
          <input
            ref={fileInputRef}
            type="file"
            accept=".tar.gz,.tgz"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUpload(f);
            }}
          />
        </label>
      </div>

      {message && (
        <div
          className={`rounded-lg px-3 py-2 text-xs ${
            message.type === 'success'
              ? 'bg-conn-emerald-bg text-conn-emerald-text border border-conn-emerald-ring'
              : 'bg-conn-red-bg text-conn-red-text border border-conn-red-ring'
          }`}
        >
          {message.text}
        </div>
      )}

      {plugins.length === 0 && loaded && (
        <p className="text-xs text-cafe-muted">暂无已安装的扩展插件。上传 .tar.gz 格式的连接器插件包即可安装。</p>
      )}

      {plugins.map((p) => (
        <div
          key={p.id}
          className="flex items-center justify-between rounded-xl border border-cafe-border bg-cafe-surface px-3 py-2"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-cafe-primary">{p.name}</span>
            <span className="text-xs text-cafe-muted">({p.id})</span>
            {!p.hasManifest && (
              <span className="rounded bg-conn-amber-bg px-1.5 py-0.5 text-[10px] text-conn-amber-text">
                缺少 manifest
              </span>
            )}
            {!p.hasEntry && (
              <span className="rounded bg-conn-red-bg px-1.5 py-0.5 text-[10px] text-conn-red-text">缺少入口文件</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={uninstallingId === p.id}
              onClick={() => handleUninstall(p.id, false)}
              className="rounded-lg px-2 py-1 text-xs text-conn-red-text transition-colors hover:bg-conn-red-bg disabled:opacity-50"
              title="卸载插件（保留配置）"
            >
              {uninstallingId === p.id ? '卸载中...' : '卸载'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function UploadIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="h-3.5 w-3.5"
      role="img"
      aria-label="上传"
    >
      <path d="M8 2a.75.75 0 0 1 .75.75v5.69l1.72-1.72a.75.75 0 1 1 1.06 1.06l-3 3a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 0 1 1.06-1.06l1.72 1.72V2.75A.75.75 0 0 1 8 2Z" />
      <path d="M3.5 9.75a.75.75 0 0 0-1.5 0v1.5A2.75 2.75 0 0 0 4.75 14h6.5A2.75 2.75 0 0 0 14 11.25v-1.5a.75.75 0 0 0-1.5 0v1.5c0 .69-.56 1.25-1.25 1.25h-6.5c-.69 0-1.25-.56-1.25-1.25v-1.5Z" />
    </svg>
  );
}
