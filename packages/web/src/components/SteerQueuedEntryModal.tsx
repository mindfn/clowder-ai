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
  source = 'queued',
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
  const isDraft = source === 'draft';
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
          <h2 className="text-lg font-semibold text-cafe-black">
            {isDraft ? 'Steer' : 'Steer（强制停止并发送此消息）'}
          </h2>
          {!isDraft && (
            <p className="text-sm text-cafe-secondary mt-1">会停止目标当前回复，然后立即发送这条排队消息。</p>
          )}
        </div>

        {isDraft ? (
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
                      <AvatarImageWithFallback
                        src={target.avatar}
                        alt=""
                        className="h-5 w-5 rounded-full object-cover"
                      />
                    )}
                    <span>{target.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="px-6 pb-5">
            <div className="w-full p-4 rounded-xl border border-[var(--conn-amber-ring)] bg-[var(--conn-amber-bg)]">
              <div className="flex items-center gap-2 text-sm font-medium text-[var(--conn-amber-text)]">
                <svg
                  aria-hidden="true"
                  className="h-4 w-4 flex-shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
                  <line x1="12" x2="12" y1="9" y2="13" />
                  <line x1="12" x2="12.01" y1="17" y2="17" />
                </svg>
                <span>会停止当前回复后发送此消息</span>
              </div>
              <div className="text-xs text-cafe-secondary mt-1">
                旧回复会被停止；系统只以这条已持久化消息启动一次。已经完成的回复仍会保留在聊天记录中。
              </div>
            </div>
          </div>
        )}

        <div className="px-6 pb-6 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-cafe-secondary hover:text-cafe-secondary transition-colors"
          >
            取消
          </button>
          <div className="flex items-center justify-end gap-2">
            {isDraft && selectedTarget?.canAppend && onAppend && (
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
              disabled={isDraft && !selectedTarget}
              onClick={() => onConfirm(selectedTarget?.id)}
              className="text-sm px-4 py-2 rounded-full bg-[var(--color-cocreator-primary)] text-[var(--cafe-surface)] hover:opacity-90 transition-colors disabled:opacity-40"
            >
              {isDraft ? '停止回复并发送' : '停止并发送'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
