'use client';

/**
 * F257 Phase D — Segment lifeline modal.
 *
 * Portal-based drilldown showing a segment's evaluation lifecycle status:
 *   current version → tracing status → collected event timeline.
 *
 * Follows the SegmentEditorModal pattern (createPortal, z-100, backdrop blur).
 * Data from GET /api/segment-lifeline/:segmentId.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '@/utils/api-client';
import { SettingsBadge, SettingsText } from './primitives';

// ── Types ──────────────────────────────────────────────────────

interface SegmentObservation {
  threadId: string;
  turnId: string;
  timestamp: number;
  catId: string;
  pipelineStatus: string;
  version: number | null;
  charCount: number;
}

interface GuardEvent {
  eventId: string;
  kind: string;
  threadId: string;
  catId: string;
  timestamp: number;
  guardId: string;
  attribution?: 'window-correlated';
}

interface OverrideEvent {
  eventId: string;
  hookId: string;
  action: string;
  source: string;
  timestamp: number;
  actorId: string;
  reason: string;
}

interface LifelineResponse {
  segmentId: string;
  status: 'idle' | 'tracing' | 'evaluated';
  currentVersion: number | null;
  window: { startMs: number; endMs: number };
  observations: SegmentObservation[];
  guardEvents: GuardEvent[];
  overrideState: { hookId: string; enabled: boolean } | null;
  overrideHistory: OverrideEvent[];
}

// ── Helpers ────────────────────────────────────────────────────

function formatTs(ms: number): string {
  return new Date(ms).toLocaleString();
}

const STATUS_BADGE: Record<string, { label: string; tone: 'emerald' | 'amber' | 'slate' }> = {
  tracing: { label: 'tracing 中', tone: 'emerald' },
  idle: { label: '无数据', tone: 'slate' },
  evaluated: { label: '已评估', tone: 'amber' },
};

// ── Component ──────────────────────────────────────────────────

interface SegmentLifelineModalProps {
  segmentId: string;
  segmentName: string;
  onClose: () => void;
}

export function SegmentLifelineModal({ segmentId, segmentName, onClose }: SegmentLifelineModalProps) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<LifelineResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  const fetchData = useCallback(async () => {
    const id = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/segment-lifeline/${encodeURIComponent(segmentId)}`);
      if (id !== reqRef.current) return;
      if (!res.ok) {
        setError('生命线数据加载失败');
        return;
      }
      setData((await res.json()) as LifelineResponse);
    } catch {
      if (id === reqRef.current) setError('网络错误');
    } finally {
      if (id === reqRef.current) setLoading(false);
    }
  }, [segmentId]);

  useEffect(() => {
    fetchData();
    return () => {
      reqRef.current++;
    };
  }, [fetchData]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleBackdrop = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const badge = data ? STATUS_BADGE[data.status] : null;
  const versionLabel = data?.currentVersion != null ? `v${data.currentVersion}` : '';

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm"
      onClick={handleBackdrop}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is supplementary */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="segment-lifeline-title"
        className="relative flex max-h-[calc(100vh-32px)] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl bg-[var(--console-card-bg)] p-[26px] shadow-[0_20px_48px_rgba(43,33,26,0.14)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center gap-[14px]">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--console-active-bg)] text-lg font-bold text-[var(--console-modal-title)]">
            📊
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="segment-lifeline-title" className="flex items-center gap-2 text-xl font-bold text-cafe">
              <span className="font-mono text-base text-cafe-muted">{segmentId}</span>
              {segmentName}
            </h2>
            {badge && (
              <div className="mt-1 flex items-center gap-2">
                {versionLabel && (
                  <SettingsBadge tone="blue" size="xxs">
                    {versionLabel}
                  </SettingsBadge>
                )}
                <span className="text-xs text-cafe-muted">→</span>
                <SettingsBadge tone={badge.tone} size="xxs">
                  {badge.label}
                </SettingsBadge>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-base text-cafe-muted transition hover:bg-[var(--console-modal-close-bg)] hover:text-[var(--console-modal-close-fg)]"
          >
            ✕
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto">
          {loading && (
            <SettingsText as="p" variant="xs" tone="muted">
              加载中...
            </SettingsText>
          )}
          {error && (
            <SettingsText as="p" variant="xs" tone="red">
              {error}
            </SettingsText>
          )}

          {data && (
            <>
              <LifelineSection title={`注入追踪 (${data.observations.length})`}>
                {data.observations.length === 0 ? (
                  <SettingsText as="p" variant="xs" tone="muted" className="italic">
                    窗口内无观测数据
                  </SettingsText>
                ) : (
                  <div className="space-y-1">
                    {data.observations.map((obs) => (
                      <ObservationRow key={`${obs.threadId}-${obs.turnId}`} obs={obs} />
                    ))}
                  </div>
                )}
              </LifelineSection>

              {data.guardEvents.length > 0 && (
                <LifelineSection title={`窗口关联守卫事件 (${data.guardEvents.length})`}>
                  <SettingsText as="p" variant="xs" tone="muted" className="mb-2">
                    按 threadId + catId + ±120s 窗口匹配，非因果归因
                  </SettingsText>
                  <div className="space-y-1">
                    {data.guardEvents.map((ev) => (
                      <GuardEventRow key={ev.eventId} event={ev} />
                    ))}
                  </div>
                </LifelineSection>
              )}

              {(data.overrideState || data.overrideHistory.length > 0) && (
                <LifelineSection title="治理记录">
                  {data.overrideState && (
                    <div className="mb-2 flex items-center gap-2">
                      <SettingsText as="span" variant="xs" tone="muted">
                        当前状态：
                      </SettingsText>
                      <SettingsBadge tone={data.overrideState.enabled ? 'emerald' : 'red'} size="xxs">
                        {data.overrideState.enabled ? '已启用' : '已禁用'}
                      </SettingsBadge>
                    </div>
                  )}
                  {data.overrideHistory.map((ev) => (
                    <OverrideEventRow key={ev.eventId} event={ev} />
                  ))}
                </LifelineSection>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Sub-components ─────────────────────────────────────────────

function LifelineSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-4" style={{ backgroundColor: 'var(--console-panel-bg)' }}>
      <SettingsText as="h3" variant="sm" tone="default" className="mb-2 font-semibold">
        {title}
      </SettingsText>
      {children}
    </div>
  );
}

function ObservationRow({ obs }: { obs: SegmentObservation }) {
  return (
    <div
      className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-xs hover:brightness-95"
      style={{ backgroundColor: 'var(--console-elevated-bg)' }}
    >
      <span className="w-[140px] shrink-0 font-mono text-cafe-muted">{formatTs(obs.timestamp)}</span>
      <SettingsBadge tone={obs.pipelineStatus === 'fired' ? 'emerald' : 'slate'} size="xxs">
        {obs.pipelineStatus}
      </SettingsBadge>
      <span className="text-cafe-secondary">@{obs.catId}</span>
      <span className="ml-auto text-cafe-muted">{obs.charCount} chars</span>
    </div>
  );
}

function GuardEventRow({ event }: { event: GuardEvent }) {
  return (
    <div
      className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-xs hover:brightness-95"
      style={{ backgroundColor: 'var(--console-elevated-bg)' }}
    >
      <span className="w-[140px] shrink-0 font-mono text-cafe-muted">{formatTs(event.timestamp)}</span>
      <SettingsBadge tone="red" size="xxs">
        {event.kind}
      </SettingsBadge>
      <span className="text-cafe-secondary">@{event.catId}</span>
      <span className="ml-auto font-mono text-cafe-muted">{event.guardId}</span>
    </div>
  );
}

function OverrideEventRow({ event }: { event: OverrideEvent }) {
  return (
    <div
      className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-xs hover:brightness-95"
      style={{ backgroundColor: 'var(--console-elevated-bg)' }}
    >
      <span className="w-[140px] shrink-0 font-mono text-cafe-muted">{formatTs(event.timestamp)}</span>
      <SettingsBadge tone="amber" size="xxs">
        {event.action}
      </SettingsBadge>
      <span className="text-cafe-secondary">{event.source}</span>
      {event.reason && (
        <span className="ml-auto truncate text-cafe-muted" title={event.reason}>
          {event.reason}
        </span>
      )}
    </div>
  );
}
