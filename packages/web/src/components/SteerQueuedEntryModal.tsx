'use client';

import { useEffect, useRef, useState } from 'react';
import { AvatarImageWithFallback } from './AvatarImageWithFallback';

export interface SteerTargetOption {
  id: string;
  label: string;
  avatar?: string;
  canAppend: boolean;
}

export function SteerQueuedEntryModal({
  source: _source = 'queued',
  targets = [],
  initialTargetId,
  onCancel,
  onConfirm,
  onAppend,
}: {
  source?: 'draft' | 'queued';
  targets?: readonly SteerTargetOption[];
  initialTargetId?: string;
  onCancel: () => void;
  onConfirm: (targetId?: string) => void;
  onAppend?: (targetId: string) => void;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [selectedTargetId, setSelectedTargetId] = useState(initialTargetId ?? targets[0]?.id);
  const selectedTarget = targets.find((target) => target.id === selectedTargetId);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onCancel]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop click-to-close, keyboard Escape handled via useEffect
    <div
      role="presentation"
      className="fixed inset-0 bg-[var(--console-overlay-backdrop)] backdrop-blur-sm flex items-center justify-center z-50"
      onClick={(e) => {
        if (modalRef.current && !modalRef.current.contains(e.target as Node)) onCancel();
      }}
    >
      <div ref={modalRef} className="bg-cafe-surface rounded-2xl shadow-2xl w-full max-w-[520px] mx-4 overflow-hidden">
        <div className="px-6 pt-6 pb-4">
          <h2 className="text-lg font-semibold text-cafe-black">Steer</h2>
        </div>

        <div className="px-6 pb-5">
          <div className="flex flex-wrap gap-2">
            {targets.map((target) => {
              const selected = target.id === selectedTargetId;
              return (
                <button
                  key={target.id}
                  type="button"
                  aria-pressed={selected}
                  data-testid={`steer-target-${target.id}`}
                  onClick={() => setSelectedTargetId(target.id)}
                  className={`flex items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors ${
                    selected
                      ? 'border-[var(--color-cocreator-primary)] bg-[var(--color-cocreator-surface)] text-cafe-black'
                      : 'border-[var(--console-border-soft)] text-cafe-secondary hover:bg-cafe-surface-sunken'
                  }`}
                >
                  {target.avatar && (
                    <AvatarImageWithFallback src={target.avatar} alt="" className="h-5 w-5 rounded-full object-cover" />
                  )}
                  <span>{target.label}</span>
                </button>
              );
            })}
            {targets.length === 0 ? <span className="text-sm text-cafe-muted">当前对话暂无可选成员</span> : null}
          </div>
        </div>

        <div className="px-6 pb-6 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-cafe-secondary hover:text-cafe-secondary transition-colors"
          >
            取消
          </button>
          <div className="flex items-center justify-end gap-2">
            {selectedTarget?.canAppend && onAppend && (
              <button
                type="button"
                data-testid="steer-append"
                onClick={() => onAppend(selectedTarget.id)}
                className="text-sm px-4 py-2 rounded-full border border-[var(--console-border-soft)] text-cafe-black hover:bg-cafe-surface-sunken transition-colors"
              >
                立即发送，不停止
              </button>
            )}
            <button
              type="button"
              data-testid="steer-confirm"
              disabled={!selectedTarget}
              onClick={() => onConfirm(selectedTarget?.id)}
              className="text-sm px-4 py-2 rounded-full bg-[var(--color-cocreator-primary)] text-[var(--cafe-surface)] hover:opacity-90 transition-colors disabled:opacity-40"
            >
              停止回复并发送
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
