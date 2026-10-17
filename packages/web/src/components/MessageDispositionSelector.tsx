'use client';

import type { MessageWorkDisposition } from '@cat-cafe/shared';
import type { MessageDispositionPreferenceController } from '@/hooks/useMessageDispositionPreference';

const DISPOSITION_LABEL: Record<MessageWorkDisposition, string> = {
  next_work: '作为下一件工作',
  continue_current: '接着当前工作',
};

/** Only this message changes here. Persisted defaults belong to Settings. */
export function MessageDispositionSelector({
  controller,
  onBack,
}: {
  controller: MessageDispositionPreferenceController;
  onBack: () => void;
}) {
  return (
    <div data-testid="message-disposition-panel" className="p-2.5">
      <div className="flex items-center gap-2 pb-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回添加菜单"
          className="h-8 w-8 rounded text-cafe-muted hover:bg-cafe-surface"
        >
          ←
        </button>
        <span className="text-sm font-medium text-cafe-primary">这条发出去后</span>
        <span className="text-xs text-cafe-muted">仅这一次</span>
      </div>
      <div className="grid gap-1">
        {(['next_work', 'continue_current'] as const).map((disposition) => (
          <button
            key={disposition}
            type="button"
            data-disposition-option={disposition}
            aria-pressed={controller.effective === disposition}
            onClick={() => {
              controller.setOneShot(disposition);
              onBack();
            }}
            className={`rounded-lg px-3 py-2 text-left hover:bg-cafe-surface-elevated ${controller.effective === disposition ? 'bg-cafe-surface-elevated' : ''}`}
          >
            <span className="block text-sm text-cafe-primary">{DISPOSITION_LABEL[disposition]}</span>
            <span className="block text-xs text-cafe-muted">
              {disposition === 'next_work' ? '等猫空闲后开始' : '能接进当前回复时补进去，否则继续排队'}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function messageDispositionLabel(disposition: MessageWorkDisposition): string {
  return DISPOSITION_LABEL[disposition];
}
