'use client';

import { useCallback, useRef } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { BootcampState, GuideStep } from './guideOverlayTypes';
import { syncLocalBootcampState } from './syncLocalBootcampState';

interface PreviewResultGuideProps {
  catName?: string;
  threadId?: string;
  bootcampState?: BootcampState | null;
}

/**
 * Phase 4 "preview result" overlay:
 * Shows after the cat delivers the first project, guiding the user to
 * check the result before advancing to Phase 7.5 (add teammate).
 *
 * User clicks anywhere on the overlay to proceed to Phase 7.5 open-hub.
 */
export function PreviewResultGuide({ catName, threadId, bootcampState }: PreviewResultGuideProps) {
  const advancedRef = useRef(false);
  const cat = catName ?? '猫猫';

  const advanceToAddTeammate = useCallback(() => {
    if (advancedRef.current || !threadId || !bootcampState) return;
    advancedRef.current = true;

    const next: BootcampState = {
      ...bootcampState,
      phase: 'phase-7.5-add-teammate',
      guideStep: 'open-hub' as GuideStep,
    };
    syncLocalBootcampState(threadId, next);
    apiFetch(`/api/threads/${threadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootcampState: next }),
    }).catch(() => {});
  }, [threadId, bootcampState]);

  return (
    <>
      {/* Full-screen overlay — clicking advances to Phase 7.5 */}
      <div
        className="fixed inset-0 z-[60] bg-black/30 cursor-pointer"
        style={{ pointerEvents: 'auto' }}
        onClick={advanceToAddTeammate}
      />
      {/* Keep chat messages scrollable above the overlay */}
      <style>{`[data-bootcamp-host="chat-messages"] { position: relative; z-index: 65 !important; }`}</style>
      {/* Tip at bottom */}
      <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[66] pointer-events-none">
        <div className="rounded-xl border border-blue-300 bg-blue-50 px-5 py-3 shadow-xl animate-fade-in">
          <div className="flex flex-col items-center gap-2">
            <div className="flex items-center gap-2">
              <span className="text-lg">👀</span>
              <span className="text-sm font-medium text-blue-800">看看{cat}做的效果！点击聊天中的链接打开预览</span>
            </div>
            <span className="text-xs text-blue-600">看完后点击任意处继续 →</span>
          </div>
        </div>
      </div>
    </>
  );
}
