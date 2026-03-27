'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useGuideEngine } from '@/hooks/useGuideEngine';
import { useGuideStore } from '@/stores/guideStore';
import { GuideHUD } from './guide-overlay-parts';

const NUDGE_DELAY_MS = 8_000;
const DEFAULT_TIMEOUT_SEC = 180;

/**
 * F150: Guide Overlay
 *
 * Full-screen overlay with spotlight cutout + HUD.
 * Box-shadow trick for dark mask; four-panel click shield
 * leaves a genuine hole over the target element.
 */
export function GuideOverlay() {
  useGuideEngine();
  const session = useGuideStore((s) => s.session);
  const nextStep = useGuideStore((s) => s.nextStep);
  const prevStep = useGuideStore((s) => s.prevStep);
  const skipStep = useGuideStore((s) => s.skipStep);
  const exitGuide = useGuideStore((s) => s.exitGuide);
  const setObservationState = useGuideStore((s) => s.setObservationState);
  const setStepStatus = useGuideStore((s) => s.setStepStatus);

  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [targetFound, setTargetFound] = useState(false);
  const [nudgeVisible, setNudgeVisible] = useState(false);
  const observerRef = useRef<MutationObserver | null>(null);
  const rafRef = useRef<number>(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const lastRectRef = useRef<{ t: number; l: number; w: number; h: number } | null>(null);

  const currentStep = session && session.currentStepIndex < session.steps.length
    ? session.steps[session.currentStepIndex]
    : null;

  const isComplete = session
    ? session.currentStepIndex >= session.steps.length
    : false;

  // Locate target element by data-guide-id
  const locateTarget = useCallback(() => {
    if (!currentStep) {
      setTargetRect(null);
      setTargetFound(false);
      return;
    }
    const el = document.querySelector(`[data-guide-id="${currentStep.targetGuideId}"]`);
    if (el) {
      setTargetRect(el.getBoundingClientRect());
      setTargetFound(true);
      setObservationState('active');
      setStepStatus('awaiting_user');
    } else {
      setTargetRect(null);
      setTargetFound(false);
      setStepStatus('locating_target');
      retryTimerRef.current = setTimeout(() => {
        const retryEl = document.querySelector(`[data-guide-id="${currentStep.targetGuideId}"]`);
        if (retryEl) {
          setTargetRect(retryEl.getBoundingClientRect());
          setTargetFound(true);
          setObservationState('active');
          setStepStatus('awaiting_user');
        } else {
          setObservationState('error');
          setStepStatus('failed');
        }
      }, 300);
    }
  }, [currentStep, setObservationState, setStepStatus]);

  // P2-2 fix: rAF with rect comparison to skip unnecessary re-renders
  useEffect(() => {
    if (!session || !currentStep || isComplete) return;
    lastRectRef.current = null;

    const updateRect = () => {
      const el = document.querySelector(`[data-guide-id="${currentStep.targetGuideId}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        const prev = lastRectRef.current;
        if (!prev || prev.t !== r.top || prev.l !== r.left
          || prev.w !== r.width || prev.h !== r.height) {
          lastRectRef.current = { t: r.top, l: r.left, w: r.width, h: r.height };
          setTargetRect(r);
        }
        if (!targetFound) {
          setTargetFound(true);
          setObservationState('active');
          setStepStatus('awaiting_user');
        }
      }
      rafRef.current = requestAnimationFrame(updateRect);
    };

    rafRef.current = requestAnimationFrame(updateRect);
    return () => cancelAnimationFrame(rafRef.current);
  }, [session, currentStep, isComplete, targetFound, setObservationState, setStepStatus]);

  // MutationObserver to detect when target appears in DOM
  useEffect(() => {
    if (!session || !currentStep || isComplete) return;
    locateTarget();
    const observer = new MutationObserver(() => {
      if (!targetFound) locateTarget();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = null;
      clearTimeout(retryTimerRef.current);
    };
  }, [session, currentStep, isComplete, locateTarget, targetFound]);

  // P1-2 fix: Per-step idle timer (nudge at 8s, timeout at timeoutSec)
  useEffect(() => {
    if (!currentStep || isComplete || session?.stepStatus !== 'awaiting_user') {
      setNudgeVisible(false);
      return;
    }
    setNudgeVisible(false);
    const nudgeTimer = setTimeout(() => setNudgeVisible(true), NUDGE_DELAY_MS);
    const sec = currentStep.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    const timeoutTimer = setTimeout(() => {
      setStepStatus('timed_out');
      setObservationState('error');
    }, sec * 1000);
    return () => { clearTimeout(nudgeTimer); clearTimeout(timeoutTimer); };
  }, [currentStep, isComplete, session?.stepStatus, session?.currentStepIndex, setStepStatus, setObservationState]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!session) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitGuide();
      if (e.key === 'ArrowRight') nextStep();
      if (e.key === 'ArrowLeft') prevStep();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [session, exitGuide, nextStep, prevStep]);

  if (!session) return null;

  if (isComplete) {
    return (
      <div className="fixed inset-0 z-[var(--guide-z-overlay)] flex items-center justify-center">
        <div className="fixed inset-0 bg-black/20" onClick={exitGuide} />
        <div className="relative z-10 rounded-2xl border border-[var(--guide-hud-border)] bg-[var(--guide-hud-bg)] p-8 text-center shadow-2xl">
          <div className="mb-4 text-4xl">🐾</div>
          <h3 className="mb-2 text-lg font-bold text-[var(--guide-text-primary)]">引导完成!</h3>
          <p className="mb-4 text-sm text-[var(--guide-text-secondary)]">
            你已经完成了「{session.guideId === 'add-member' ? '添加成员' : session.guideId}」的全部步骤。
          </p>
          <button
            type="button"
            onClick={exitGuide}
            className="rounded-xl bg-[var(--guide-success)] px-6 py-2 text-sm font-semibold text-white transition hover:opacity-90"
          >
            太好了!
          </button>
        </div>
      </div>
    );
  }

  if (!currentStep) return null;

  const pad = 8;
  const cutoutStyle: React.CSSProperties = targetRect
    ? {
        position: 'fixed',
        top: targetRect.top - pad,
        left: targetRect.left - pad,
        width: targetRect.width + pad * 2,
        height: targetRect.height + pad * 2,
        borderRadius: 'var(--guide-radius)',
        boxShadow: '0 0 0 9999px var(--guide-overlay-bg)',
        transition: 'all var(--guide-motion-normal) ease-out',
        zIndex: 'var(--guide-z-overlay)' as unknown as number,
        pointerEvents: 'none' as const,
      }
    : {
        position: 'fixed' as const,
        inset: 0,
        backgroundColor: 'var(--guide-overlay-bg)',
        zIndex: 'var(--guide-z-overlay)' as unknown as number,
        pointerEvents: 'none' as const,
      };

  const ringStyle: React.CSSProperties = targetRect
    ? {
        position: 'fixed',
        top: targetRect.top - pad - 2,
        left: targetRect.left - pad - 2,
        width: targetRect.width + pad * 2 + 4,
        height: targetRect.height + pad * 2 + 4,
        borderRadius: 'var(--guide-radius)',
        border: '2px solid var(--guide-cutout-ring)',
        boxShadow: '0 0 12px var(--guide-cutout-shadow), inset 0 0 8px var(--guide-cutout-shadow)',
        transition: 'all var(--guide-motion-normal) ease-out',
        zIndex: 1105,
        pointerEvents: 'none' as const,
        animation: 'guide-breathe 1.8s ease-in-out infinite',
      }
    : {};

  const shieldZ = 1101;

  return (
    <>
      <div style={cutoutStyle} aria-hidden="true" />
      {targetRect && <div style={ringStyle} aria-hidden="true" />}

      {/* P1-1 fix: Four-panel click shield with genuine hole over target */}
      {targetRect ? (
        <>
          <div className="fixed top-0 left-0 right-0" style={{ height: Math.max(0, targetRect.top - pad), zIndex: shieldZ, pointerEvents: 'auto' }} aria-hidden="true" />
          <div className="fixed bottom-0 left-0 right-0" style={{ top: targetRect.bottom + pad, zIndex: shieldZ, pointerEvents: 'auto' }} aria-hidden="true" />
          <div className="fixed" style={{ top: targetRect.top - pad, left: 0, width: Math.max(0, targetRect.left - pad), height: targetRect.height + pad * 2, zIndex: shieldZ, pointerEvents: 'auto' }} aria-hidden="true" />
          <div className="fixed" style={{ top: targetRect.top - pad, left: targetRect.right + pad, right: 0, height: targetRect.height + pad * 2, zIndex: shieldZ, pointerEvents: 'auto' }} aria-hidden="true" />
        </>
      ) : (
        <div className="fixed inset-0" style={{ zIndex: shieldZ, pointerEvents: 'auto' }} aria-hidden="true" />
      )}

      <GuideHUD
        step={currentStep}
        stepIndex={session.currentStepIndex}
        totalSteps={session.steps.length}
        observationState={session.observationState}
        targetRect={targetRect}
        onPrev={prevStep}
        onNext={nextStep}
        onSkip={skipStep}
        onExit={exitGuide}
        isComplete={false}
        nudgeVisible={nudgeVisible}
      />
    </>
  );
}
