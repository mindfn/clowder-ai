'use client';

import type {
  SegmentCycleSummary,
  SegmentEvaluationResponse,
  SegmentLifecycleResponse,
  SegmentTracingEvaluationView,
  VersionEpoch,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '@/utils/api-client';
import { activeStageForCycle, activeVersionAt, LifelineChainView, type SelectedStage } from './LifelineChainView';
import { ObjectiveEvaluationPanel } from './ObjectiveEvaluationPanel';
import { ObjectiveGovernancePanel } from './ObjectiveGovernancePanel';
import { SettingsBadge, SettingsText } from './primitives';
import { SegmentTraceTheater } from './SegmentTraceTheater';

interface SegmentLifelineModalProps {
  segmentId: string;
  segmentName: string;
  onClose: () => void;
}

export function SegmentLifelineModal({ segmentId, segmentName, onClose }: SegmentLifelineModalProps) {
  const [loading, setLoading] = useState(true);
  const [lifeline, setLifeline] = useState<SegmentLifecycleResponse | null>(null);
  const [selected, setSelected] = useState<SelectedStage | null>(null);
  const [evaluation, setEvaluation] = useState<SegmentEvaluationResponse | null>(null);
  const [cycles, setCycles] = useState<SegmentCycleSummary[]>([]);
  const [currentCycleId, setCurrentCycleId] = useState<string | null>(null);
  const [evaluationLoading, setEvaluationLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evaluationError, setEvaluationError] = useState<string | null>(null);
  const lifelineRequestRef = useRef(0);
  const evaluationRequestRef = useRef(0);
  const selectionInitializedRef = useRef(false);

  const invalidateRequests = useCallback(() => {
    lifelineRequestRef.current++;
    evaluationRequestRef.current++;
  }, []);

  const fetchLifeline = useCallback(async () => {
    const requestId = ++lifelineRequestRef.current;
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/segment-lifeline/${encodeURIComponent(segmentId)}`);
      if (requestId !== lifelineRequestRef.current) return;
      if (!response.ok) {
        setError('版本生命线加载失败');
        return;
      }
      const next = (await response.json()) as SegmentLifecycleResponse;
      setLifeline(next);
      setCycles([]);
      setCurrentCycleId(null);
      selectionInitializedRef.current = false;
      setSelected({ version: next.activeVersion, stage: 'tracing' });
    } catch {
      if (requestId === lifelineRequestRef.current) setError('网络错误');
    } finally {
      if (requestId === lifelineRequestRef.current) setLoading(false);
    }
  }, [segmentId]);

  useEffect(() => {
    fetchLifeline();
    return invalidateRequests;
  }, [fetchLifeline, invalidateRequests]);

  const selectedEpoch = useMemo(
    () => lifeline?.chain.find((epoch) => epoch.version === selected?.version) ?? null,
    [lifeline, selected?.version],
  );
  const selectedCycle = useMemo(
    () => cycles.find((cycle) => cycle.cycleId === selected?.cycleId) ?? null,
    [cycles, selected?.cycleId],
  );
  const selectedWindow = useMemo(() => {
    if (!lifeline) return null;
    if (selectedCycle) {
      const endMs = selectedCycle.cycleEnd ?? lifeline.window.endMs;
      return endMs > selectedCycle.cycleStart ? { startMs: selectedCycle.cycleStart, endMs } : null;
    }
    return selectedEpoch ? epochWindow(lifeline, selectedEpoch) : null;
  }, [lifeline, selectedCycle, selectedEpoch]);
  const evaluationQuery = selected?.cycleId
    ? new URLSearchParams({ cycleId: selected.cycleId }).toString()
    : selectedWindow
      ? new URLSearchParams({
          startMs: String(selectedWindow.startMs),
          endMs: String(selectedWindow.endMs),
        }).toString()
      : null;
  const selectedVersion = selected?.version ?? 1;

  const handleSelect = useCallback(
    (next: SelectedStage) => {
      selectionInitializedRef.current = true;
      const coordinateChanged = selected?.cycleId !== next.cycleId || selected?.version !== next.version;
      if (coordinateChanged) {
        evaluationRequestRef.current++;
        setEvaluation(null);
        setEvaluationError(null);
      }
      setSelected(next);
    },
    [selected?.cycleId, selected?.version],
  );

  useEffect(() => {
    if (!evaluationQuery) {
      setEvaluation(null);
      setEvaluationError(null);
      setEvaluationLoading(false);
      evaluationRequestRef.current++;
      return;
    }
    const requestId = ++evaluationRequestRef.current;
    setEvaluation(null);
    setEvaluationError(null);
    setEvaluationLoading(true);
    void apiFetch(`/api/segment-evaluation/${encodeURIComponent(segmentId)}?${evaluationQuery}`)
      .then(async (response) => {
        if (requestId !== evaluationRequestRef.current) return;
        if (!response.ok) {
          setEvaluationError('该版本的评估数据加载失败');
          return;
        }
        const next = (await response.json()) as SegmentEvaluationResponse;
        const objective = next.objectives[0];
        if (objective) {
          setCycles(objective.versionChain);
          setCurrentCycleId(objective.currentCycle?.cycleId ?? null);
          if (!selectionInitializedRef.current) {
            const defaultCycle = objective.currentCycle ?? objective.versionChain.at(-1) ?? null;
            selectionInitializedRef.current = true;
            if (defaultCycle) {
              const defaultVersion = activeVersionAt(
                lifeline?.versionActivations ?? [],
                defaultCycle.cycleStart,
                lifeline?.chain[0]?.version ?? lifeline?.activeVersion ?? selectedVersion,
              );
              setSelected({
                version: defaultVersion ?? lifeline?.activeVersion ?? selectedVersion,
                stage: activeStageForCycle(defaultCycle),
                cycleId: defaultCycle.cycleId,
              });
            }
          }
        }
        setEvaluation(next);
      })
      .catch(() => {
        if (requestId === evaluationRequestRef.current) setEvaluationError('网络错误');
      })
      .finally(() => {
        if (requestId === evaluationRequestRef.current) setEvaluationLoading(false);
      });
  }, [evaluationQuery, lifeline, segmentId, selectedVersion]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const versionObservations = useMemo(
    () =>
      lifeline?.observations.filter(
        (observation) => observation.version === selected?.version || observation.version == null,
      ) ?? [],
    [lifeline, selected?.version],
  );
  const cycleObservations = evaluation?.tracing.injections ?? versionObservations;
  const cycleObservationsCapped = evaluation?.tracing.injectionsCapped ?? lifeline?.observationsCapped;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm">
      <button type="button" aria-label="关闭" className="absolute inset-0" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="segment-lifeline-title"
        className="relative flex max-h-[calc(100vh-32px)] w-full max-w-[1040px] flex-col overflow-hidden rounded-2xl bg-[var(--console-card-bg)] p-[26px] shadow-[0_20px_48px_rgba(43,33,26,0.14)]"
      >
        <header className="flex shrink-0 items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--console-active-bg)] text-lg">
            📊
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="segment-lifeline-title" className="flex items-center gap-2 text-xl font-bold text-cafe">
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

        <main className="mt-5 min-h-0 flex-1 space-y-4 overflow-y-auto">
          {loading && (
            <SettingsText as="p" variant="xs" tone="muted">
              加载版本生命线…
            </SettingsText>
          )}
          {error && (
            <SettingsText as="p" variant="xs" tone="red">
              {error}
            </SettingsText>
          )}
          {!loading && !error && lifeline && (
            <>
              <LifelineChainView
                chain={lifeline.chain}
                cycles={cycles}
                versionActivations={lifeline.versionActivations}
                currentCycleId={currentCycleId}
                selected={selected}
                onSelect={handleSelect}
              />
              {selectedEpoch && selected?.stage === 'version' && (
                <VersionContentPreview segmentId={segmentId} epoch={selectedEpoch} />
              )}
              {selectedEpoch && selected?.stage === 'tracing' && (
                <SegmentTraceTheater
                  segmentId={segmentId}
                  observations={cycleObservations}
                  window={selectedWindow}
                  readiness={evaluation?.tracing ?? null}
                  loading={evaluationLoading}
                  error={evaluationError}
                  capped={cycleObservationsCapped}
                />
              )}
              {selectedEpoch && selected?.stage === 'eval' && (
                <>
                  {!selectedWindow && (
                    <SettingsText as="p" variant="xs" tone="muted">
                      当前生命线查询窗口尚未覆盖 v{selectedEpoch.version} 的有效评估区间。
                    </SettingsText>
                  )}
                  {evaluationLoading && (
                    <SettingsText as="p" variant="xs" tone="muted">
                      加载 v{selectedEpoch.version} 评估指标…
                    </SettingsText>
                  )}
                  {evaluationError && (
                    <SettingsText as="p" variant="xs" tone="red">
                      {evaluationError}
                    </SettingsText>
                  )}
                  {!evaluationLoading && !evaluationError && evaluation && (
                    <ObjectiveEvaluationPanel data={evaluation} />
                  )}
                </>
              )}
              {selectedEpoch && selected?.stage === 'governance' && (
                <>
                  {evaluationLoading && (
                    <SettingsText as="p" variant="xs" tone="muted">
                      加载治理周期…
                    </SettingsText>
                  )}
                  {evaluationError && (
                    <SettingsText as="p" variant="xs" tone="red">
                      {evaluationError}
                    </SettingsText>
                  )}
                  {!evaluationLoading && !evaluationError && evaluation && (
                    <ObjectiveGovernancePanel data={evaluation} />
                  )}
                </>
              )}
            </>
          )}
        </main>
      </div>
    </div>,
    document.body,
  );
}

export function observationsForObjectiveCycle(
  observations: SegmentLifecycleResponse['observations'],
  objective: SegmentTracingEvaluationView['trigger']['objective'],
  openCycleEndMs: number,
): SegmentLifecycleResponse['observations'] {
  const end = objective.cycleEndMs ?? openCycleEndMs;
  return observations.filter(
    (observation) => observation.timestamp >= objective.cycleStartMs && observation.timestamp < end,
  );
}

function epochWindow(
  lifeline: SegmentLifecycleResponse,
  epoch: VersionEpoch,
): { startMs: number; endMs: number } | null {
  const nextEpoch = lifeline.chain.find((candidate) => candidate.startedAt > epoch.startedAt);
  const startMs = Math.max(epoch.startedAt, lifeline.window.startMs);
  const endMs = Math.min(nextEpoch?.startedAt ?? lifeline.window.endMs, lifeline.window.endMs);
  return endMs > startMs ? { startMs, endMs } : null;
}

interface SegmentContentResponse {
  baseContent: string;
}

interface VersionContentResponse {
  content: string;
}

export function VersionContentPreview({ segmentId, epoch }: { segmentId: string; epoch: VersionEpoch }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    setContent(null);
    const manifestVersion = epoch.origin === 'manifest';
    const path = manifestVersion
      ? `/api/prompt-injection/segment/${encodeURIComponent(segmentId)}/content`
      : `/api/prompt-hooks/${encodeURIComponent(segmentId)}/versions/${epoch.version}/content`;

    void apiFetch(path)
      .then(async (response) => {
        if (!current) return;
        if (!response.ok) {
          setError('版本内容加载失败');
          return;
        }
        const payload = (await response.json()) as SegmentContentResponse | VersionContentResponse;
        setContent(
          manifestVersion
            ? (payload as SegmentContentResponse).baseContent
            : (payload as VersionContentResponse).content,
        );
      })
      .catch(() => {
        if (current) setError('网络错误');
      })
      .finally(() => {
        if (current) setLoading(false);
      });

    return () => {
      current = false;
    };
  }, [segmentId, epoch.origin, epoch.version]);

  return (
    <section className="rounded-2xl bg-[var(--console-panel-bg)] p-4">
      <div className="flex items-center justify-between gap-3">
        <SettingsText as="h3" variant="sm" tone="default" className="font-semibold">
          v{epoch.version} 版本内容
        </SettingsText>
        <SettingsText as="span" variant="xs" tone="muted">
          {epoch.isActive ? '当前启用版本' : '历史版本'}
        </SettingsText>
      </div>
      {loading && (
        <SettingsText as="p" variant="xs" tone="muted" className="mt-3">
          加载版本内容…
        </SettingsText>
      )}
      {error && (
        <SettingsText as="p" variant="xs" tone="red" className="mt-3">
          {error}
        </SettingsText>
      )}
      {!loading && !error && (
        <pre className="mt-3 max-h-[440px] overflow-auto whitespace-pre-wrap rounded-xl bg-[var(--console-card-bg)] p-4 font-mono text-xs leading-6 text-cafe-secondary">
          {content || '该版本没有可预览内容'}
        </pre>
      )}
    </section>
  );
}
