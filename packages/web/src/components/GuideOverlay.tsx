'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useGuideEngine } from '@/hooks/useGuideEngine';
import { useGuideStore } from '@/stores/guideStore';
import { GuideHUD } from './guide-overlay-parts';

/**
 * F150: Guide Overlay
 *
 * Full-screen overlay with spotlight cutout + HUD.
 * Uses box-shadow trick: a positioned div at the target rect
 * with a massive shadow that covers the rest of the screen.
 */
export function GuideOverlay() {
  useGuideEngine(); // Register window.__startGuide + event listeners
  const session = useGuideStore((s) => s.session);
  const nextStep = useGuideStore((s) => s.nextStep);
  const prevStep = useGuideStore((s) => s.prevStep);
  const skipStep = useGuideStore((s) => s.skipStep);
  const exitGuide = useGuideStore((s) => s.exitGuide);
  const setObservationState = useGuideStore((s) => s.setObservationState);
  const setStepStatus = useGuideStore((s) => s.setStepStatus);

  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [targetFound, setTargetFound] = useState(false);
  const observerRef = useRef<MutationObserver | null>(null);
  const rafRef = useRef<number>(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout>>();

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
      const rect = el.getBoundingClientRect();
      setTargetRect(rect);
      setTargetFound(true);
      setObservationState('active');
      setStepStatus('awaiting_user');
    } else {
      setTargetRect(null);
      setTargetFound(false);
      setStepStatus('locating_target');
      // Retry once after 300ms
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

  // Track target position on scroll/resize via rAF
  useEffect(() => {
    if (!session || !currentStep || isComplete) return;

    const updateRect = () => {
      const el = document.querySelector(`[data-guide-id="${currentStep.targetGuideId}"]`);
      if (el) {
        setTargetRect(el.getBoundingClientRect());
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

  // Flow complete state
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

  // Spotlight cutout dimensions (with padding)
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

  // Spotlight ring (breathing animation)
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

  // Click shield: blocks clicks outside target, allows clicks on target
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (!targetRect) return;
    const { clientX, clientY } = e;
    const inTarget =
      clientX >= targetRect.left - pad &&
      clientX <= targetRect.right + pad &&
      clientY >= targetRect.top - pad &&
      clientY <= targetRect.bottom + pad;
    if (!inTarget) {
      // Click outside target — do nothing (block it)
      e.stopPropagation();
    }
    // Click on target — let it through (overlay has pointer-events: none on cutout)
  };

  return (
    <>
      {/* Dark mask with cutout */}
      <div style={cutoutStyle} aria-hidden="true" />

      {/* Spotlight ring */}
      {targetRect && <div style={ringStyle} aria-hidden="true" />}

      {/* Click shield (full screen, but pointer-events auto only outside target) */}
      <div
        className="fixed inset-0"
        style={{ zIndex: 1101, pointerEvents: 'auto' }}
        onClick={handleOverlayClick}
        aria-hidden="true"
      >
        {/* Transparent hole over target to let clicks through */}
        {targetRect && (
          <div
            style={{
              position: 'fixed',
              top: targetRect.top - pad,
              left: targetRect.left - pad,
              width: targetRect.width + pad * 2,
              height: targetRect.height + pad * 2,
              pointerEvents: 'none',
            }}
          />
        )}
      </div>

      {/* HUD Panel */}
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
      />
    </>
  );
}
