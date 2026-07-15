'use client';

/**
 * F257 Phase D — Segment lifeline modal (enhanced).
 *
 * Portal-based drilldown showing a segment's version lifecycle chain:
 *   v1 → tracing → eval → governance → v2 → ...
 *
 * Data from GET /api/segment-lifeline/:segmentId (chain response).
 * Wider view (960px) to accommodate the horizontal chain visualization.
 */

import type { GuardMetric } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '@/utils/api-client';
import { LifelineChainView, type SelectedStage } from './LifelineChainView';
import { LifelineStageDetail } from './LifelineStageDetail';
import { SettingsBadge, SettingsText } from './primitives';

// ── Types (matching enhanced API response) ────────────────────

interface VersionEpoch {
  version: number;
  origin: string;
  startedAt: number;
  status: string;
  isActive: boolean;
  tracing: { observationCount: number; firstAt: number | null; lastAt: number | null } | null;
  eval: { verdict: string | null; injectionCount: number; violationCount: number; evaluatedAt: number | null } | null;
  governance: { decision: string | null; decidedAt: number | null; actorId: string | null } | null;
  events: Array<{ eventId: string; kind: string; timestamp: number; actorId: string; detail: string }>;
}

interface Observation {
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
}

interface LifelineResponse {
  segmentId: string;
  segmentName: string;
  activeVersion: number;
  chain: VersionEpoch[];
  currentStatus: 'idle' | 'tracing' | 'evaluated';
  window: { startMs: number; endMs: number };
  observations: Observation[];
  guardEvents: GuardEvent[];
  overrideState: { hookId: string; enabled: boolean } | null;
  epochGuardMetrics: Record<number, GuardMetric[]>;
}

// ── Status badge map ──────────────────────────────────────────

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
  const [selected, setSelected] = useState<SelectedStage | null>(null);
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
      const responseData = (await res.json()) as LifelineResponse;
      setData(responseData);
      // Auto-select the active version's tracing stage
      if (responseData.chain.length > 0) {
        const active = responseData.chain.find((e) => e.isActive) ?? responseData.chain[responseData.chain.length - 1];
        setSelected({ version: active.version, stage: 'tracing' });
      }
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

  const badge = data ? STATUS_BADGE[data.currentStatus] : null;

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
        className="relative flex max-h-[calc(100vh-32px)] w-full max-w-[960px] flex-col overflow-hidden rounded-2xl bg-[var(--console-card-bg)] p-[26px] shadow-[0_20px_48px_rgba(43,33,26,0.14)]"
        onClick={(e) => e.stopPropagation()}
      >
        <LifelineHeader
          segmentId={segmentId}
          segmentName={data?.segmentName ?? segmentName}
          activeVersion={data?.activeVersion ?? null}
          badge={badge}
          onClose={onClose}
        />

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
              <LifelineChainView chain={data.chain} selected={selected} onSelect={setSelected} />
              {selected && (
                <LifelineStageDetail
                  selected={selected}
                  chain={data.chain}
                  observations={data.observations}
                  guardEvents={data.guardEvents}
                  epochGuardMetrics={data.epochGuardMetrics}
                  overrideState={data.overrideState}
                  hookId={segmentId}
                  onRefresh={fetchData}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Header ────────────────────────────────────────────────────

function LifelineHeader({
  segmentId,
  segmentName,
  activeVersion,
  badge,
  onClose,
}: {
  segmentId: string;
  segmentName: string;
  activeVersion: number | null;
  badge: { label: string; tone: 'emerald' | 'amber' | 'slate' } | null;
  onClose: () => void;
}) {
  return (
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
            {activeVersion != null && (
              <SettingsBadge tone="blue" size="xxs">
                v{activeVersion}
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
  );
}
