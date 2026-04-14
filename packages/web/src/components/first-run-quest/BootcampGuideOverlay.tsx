'use client';

import { useCallback, useEffect, useRef } from 'react';
import { apiFetch } from '@/utils/api-client';
import { AddTeammateGuide } from './AddTeammateGuide';
import type { BootcampState, GuideStep } from './guideOverlayTypes';
import { hostSelector } from './guideStepConfig';
import { LifecyclePhaseTip, type LifecycleTipConfig } from './LifecyclePhaseTip';
import { MentionTeammateGuide } from './MentionTeammateGuide';
import { PreviewResultGuide } from './PreviewResultGuide';
import { syncLocalBootcampState } from './syncLocalBootcampState';

interface BootcampGuideOverlayProps {
  catName?: string;
  phase: string;
  guideStep?: GuideStep | null;
  hasMessages?: boolean;
  threadId?: string;
  bootcampState?: BootcampState | null;
}

const PHASE_TIPS: Record<string, (catName: string) => string> = {
  'phase-1-intro': (cat) => `在下方输入框输入 @${cat} 你好  开始训练营`,
  'phase-2-env-check': (cat) => `${cat} 正在检查你的开发环境...`,
  'phase-3-config-help': (cat) => `跟着 ${cat} 的指引完成配置`,
};

const LIFECYCLE_TIPS: Record<string, LifecycleTipConfig> = {
  'phase-5-kickoff': { icon: '\u{1F680}', text: '告诉猫猫你想做什么项目，TA 会帮你分析和拆解需求', variant: 'blue' },
  'phase-6-design': { icon: '\u{1F3A8}', text: '猫猫会给出设计方案，选择你喜欢的然后继续', variant: 'purple' },
  'phase-7-dev': { icon: '\u{1F4BB}', text: '猫猫正在开发，遇到关键决策会问你', variant: 'amber' },
  'phase-8-review': { icon: '\u{1F50D}', text: '让队友来 review 代码，在输入框 @TA 的名字', variant: 'blue' },
  'phase-9-complete': { icon: '\u2705', text: 'Review 通过，准备合入主分支', variant: 'green' },
  'phase-10-retro': { icon: '\u{1F4DD}', text: '和猫猫一起回顾这个项目，看看学到了什么', variant: 'amber' },
  'phase-11-farewell': { icon: '\u{1F393}', text: '恭喜完成训练营！你已经掌握了多猫协作的基本流程', variant: 'green' },
};

export function BootcampGuideOverlay({
  catName,
  phase,
  guideStep,
  hasMessages,
  threadId,
  bootcampState,
}: BootcampGuideOverlayProps) {
  if (
    phase === 'phase-4.5-add-teammate' &&
    guideStep &&
    !['done', 'return-to-chat', 'mention-teammate'].includes(guideStep)
  ) {
    return <AddTeammateGuide guideStep={guideStep} threadId={threadId} bootcampState={bootcampState} />;
  }

  if (phase === 'phase-4.5-add-teammate' && (guideStep === 'done' || guideStep === 'return-to-chat')) {
    return <PostAddTeammateTip threadId={threadId} bootcampState={bootcampState} guideStep={guideStep} />;
  }

  if (phase === 'phase-4.5-add-teammate' && guideStep === 'mention-teammate') {
    return <MentionTeammateGuide />;
  }

  if (phase === 'phase-4-first-project' && guideStep === 'preview-result') {
    return <PreviewResultGuide catName={catName} threadId={threadId} bootcampState={bootcampState} />;
  }

  // DelayedMistakeTip removed: preview-result advance is now event-driven
  // via useEffect in ChatContainer (fires when gate detects invocation end).

  const lifecycleTip = LIFECYCLE_TIPS[phase];
  if (lifecycleTip) {
    return <LifecyclePhaseTip phase={phase} config={lifecycleTip} />;
  }

  if (hasMessages) return null;
  const cat = catName ?? '猫猫';
  const tipFn = PHASE_TIPS[phase];
  if (!tipFn) return null;
  const tip = tipFn(cat);

  return (
    <>
      {/* Full-screen overlay with input punch-through */}
      <div className="fixed inset-0 z-[60] bg-black/30" style={{ pointerEvents: 'auto' }} />
      <style>{`[data-bootcamp-step="chat-input"] { position: relative; z-index: 65 !important; }`}</style>
      <div className="pointer-events-none fixed bottom-24 left-1/2 -translate-x-1/2 z-[66]">
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-3 shadow-xl animate-fade-in">
          <div className="flex items-center gap-2">
            <span className="text-lg">👇</span>
            <span className="text-sm font-medium text-amber-800">{tip}</span>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Post-add-teammate tip: shows green celebration tip and auto-advances
 * to `mention-teammate` when Hub modal is closed.
 */
function PostAddTeammateTip({
  threadId,
  bootcampState,
  guideStep,
}: {
  threadId?: string;
  bootcampState?: BootcampState | null;
  guideStep: GuideStep;
}) {
  const advancedRef = useRef(false);

  const advanceToMention = useCallback(() => {
    if (advancedRef.current || !threadId || !bootcampState) return;
    advancedRef.current = true;
    const next: BootcampState = { ...bootcampState, guideStep: 'mention-teammate' };
    syncLocalBootcampState(threadId, next);
    apiFetch(`/api/threads/${threadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootcampState: next }),
    }).catch(() => {});
  }, [threadId, bootcampState]);

  useEffect(() => {
    advancedRef.current = false;
  }, [guideStep, threadId]);

  // Auto-advance to mention-teammate when Hub modal is no longer in the DOM
  useEffect(() => {
    let frame = 0;
    const check = () => {
      const hubModal = document.querySelector(hostSelector('hub-modal'));
      if (!hubModal) {
        advanceToMention();
        return;
      }
      frame = requestAnimationFrame(check);
    };
    // Small delay to let the DOM settle after step transition
    const timer = window.setTimeout(check, 300);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [advanceToMention]);

  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[66] pointer-events-none">
      <div className="rounded-xl border border-green-300 bg-green-50 px-5 py-3 shadow-xl animate-fade-in">
        <div className="flex items-center gap-2">
          <span className="text-lg">🎉</span>
          <span className="text-sm font-medium text-green-800">
            新队友已加入！以后可以在 Hub 随时添加更多猫猫。关闭设置回到聊天吧！
          </span>
        </div>
      </div>
    </div>
  );
}
