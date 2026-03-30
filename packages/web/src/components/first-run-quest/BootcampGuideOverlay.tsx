'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

type GuideStep = 'open-hub' | 'click-add-member' | 'fill-form' | 'done';

interface BootcampState {
  phase: string;
  guideStep?: GuideStep | null;
  [key: string]: unknown;
}

interface BootcampGuideOverlayProps {
  catName?: string;
  phase: string;
  guideStep?: GuideStep | null;
  hasMessages?: boolean;
  threadId?: string;
  bootcampState?: BootcampState | null;
}

/** Guide tips for the initial intro phase (no messages yet). */
const PHASE_TIPS: Record<string, (catName: string) => string> = {
  'phase-1-intro': (cat) => `在下方输入框输入 @${cat} 你好  开始训练营`,
  'phase-2-env-check': (cat) => `${cat} 正在检查你的开发环境...`,
  'phase-3-config-help': (cat) => `跟着 ${cat} 的指引完成配置`,
};

/** Guide tips for the add-teammate flow (console navigation). */
const GUIDE_STEP_CONFIG: Record<
  GuideStep,
  {
    tip: string;
    target: string;
    arrow: 'left' | 'up' | 'none';
    /** Next step to advance to when user clicks the target */
    nextStep: GuideStep | null;
  }
> = {
  'open-hub': {
    tip: '点击右上角的 ⚙️ 设置按钮，打开 Hub 控制台',
    target: 'hub-button',
    arrow: 'left',
    nextStep: 'click-add-member',
  },
  'click-add-member': {
    tip: '点击「+ 添加成员」按钮，添加一位新的猫猫队友',
    target: 'add-member-button',
    arrow: 'up',
    nextStep: 'fill-form',
  },
  'fill-form': {
    tip: '填写猫猫信息，选择客户端和模型，然后点击保存',
    target: 'cat-editor',
    arrow: 'none',
    nextStep: null, // Advance handled by watching cats.length in ChatContainer
  },
  done: {
    tip: '',
    target: '',
    arrow: 'none',
    nextStep: null,
  },
};

/**
 * Bootcamp guide overlay system.
 *
 * Two modes:
 * 1. **Initial intro**: Full-screen overlay with input punch-through (phase-1-intro, no messages)
 * 2. **Add-teammate guide**: Step-by-step overlay highlighting specific UI elements
 */
export function BootcampGuideOverlay({
  catName,
  phase,
  guideStep,
  hasMessages,
  threadId,
  bootcampState,
}: BootcampGuideOverlayProps) {
  // ── Mode 1: Add-teammate guide (phase-4.5-add-teammate) ──
  if (phase === 'phase-4.5-add-teammate' && guideStep && guideStep !== 'done') {
    return <AddTeammateGuide guideStep={guideStep} threadId={threadId} bootcampState={bootcampState} />;
  }

  // ── Mode 1b: Add-teammate done — show floating @mention tip (no overlay) ──
  if (phase === 'phase-4.5-add-teammate' && guideStep === 'done') {
    return (
      <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[66] pointer-events-none">
        <div className="rounded-xl border border-green-300 bg-green-50 px-5 py-3 shadow-xl animate-fade-in">
          <div className="flex items-center gap-2">
            <span className="text-lg">🎉</span>
            <span className="text-sm font-medium text-green-800">
              新队友已加入！在下方输入框 @TA 的名字，让 TA 来 review 代码
            </span>
          </div>
        </div>
      </div>
    );
  }

  // ── Mode 2: Initial intro overlay (no messages yet) ──
  if (hasMessages) return null;
  const cat = catName ?? '猫猫';
  const tipFn = PHASE_TIPS[phase];
  if (!tipFn) return null;
  const tip = tipFn(cat);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/30" style={{ pointerEvents: 'auto' }}>
      <div className="pointer-events-none mx-auto mb-20 rounded-xl border border-amber-300 bg-amber-50 px-5 py-3 shadow-xl">
        <div className="flex items-center gap-2">
          <span className="text-lg">👇</span>
          <span className="text-sm font-medium text-amber-800">{tip}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Step-by-step overlay for adding a teammate via Hub console.
 * Highlights target elements and auto-advances guideStep on click.
 */
function AddTeammateGuide({
  guideStep,
  threadId,
  bootcampState,
}: {
  guideStep: GuideStep;
  threadId?: string;
  bootcampState?: BootcampState | null;
}) {
  const config = GUIDE_STEP_CONFIG[guideStep];
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const rafRef = useRef<number>(0);
  const advancingRef = useRef(false);

  // Track the target element's position via rAF
  useEffect(() => {
    const update = () => {
      const el = document.querySelector(`[data-bootcamp-step="${config.target}"]`);
      if (el) {
        setTargetRect(el.getBoundingClientRect());
      } else {
        setTargetRect(null);
      }
      rafRef.current = requestAnimationFrame(update);
    };
    rafRef.current = requestAnimationFrame(update);
    return () => cancelAnimationFrame(rafRef.current);
  }, [config.target]);

  // Listen for clicks on the target element to auto-advance guideStep
  useEffect(() => {
    if (!config.nextStep || !threadId || !bootcampState) return;
    const nextStep = config.nextStep;

    const handleClick = () => {
      if (advancingRef.current) return;
      advancingRef.current = true;
      apiFetch(`/api/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bootcampState: { ...bootcampState, guideStep: nextStep },
        }),
      }).finally(() => {
        advancingRef.current = false;
      });
    };

    // Small delay to ensure the element is rendered
    const timer = setTimeout(() => {
      const el = document.querySelector(`[data-bootcamp-step="${config.target}"]`);
      if (el) {
        el.addEventListener('click', handleClick, { once: true });
      }
    }, 100);

    return () => {
      clearTimeout(timer);
      const el = document.querySelector(`[data-bootcamp-step="${config.target}"]`);
      if (el) el.removeEventListener('click', handleClick);
    };
  }, [config.target, config.nextStep, threadId, bootcampState]);

  const arrowIcon = config.arrow === 'left' ? '👈' : config.arrow === 'up' ? '👆' : '✨';

  return (
    <>
      {/* Dark overlay — blocks clicks everywhere */}
      <div className="fixed inset-0 z-[60] bg-black/40" style={{ pointerEvents: 'auto' }}>
        {/* Spotlight glow ring around target */}
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

      {/* Elevate the target element above the overlay so it's clickable */}
      <style>{`[data-bootcamp-step="${config.target}"] { position: relative; z-index: 65 !important; }`}</style>

      {/* Floating tip near the target */}
      {targetRect && (
        <div className="fixed z-[66] pointer-events-none" style={getTipPosition(targetRect, config.arrow)}>
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 shadow-xl max-w-xs animate-fade-in">
            <div className="flex items-center gap-2">
              <span className="text-lg flex-shrink-0">{arrowIcon}</span>
              <span className="text-sm font-medium text-amber-800">{config.tip}</span>
            </div>
          </div>
        </div>
      )}

      {/* Fallback: target not yet visible — centered loading tip */}
      {!targetRect && (
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

/** Position the floating tip near the target element. */
function getTipPosition(rect: DOMRect, arrow: 'left' | 'up' | 'none'): React.CSSProperties {
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
