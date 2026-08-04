'use client';

import type { SegmentEvaluationResponse } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '@/utils/api-client';
import { ObjectiveEvaluationPanel } from './ObjectiveEvaluationPanel';
import { SettingsBadge, SettingsText } from './primitives';
import { SegmentTraceTheater, type TraceTheaterObservation } from './SegmentTraceTheater';

interface LifelineResponse {
  segmentId: string;
  segmentName: string;
  activeVersion: number;
  window: { startMs: number; endMs: number };
  observations: TraceTheaterObservation[];
  observationsCapped?: boolean;
}

interface SegmentLifelineModalProps {
  segmentId: string;
  segmentName: string;
  onClose: () => void;
}

type View = 'metrics' | 'tracing';

export function SegmentLifelineModal({ segmentId, segmentName, onClose }: SegmentLifelineModalProps) {
  const [loading, setLoading] = useState(true);
  const [lifeline, setLifeline] = useState<LifelineResponse | null>(null);
  const [evaluation, setEvaluation] = useState<SegmentEvaluationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('metrics');
  const requestRef = useRef(0);

  const fetchData = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const [lifelineResponse, evaluationResponse] = await Promise.all([
        apiFetch(`/api/segment-lifeline/${encodeURIComponent(segmentId)}`),
        apiFetch(`/api/segment-evaluation/${encodeURIComponent(segmentId)}`),
      ]);
      if (requestId !== requestRef.current) return;
      if (!lifelineResponse.ok || !evaluationResponse.ok) {
        setError('段评估数据加载失败');
        return;
      }
      setLifeline((await lifelineResponse.json()) as LifelineResponse);
      setEvaluation((await evaluationResponse.json()) as SegmentEvaluationResponse);
    } catch {
      if (requestId === requestRef.current) setError('网络错误');
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [segmentId]);

  useEffect(() => {
    fetchData();
    return () => {
      requestRef.current++;
    };
  }, [fetchData]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm">
      <button type="button" aria-label="关闭" className="absolute inset-0" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="segment-evaluation-title"
        className="relative flex max-h-[calc(100vh-32px)] w-full max-w-[1040px] flex-col overflow-hidden rounded-2xl bg-[var(--console-card-bg)] p-[26px] shadow-[0_20px_48px_rgba(43,33,26,0.14)]"
      >
        <header className="flex shrink-0 items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--console-active-bg)] text-lg">
            📊
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="segment-evaluation-title" className="flex items-center gap-2 text-xl font-bold text-cafe">
              <span className="font-mono text-base text-cafe-muted">{segmentId}</span>
              {lifeline?.segmentName ?? segmentName}
            </h2>
            <div className="mt-1 flex items-center gap-2">
              {lifeline && (
                <SettingsBadge tone="blue" size="xxs">
                  v{lifeline.activeVersion}
                </SettingsBadge>
              )}
              <SettingsBadge tone="emerald" size="xxs">
                持续采集
              </SettingsBadge>
              <SettingsText as="span" variant="xs" tone="muted">
                评估不阻塞当前版本，也不会自动禁用
              </SettingsText>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="h-8 w-8 rounded-xl text-cafe-muted hover:bg-[var(--console-modal-close-bg)]"
          >
            ✕
          </button>
        </header>

        <nav className="mt-4 flex gap-2" aria-label="段评估视图">
          <ViewButton active={view === 'metrics'} onClick={() => setView('metrics')}>
            评估指标
          </ViewButton>
          <ViewButton active={view === 'tracing'} onClick={() => setView('tracing')}>
            Tracing 回放
          </ViewButton>
        </nav>

        <main className="mt-4 min-h-0 flex-1 overflow-y-auto">
          {loading && (
            <SettingsText as="p" variant="xs" tone="muted">
              加载中…
            </SettingsText>
          )}
          {error && (
            <SettingsText as="p" variant="xs" tone="red">
              {error}
            </SettingsText>
          )}
          {!loading && !error && view === 'metrics' && evaluation && <ObjectiveEvaluationPanel data={evaluation} />}
          {!loading && !error && view === 'tracing' && lifeline && (
            <SegmentTraceTheater
              segmentId={segmentId}
              observations={lifeline.observations}
              capped={lifeline.observationsCapped}
            />
          )}
        </main>
      </div>
    </div>,
    document.body,
  );
}

function ViewButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium ${active ? 'bg-[var(--console-active-bg)] text-cafe' : 'bg-[var(--console-panel-bg)] text-cafe-muted'}`}
    >
      {children}
    </button>
  );
}
