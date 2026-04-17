'use client';

import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import type { BootcampState, GuideStep } from './guideOverlayTypes';
import {
  findGuideTarget,
  GUIDE_STEP_CONFIG,
  hasAnyGuideTarget,
  hostSelector,
  matchesGuideTarget,
  PREVIOUS_GUIDE_STEP,
  targetSelector,
} from './guideStepConfig';
import { syncLocalBootcampState } from './syncLocalBootcampState';

interface AddTeammateGuideProps {
  guideStep: GuideStep;
  threadId?: string;
  bootcampState?: BootcampState | null;
}

export function AddTeammateGuide({ guideStep, threadId, bootcampState }: AddTeammateGuideProps) {
  const config = GUIDE_STEP_CONFIG[guideStep];
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const rafRef = useRef<number>(0);
  const pendingAdvanceKeyRef = useRef<string | null>(null);
  const autoAdvanceKeyRef = useRef<string | null>(null);
  const recoverStepKeyRef = useRef<string | null>(null);
  const elevatedSelectors = [...config.targets.map(targetSelector), ...(config.hosts ?? []).map(hostSelector)].join(
    ', ',
  );

  const syncGuideStep = useCallback(
    (nextStep: GuideStep, opts?: { rollbackOnFailure?: boolean }) => {
      if (!threadId || !bootcampState) return;
      const advanceKey = `${threadId}:${String(bootcampState.startedAt ?? 'unknown')}:${guideStep}->${nextStep}`;
      if (pendingAdvanceKeyRef.current === advanceKey) return;
      pendingAdvanceKeyRef.current = advanceKey;

      const previousBootcampState = bootcampState;
      const nextBootcampState = { ...previousBootcampState, guideStep: nextStep };
      const rollbackOnFailure = opts?.rollbackOnFailure ?? true;
      syncLocalBootcampState(threadId, nextBootcampState);

      apiFetch(`/api/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bootcampState: nextBootcampState,
        }),
      })
        .then((res) => {
          if (!res.ok && rollbackOnFailure) {
            const currentBootcampState = useChatStore
              .getState()
              .threads.find((thread) => thread.id === threadId)?.bootcampState;
            if (currentBootcampState?.guideStep === nextStep) {
              syncLocalBootcampState(threadId, previousBootcampState);
            }
          }
          return res;
        })
        .catch(() => {
          if (!rollbackOnFailure) return;
          const currentBootcampState = useChatStore
            .getState()
            .threads.find((thread) => thread.id === threadId)?.bootcampState;
          if (currentBootcampState?.guideStep === nextStep) {
            syncLocalBootcampState(threadId, previousBootcampState);
          }
        })
        .finally(() => {
          if (pendingAdvanceKeyRef.current === advanceKey) {
            pendingAdvanceKeyRef.current = null;
          }
        });
    },
    [bootcampState, guideStep, threadId],
  );

  useEffect(() => {
    const update = () => {
      const element = findGuideTarget(config.targets);
      setTargetRect(element ? element.getBoundingClientRect() : null);
      rafRef.current = requestAnimationFrame(update);
    };

    rafRef.current = requestAnimationFrame(update);
    return () => cancelAnimationFrame(rafRef.current);
  }, [config.targets]);

  useEffect(() => {
    autoAdvanceKeyRef.current = null;
    recoverStepKeyRef.current = null;
  }, [guideStep, threadId]);

  useEffect(() => {
    if (!config.nextStep || !threadId || !bootcampState) return;
    const nextStep = config.nextStep;

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!matchesGuideTarget(target, config.targets)) return;
      syncGuideStep(nextStep);
    };

    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [bootcampState, config.nextStep, config.targets, syncGuideStep, threadId]);

  useEffect(() => {
    if (!config.nextStep || !threadId) return;
    const nextStep = config.nextStep;
    const nextTargets = GUIDE_STEP_CONFIG[nextStep]?.targets ?? [];
    if (nextTargets.length === 0) return;
    const autoAdvanceKey = `${threadId}:${guideStep}:${nextStep}`;

    let frame = 0;
    const check = () => {
      if (autoAdvanceKeyRef.current === autoAdvanceKey) return;
      if (hasAnyGuideTarget(nextTargets)) {
        autoAdvanceKeyRef.current = autoAdvanceKey;
        syncGuideStep(nextStep);
        return;
      }
      frame = requestAnimationFrame(check);
    };

    check();
    return () => cancelAnimationFrame(frame);
  }, [config.nextStep, guideStep, syncGuideStep, threadId]);

  useEffect(() => {
    const previousStep = PREVIOUS_GUIDE_STEP[guideStep];
    if (!previousStep || !threadId) return;
    const previousTargets = GUIDE_STEP_CONFIG[previousStep]?.targets ?? [];
    if (previousTargets.length === 0) return;
    const recoverKey = `${threadId}:${guideStep}:${previousStep}`;

    let timer = 0;
    let frame = 0;
    const check = () => {
      if (recoverStepKeyRef.current === recoverKey) return;
      if (pendingAdvanceKeyRef.current) {
        frame = requestAnimationFrame(check);
        return;
      }
      if (hasAnyGuideTarget(config.targets)) return;
      if (hasAnyGuideTarget(previousTargets)) {
        recoverStepKeyRef.current = recoverKey;
        syncGuideStep(previousStep, { rollbackOnFailure: false });
        return;
      }
      frame = requestAnimationFrame(check);
    };

    timer = window.setTimeout(check, 250);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [config.targets, guideStep, syncGuideStep, threadId]);

  const arrowIcon = config.arrow === 'left' ? '👈' : config.arrow === 'up' ? '👆' : '✨';

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/40" style={{ pointerEvents: 'auto' }}>
        {targetRect && (
          <div
            className="absolute rounded-xl pointer-events-none"
            style={{
              top: targetRect.top - 6,
              left: targetRect.left - 6,
              width: targetRect.width + 12,
              height: targetRect.height + 12,
              border: '2px solid rgba(245, 158, 11, 0.8)',
              animation: 'quest-glow 2.5s ease-in-out infinite',
            }}
          />
        )}
      </div>

      <style>{elevatedSelectors ? `${elevatedSelectors} { position: relative; z-index: 65 !important; }` : ''}</style>

      {targetRect ? (
        <div className="fixed z-[66] pointer-events-none" style={getTipPosition(targetRect, config.arrow)}>
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 shadow-xl max-w-xs animate-fade-in">
            <div className="flex items-center gap-2">
              <span className="text-lg flex-shrink-0">{arrowIcon}</span>
              <span className="text-sm font-medium text-amber-800">{config.tip}</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="fixed inset-0 z-[66] flex items-center justify-center pointer-events-none">
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-3 shadow-xl">
            <div className="flex items-center gap-2">
              <span className="text-lg">⏳</span>
              <span className="text-sm font-medium text-amber-800">{config.tip}</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function getTipPosition(rect: DOMRect, arrow: 'left' | 'up' | 'none'): CSSProperties {
  if (arrow === 'left') {
    return {
      top: rect.top + rect.height / 2 - 20,
      left: rect.right + 16,
    };
  }
  if (arrow === 'up') {
    return {
      top: rect.bottom + 12,
      left: Math.max(16, rect.left + rect.width / 2 - 140),
    };
  }
  return {
    top: rect.bottom + 12,
    left: Math.max(16, rect.left - 60),
  };
}
