'use client';

import type { MessageWorkDisposition } from '@cat-cafe/shared';
import type { MessageDispositionPreferenceController } from '@/hooks/useMessageDispositionPreference';
import { messageDispositionCopy } from './message-disposition.shell-copy';
import type { FreshnessCarrierSupport } from './message-disposition-presentation';
import { useShellCopy } from './shell/shell-copy';

interface MessageDispositionMenuSectionProps {
  controller: MessageDispositionPreferenceController;
  carrierSupport: FreshnessCarrierSupport;
  onClose: () => void;
}

export function MessageDispositionMenuSection({
  controller,
  carrierSupport,
  onClose,
}: MessageDispositionMenuSectionProps) {
  const t = useShellCopy(messageDispositionCopy).menu;
  const displayed =
    controller.effective === 'continue_current' && carrierSupport !== 'exact' ? 'next_work' : controller.effective;

  const choose = async (disposition: MessageWorkDisposition) => {
    if (controller.loading || (disposition === 'continue_current' && carrierSupport !== 'exact')) return;
    if (await controller.setPreference('thread', disposition)) onClose();
  };

  const options = [
    { disposition: 'next_work' as const, label: t.nextLabel, note: t.nextNote, disabled: false },
    {
      disposition: 'continue_current' as const,
      label: t.continueLabel,
      note:
        carrierSupport === 'exact' ? t.continueNote : carrierSupport === 'undeclared' ? t.undeclared : t.unsupported,
      disabled: carrierSupport !== 'exact',
    },
  ];

  return (
    <fieldset data-testid="message-disposition-menu-section" className="border-b border-[var(--shell-hairline)] p-1.5">
      <legend id="message-disposition-menu-heading" className="px-2 py-1 text-xs font-medium text-[var(--shell-muted)]">
        {t.heading}
      </legend>
      <div className="grid gap-0.5">
        {options.map(({ disposition, label, note, disabled }) => (
          <button
            key={disposition}
            type="button"
            role="menuitemradio"
            aria-checked={displayed === disposition}
            data-disposition-option={disposition}
            disabled={controller.loading || disabled}
            onClick={() => void choose(disposition)}
            className="shell-focusable flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left text-[var(--shell-body)] hover:bg-[var(--shell-selected)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full border border-[var(--shell-ink)]"
            >
              {displayed === disposition ? <span className="h-2 w-2 rounded-full bg-[var(--shell-ink)]" /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-[var(--shell-ink)]">{label}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-[var(--shell-muted)]">{note}</span>
            </span>
          </button>
        ))}
      </div>
      <output className="block min-h-4 px-2 pt-1 text-micro text-[var(--shell-muted)]" aria-live="polite">
        {controller.loading ? t.saving : controller.error ? t.saveFailed : null}
      </output>
    </fieldset>
  );
}
