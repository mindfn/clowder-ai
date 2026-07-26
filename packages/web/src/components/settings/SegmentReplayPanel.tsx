'use client';

/**
 * F257 Console 判据④ — True-scene replay modal for a segment observation.
 *
 * Loads `/api/segment-lifeline/:segmentId/replay` and displays event-time
 * content, source provenance, variable bindings, guard events, and captured
 * conversation context in a theater-style overlay. Provenance gaps are
 * rendered explicitly (legacy-missing / invalid-present / unavailable).
 */

import type { SegmentReplayResponse } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '@/utils/api-client';
import { SettingsBadge, SettingsText } from './primitives';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ReplayPanelProps {
  segmentId: string;
  threadId: string;
  turnId: string;
  timestamp: number;
  catId: string;
  pipelineStatus: string;
  /** Controlled open state. */
  isOpen: boolean;
  /** Close callback (Escape, backdrop click, close button). */
  onClose: () => void;
}

const GAP_LABEL: Record<string, string> = {
  'legacy-missing': '旧数据缺失',
  'invalid-present': '字段损坏',
  unavailable: '不可获取',
};

const SOURCE_KIND_LABEL: Record<string, string> = {
  template: '模板渲染',
  override: '内容覆盖',
  'content-var': '变量直传',
  'file-fallback': '文件回退',
  'native-l0': '原生 L0',
  aggregate: '聚合段',
};

const formatTs = (ms: number) => new Date(ms).toLocaleString();

export function SegmentReplayPanel({
  segmentId,
  threadId,
  turnId,
  timestamp,
  catId,
  pipelineStatus,
  isOpen,
  onClose,
}: ReplayPanelProps) {
  const [data, setData] = useState<SegmentReplayResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  const fetchReplay = useCallback(async () => {
    const id = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ threadId, turnId });
      const res = await apiFetch(`/api/segment-lifeline/${encodeURIComponent(segmentId)}/replay?${query}`);
      if (id !== reqRef.current) return;
      if (!res.ok) {
        setError('回放加载失败');
        return;
      }
      setData((await res.json()) as SegmentReplayResponse);
    } catch {
      if (id === reqRef.current) setError('网络错误');
    } finally {
      if (id === reqRef.current) setLoading(false);
    }
  }, [segmentId, threadId, turnId]);

  useEffect(() => {
    if (!isOpen) {
      setData(null);
      setError(null);
      return;
    }
    fetchReplay();
    return () => {
      reqRef.current++;
    };
  }, [isOpen, fetchReplay]);

  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const previouslyHidden = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previouslyHidden;
    };
  }, [isOpen]);

  if (!isOpen || typeof document === 'undefined') return null;

  return createPortal(
    <ReplayOverlay onClose={onClose}>
      <ReplayPanelBody
        catId={catId}
        pipelineStatus={pipelineStatus}
        timestamp={timestamp}
        turnId={turnId}
        data={data}
        loading={loading}
        error={error}
        onClose={onClose}
      />
    </ReplayOverlay>,
    document.body,
  );
}

function ReplayOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[110] flex items-start justify-center p-4 sm:items-center">
      <button
        type="button"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        data-testid="replay-backdrop"
        aria-label="关闭回放"
      />
      <div className="relative w-full max-w-2xl">{children}</div>
    </div>
  );
}

interface ReplayPanelBodyProps {
  catId: string;
  pipelineStatus: string;
  timestamp: number;
  turnId: string;
  data: SegmentReplayResponse | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}

function ReplayPanelBody({
  catId,
  pipelineStatus,
  timestamp,
  turnId,
  data,
  loading,
  error,
  onClose,
}: ReplayPanelBodyProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const first = focusable[0] ?? panel;
    first.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      const elements = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []).filter(
        (el) => el.offsetParent !== null,
      );
      if (elements.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = elements[0];
      const lastEl = elements[elements.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }

    panel.addEventListener('keydown', onKeyDown);
    return () => panel.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="flex max-h-[90vh] w-full flex-col overflow-hidden rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-panel-bg)] shadow-2xl outline-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby="replay-title"
    >
      <div className="flex items-center justify-between border-b border-[var(--console-border-soft)] px-4 py-3">
        <div className="flex items-center gap-2">
          <SettingsText as="h3" id="replay-title" variant="sm" tone="default" className="font-semibold">
            回放现场
          </SettingsText>
          <SettingsBadge tone={pipelineStatus === 'fired' ? 'emerald' : 'slate'} size="xxs">
            {pipelineStatus}
          </SettingsBadge>
          <span className="text-micro text-cafe-muted">@{catId}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1 text-cafe-muted hover:bg-[var(--console-elevated-bg)] hover:text-cafe"
          aria-label="关闭回放"
          data-testid="replay-close"
        >
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-xs">
        <div className="flex items-center gap-2 text-cafe-muted">
          <span>{formatTs(timestamp)}</span>
          <span className="font-mono">{turnId}</span>
        </div>

        {loading && (
          <SettingsText as="p" variant="xs" tone="muted">
            加载回放…
          </SettingsText>
        )}

        {!loading && (error || !data) && (
          <SettingsText as="p" variant="xs" tone="red">
            {error ?? '回放数据为空'}
          </SettingsText>
        )}

        {data && <ReplayDataSections data={data} />}
      </div>
    </div>
  );
}

function ReplayDataSections({ data }: { data: SegmentReplayResponse }) {
  return (
    <>
      <ReplayField label="现场内容" gap={data.contentGap}>
        {data.content != null ? (
          <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--console-card-bg)] p-2 font-mono text-cafe">
            {data.content}
          </pre>
        ) : null}
      </ReplayField>

      <ReplayField label="内容来源" gap={data.contentSourceKindGap}>
        {data.contentSourceKind != null ? (
          <span className="font-mono text-cafe-secondary">
            {SOURCE_KIND_LABEL[data.contentSourceKind] ?? data.contentSourceKind}
          </span>
        ) : null}
      </ReplayField>

      <ReplayField label="模板来源" gap={data.templateRefGap}>
        {data.templateRef != null ? <span className="font-mono text-cafe-secondary">{data.templateRef}</span> : null}
      </ReplayField>

      <ReplayField label="版本" gap={data.versionGap}>
        {data.version != null ? <span className="text-cafe-secondary">v{data.version}</span> : null}
      </ReplayField>

      <ReplayField label="变量绑定" gap={data.templateVarsGap}>
        {data.templateVars != null ? <TemplateVars vars={data.templateVars} /> : null}
      </ReplayField>

      <ReplayField label="上下文锚点" gap={data.messageAnchorIdGap}>
        {data.messageAnchorId != null ? (
          <span className="font-mono text-cafe-secondary">{data.messageAnchorId}</span>
        ) : null}
      </ReplayField>

      <ReplayField label="守卫事件" gap={data.guardEventsGap}>
        <GuardEvents events={data.guardEvents} />
      </ReplayField>

      <ReplayField label="上下文消息" gap={data.surroundingMessagesGap}>
        {data.surroundingMessages != null ? <SurroundingMessages messages={data.surroundingMessages} /> : null}
      </ReplayField>
    </>
  );
}

function TemplateVars({ vars }: { vars: Record<string, string> }) {
  return (
    <div className="space-y-1">
      {Object.entries(vars).map(([key, value]) => (
        <div key={key} className="grid grid-cols-[120px_1fr] gap-2">
          <span className="truncate font-mono text-cafe-muted">{key}</span>
          <span className="truncate font-mono text-cafe-secondary">{value}</span>
        </div>
      ))}
    </div>
  );
}

function GuardEvents({ events }: { events: SegmentReplayResponse['guardEvents'] }) {
  if (events.length === 0) {
    return (
      <SettingsText as="p" variant="xs" tone="muted" className="italic">
        该时段无相关 guard 事件
      </SettingsText>
    );
  }
  return (
    <div className="space-y-1">
      {events.map((ev) => (
        <div key={ev.eventId} className="flex items-center gap-2 rounded-lg bg-[var(--console-card-bg)] px-2 py-1">
          <SettingsBadge tone="amber" size="xxs">
            {ev.kind}
          </SettingsBadge>
          <span className="font-mono text-cafe-secondary">{ev.guardId}</span>
          <span className="ml-auto text-cafe-muted">{formatTs(ev.timestamp)}</span>
        </div>
      ))}
    </div>
  );
}

function SurroundingMessages({ messages }: { messages: NonNullable<SegmentReplayResponse['surroundingMessages']> }) {
  return (
    <div className="max-h-[240px] space-y-1 overflow-auto">
      {messages.map((msg) => (
        <div key={msg.messageId} className="rounded-lg bg-[var(--console-card-bg)] px-2 py-1.5">
          <div className="mb-0.5 flex items-center gap-2">
            <SettingsBadge tone={msg.role === 'user' ? 'blue' : msg.role === 'system' ? 'amber' : 'slate'} size="xxs">
              {msg.role}
            </SettingsBadge>
            {msg.catId && <span className="text-cafe-muted">@{msg.catId}</span>}
            <span className="ml-auto text-cafe-muted">{formatTs(msg.timestamp)}</span>
          </div>
          <div className="pl-1 text-cafe-secondary">{msg.contentPreview}</div>
        </div>
      ))}
    </div>
  );
}

function ReplayField({ label, gap, children }: { label: string; gap: string | null; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <SettingsText as="h4" variant="xs" tone="muted" className="font-semibold">
          {label}
        </SettingsText>
        {gap && (
          <SettingsBadge tone="amber" size="xxs">
            {GAP_LABEL[gap] ?? gap}
          </SettingsBadge>
        )}
      </div>
      {children}
    </div>
  );
}
