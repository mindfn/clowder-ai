'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

type Transport = 'stdio' | 'streamableHttp';

interface KVPair {
  key: string;
  value: string;
}

export interface McpConfigModalProps {
  projectPath?: string;
  editId?: string;
  editData?: {
    transport?: Transport;
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    bearerTokenEnv?: string;
    headers?: Record<string, string>;
    headerEnvVars?: Record<string, string>;
  };
  onSaved: () => void;
  onClose: () => void;
}

export function McpConfigModal({ projectPath, editId, editData, onSaved, onClose }: McpConfigModalProps) {
  const isEdit = Boolean(editId);
  const [id, setId] = useState(editId ?? '');
  const [transport, setTransport] = useState<Transport>(editData?.transport ?? 'stdio');

  const [command, setCommand] = useState(editData?.command ?? '');
  const [args, setArgs] = useState<string[]>(editData?.args?.length ? editData.args : ['']);
  const [envPairs, setEnvPairs] = useState<KVPair[]>(
    editData?.env ? Object.entries(editData.env).map(([key, value]) => ({ key, value })) : [{ key: '', value: '' }],
  );
  const [envPassthrough, setEnvPassthrough] = useState<string[]>(['']);

  const [url, setUrl] = useState(editData?.url ?? '');
  const [bearerTokenEnv, setBearerTokenEnv] = useState(editData?.bearerTokenEnv ?? '');
  const [headers, setHeaders] = useState<KVPair[]>(
    editData?.headers
      ? Object.entries(editData.headers).map(([key, value]) => ({ key, value }))
      : [{ key: '', value: '' }],
  );
  const [headerEnvVars, setHeaderEnvVars] = useState<KVPair[]>(
    editData?.headerEnvVars
      ? Object.entries(editData.headerEnvVars).map(([key, value]) => ({ key, value }))
      : [{ key: '', value: '' }],
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const buildPayload = useCallback(() => {
    const payload: Record<string, unknown> = { id: id.trim() };
    if (projectPath) payload.projectPath = projectPath;

    if (transport === 'streamableHttp') {
      payload.transport = 'streamableHttp';
      if (url.trim()) payload.url = url.trim();
      if (bearerTokenEnv.trim()) payload.bearerTokenEnv = bearerTokenEnv.trim();
      const h = kvToObj(headers);
      if (Object.keys(h).length > 0) payload.headers = h;
      const he = kvToObj(headerEnvVars);
      if (Object.keys(he).length > 0) payload.headerEnvVars = he;
    } else {
      if (command.trim()) payload.command = command.trim();
      const cleanArgs = args.filter((a) => a.trim());
      if (cleanArgs.length > 0) payload.args = cleanArgs;
      const ep = envPassthrough.filter((v) => v.trim());
      if (ep.length > 0) payload.envPassthrough = ep;
    }

    const env = kvToObj(envPairs);
    if (Object.keys(env).length > 0) payload.env = env;

    return payload;
  }, [id, transport, command, args, url, bearerTokenEnv, headers, headerEnvVars, envPairs, envPassthrough, projectPath]);

  const handleSave = useCallback(async () => {
    if (!id.trim()) return;
    setError(null);
    setSaving(true);
    try {
      const res = await apiFetch('/api/capabilities/mcp/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as Record<string, string>;
        setError(data.error ?? `保存失败 (${res.status})`);
        return;
      }
      onSaved();
      onClose();
    } catch {
      setError('网络错误');
    } finally {
      setSaving(false);
    }
  }, [id, buildPayload, onSaved, onClose]);

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
      data-testid="mcp-config-modal"
    >
      <div className="flex max-h-[85vh] w-[520px] flex-col overflow-hidden rounded-xl bg-[var(--console-panel-bg)] shadow-xl">
        <div className="border-b border-[var(--console-border-soft)] px-6 py-4">
          <h2 className="text-base font-bold text-cafe">{isEdit ? '编辑 MCP' : '连接至自定义 MCP'}</h2>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {error && (
            <div className="console-status-chip" data-status="error">
              {error}
            </div>
          )}

          <FormSection>
            <FormItem label="名称">
              <input
                type="text"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="MCP server name"
                className="console-form-input"
                disabled={isEdit}
              />
            </FormItem>
            <FormItem label="传输方式">
              <div className="console-segmented w-full">
                <button
                  type="button"
                  data-active={transport === 'stdio' ? 'true' : 'false'}
                  className="console-segmented-button flex-1"
                  onClick={() => setTransport('stdio')}
                >
                  STDIO
                </button>
                <button
                  type="button"
                  data-active={transport === 'streamableHttp' ? 'true' : 'false'}
                  className="console-segmented-button flex-1"
                  onClick={() => setTransport('streamableHttp')}
                >
                  流式 HTTP
                </button>
              </div>
            </FormItem>
          </FormSection>

          {transport === 'stdio' && (
            <FormSection>
              <FormItem label="启动命令">
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="e.g. npx"
                  className="console-form-input"
                />
              </FormItem>
              <FormItem label="参数">
                <DynamicList values={args} placeholder="" onChange={setArgs} addLabel="参数" />
              </FormItem>
              <FormItem label="环境变量">
                <DynamicKVList pairs={envPairs} onChange={setEnvPairs} addLabel="环境变量" />
              </FormItem>
              <FormItem label="环境变量传递">
                <DynamicList values={envPassthrough} placeholder="" onChange={setEnvPassthrough} addLabel="变量" />
              </FormItem>
            </FormSection>
          )}

          {transport === 'streamableHttp' && (
            <FormSection>
              <FormItem label="URL">
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://mcp.example.com/mcp"
                  className="console-form-input"
                />
              </FormItem>
              <FormItem label="Bearer 令牌环境变量">
                <input
                  type="text"
                  value={bearerTokenEnv}
                  onChange={(e) => setBearerTokenEnv(e.target.value)}
                  placeholder="MCP_BEARER_TOKEN"
                  className="console-form-input"
                />
              </FormItem>
              <FormItem label="标头">
                <DynamicKVList pairs={headers} onChange={setHeaders} addLabel="标头" />
              </FormItem>
              <FormItem label="来自环境变量的标头">
                <DynamicKVList pairs={headerEnvVars} onChange={setHeaderEnvVars} addLabel="变量" />
              </FormItem>
            </FormSection>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--console-border-soft)] px-6 py-4">
          <button type="button" onClick={onClose} className="console-button-ghost">
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!id.trim() || saving}
            className="console-button-primary disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

function kvToObj(pairs: KVPair[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const p of pairs) {
    if (p.key.trim()) obj[p.key.trim()] = p.value;
  }
  return obj;
}

function FormSection({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-y divide-[var(--console-border-soft)] overflow-hidden rounded-xl bg-[var(--console-card-bg)]">
      {children}
    </div>
  );
}

function FormItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3">
      <p className="mb-2 text-xs font-medium text-cafe-secondary">{label}</p>
      {children}
    </div>
  );
}

function DynamicList({
  values,
  placeholder,
  onChange,
  addLabel,
}: {
  values: string[];
  placeholder: string;
  onChange: (v: string[]) => void;
  addLabel: string;
}) {
  return (
    <div className="space-y-2">
      {values.map((val, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text"
            value={val}
            onChange={(e) => {
              const next = [...values];
              next[i] = e.target.value;
              onChange(next);
            }}
            placeholder={placeholder}
            className="console-form-input flex-1"
          />
          <button
            type="button"
            onClick={() => onChange(values.filter((_, j) => j !== i))}
            className="text-xs text-cafe-muted transition-colors hover:text-red-400"
            title="删除"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...values, ''])}
        className="w-full rounded-lg bg-[var(--console-card-soft-bg)] py-2 text-xs text-cafe-secondary transition-colors hover:text-cafe"
      >
        + 添加{addLabel}
      </button>
    </div>
  );
}

function DynamicKVList({
  pairs,
  onChange,
  addLabel,
}: {
  pairs: KVPair[];
  onChange: (p: KVPair[]) => void;
  addLabel: string;
}) {
  return (
    <div className="space-y-2">
      {pairs.map((pair, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text"
            value={pair.key}
            onChange={(e) => {
              const next = [...pairs];
              next[i] = { ...next[i], key: e.target.value };
              onChange(next);
            }}
            placeholder="键"
            className="console-form-input flex-1"
          />
          <input
            type="text"
            value={pair.value}
            onChange={(e) => {
              const next = [...pairs];
              next[i] = { ...next[i], value: e.target.value };
              onChange(next);
            }}
            placeholder="值"
            className="console-form-input flex-1"
          />
          <button
            type="button"
            onClick={() => onChange(pairs.filter((_, j) => j !== i))}
            className="text-xs text-cafe-muted transition-colors hover:text-red-400"
            title="删除"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...pairs, { key: '', value: '' }])}
        className="w-full rounded-lg bg-[var(--console-card-soft-bg)] py-2 text-xs text-cafe-secondary transition-colors hover:text-cafe"
      >
        + 添加{addLabel}
      </button>
    </div>
  );
}
