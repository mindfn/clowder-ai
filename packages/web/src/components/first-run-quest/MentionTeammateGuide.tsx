'use client';

import { useEffect, useRef, useState } from 'react';
import { findGuideTarget } from './guideStepConfig';

/**
 * Spotlight overlay highlighting the chat input box with a tip
 * to @mention the new teammate.
 */
export function MentionTeammateGuide() {
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const update = () => {
      const el = findGuideTarget(['chat-input']);
      setTargetRect(el ? el.getBoundingClientRect() : null);
      rafRef.current = requestAnimationFrame(update);
    };
    rafRef.current = requestAnimationFrame(update);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[66] pointer-events-none">
      <div className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-3 shadow-xl animate-fade-in">
        <div className="flex items-center gap-2">
          <span className="text-lg">👇</span>
          <span className="text-sm font-medium text-amber-800">
            在输入框输入 @ 加上新队友的名字，让 TA 来 review 代码
          </span>
        </div>
      </div>
      {targetRect && (
        <style>{`
          [data-bootcamp-step="chat-input"] {
            box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.5);
            border-radius: 0.75rem;
          }
        `}</style>
      )}
    </div>
  );
}
