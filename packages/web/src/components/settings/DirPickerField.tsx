'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { formInputClass } from '../mcp-form-helpers';

interface DirPickerFieldProps {
  value: string;
  onChange?: (path: string) => void;
  disabled?: boolean;
  placeholder?: string;
  'aria-label'?: string;
}

interface DirListEntry {
  name: string;
  path: string;
}

interface DirListResponse {
  path: string;
  parent: string | null;
  entries: DirListEntry[];
}

function hasDesktopBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.desktopBridge?.pickDirectory === 'function';
}

function DirPickerModal({
  initialPath,
  onSelect,
  onCancel,
}: {
  initialPath: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}) {
  const [currentPath, setCurrentPath] = useState(initialPath || '/');
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  const loadDir = useCallback(async (path: string) => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/config/dir-list?path=${encodeURIComponent(path)}`);
      const body = (await res.json().catch(() => ({}))) as DirListResponse & { error?: string };
      if (seq !== requestSeqRef.current) return;
      if (!res.ok) {
        setError(body.error ?? '目录读取失败');
        return;
      }
      setCurrentPath(body.path);
      setParent(body.parent ?? null);
      setEntries(body.entries ?? []);
    } catch {
      if (seq !== requestSeqRef.current) return;
      setError('目录读取失败');
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDir(initialPath || '/');
  }, [initialPath, loadDir]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true">
      <div className="w-[28rem] max-w-[90vw] rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-4 shadow-xl">
        <div className="mb-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => parent && void loadDir(parent)}
            disabled={!parent || loading}
            className="shrink-0 rounded-full border border-[var(--console-border-soft)] px-2 py-0.5 text-xs transition-colors hover:border-[var(--console-border-strong)] hover:bg-[var(--console-hover-bg)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            上级
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-cafe-secondary" title={currentPath}>
            {currentPath}
          </span>
        </div>
        <div className="max-h-64 overflow-y-auto rounded-lg border border-[var(--console-border-soft)]">
          {loading && <div className="px-3 py-2 text-xs text-cafe-muted">加载中...</div>}
          {!loading && error && <div className="px-3 py-2 text-xs text-red-500">{error}</div>}
          {!loading && !error && entries.length === 0 && (
            <div className="px-3 py-2 text-xs text-cafe-muted">（无子目录）</div>
          )}
          {!loading &&
            !error &&
            entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                onClick={() => void loadDir(entry.path)}
                className="block w-full truncate px-3 py-1.5 text-left font-mono text-xs text-cafe transition-colors hover:bg-[var(--console-hover-bg)]"
              >
                {entry.name}/
              </button>
            ))}
        </div>
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 rounded-full border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-4 py-1.5 text-xs font-semibold text-cafe transition hover:bg-[var(--console-hover-bg)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onSelect(currentPath)}
            className="shrink-0 rounded-full border border-transparent bg-conn-blue-text px-4 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
          >
            选择当前目录
          </button>
        </div>
      </div>
    </div>
  );
}

export function DirPickerField({
  value,
  onChange,
  disabled,
  placeholder,
  'aria-label': ariaLabel,
}: DirPickerFieldProps) {
  const [modalOpen, setModalOpen] = useState(false);

  const handleElectronPick = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const picked = await bridge.pickDirectory();
    if (picked) onChange?.(picked);
  }, [onChange]);

  return (
    <div className="flex items-center gap-2">
      <input
        readOnly
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={`flex-1 ${formInputClass}`}
      />
      {!disabled && hasDesktopBridge() && (
        <button
          type="button"
          onClick={() => void handleElectronPick()}
          className="shrink-0 rounded-full border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-4 py-1.5 text-xs font-semibold text-cafe transition hover:bg-[var(--console-hover-bg)]"
        >
          选择…
        </button>
      )}
      {!disabled && !hasDesktopBridge() && (
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="shrink-0 rounded-full border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-4 py-1.5 text-xs font-semibold text-cafe transition hover:bg-[var(--console-hover-bg)]"
        >
          选择…
        </button>
      )}
      {modalOpen && (
        <DirPickerModal
          initialPath={value || '/'}
          onSelect={(path) => {
            onChange?.(path);
            setModalOpen(false);
          }}
          onCancel={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}
