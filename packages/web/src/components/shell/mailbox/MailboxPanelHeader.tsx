import { useShellCopy } from '../shell-copy';
import { mailboxEntryCopy } from './mailbox-entry.shell-copy';
import type { MailboxSection } from './mailbox-navigation';

export function MailboxPanelHeader({
  section,
  total,
  handled,
  onClose,
  onBack,
  onOpenSchedule,
}: {
  section: MailboxSection;
  total: number | null;
  handled: number | null;
  onClose: () => void;
  onBack: () => void;
  onOpenSchedule?: () => void;
}) {
  const t = useShellCopy(mailboxEntryCopy);
  const title =
    section === 'history'
      ? `已处理的${handled === null ? '' : ` · ${handled}`}`
      : section === 'tools'
        ? '审批记录'
        : '待办';
  return (
    <header className="flex-none px-[22px] pb-3 pt-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-base font-semibold" data-testid="mailbox-title">
          {title}
        </h2>
        <button
          type="button"
          data-testid="mailbox-close"
          aria-label="关闭待办"
          onClick={onClose}
          className="shell-nav-row shell-focusable rounded-lg px-2 py-1 text-base leading-none"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      {section === 'pending' ? (
        <nav aria-label={t.sections} className="mt-3 flex items-center gap-4 border-b border-[var(--shell-hairline)]">
          <button
            type="button"
            aria-current="page"
            onClick={onBack}
            id="mailbox-tab-needs-me"
            className="shell-focusable flex items-center gap-2 border-b-2 border-[var(--shell-primary-text)] pb-2 text-sm font-medium"
            data-testid="mailbox-tab-needs-me"
          >
            {t.needsMe}
            {total !== null ? (
              <span
                className="rounded-full px-[7px] text-label font-semibold"
                data-testid="mailbox-tab-count"
                style={{ background: 'var(--shell-primary-soft)', color: 'var(--shell-primary-text)' }}
              >
                {total}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={onOpenSchedule}
            disabled={!onOpenSchedule}
            data-testid="mailbox-tab-schedule"
            className="shell-nav-row shell-focusable pb-2 text-sm"
          >
            {t.schedule}
          </button>
        </nav>
      ) : section === 'history' ? (
        <button
          type="button"
          onClick={onBack}
          data-testid="mailbox-handled-back"
          className="shell-nav-row shell-focusable mt-3 rounded-lg px-2 py-1 text-xs"
        >
          ‹ 返回待办
        </button>
      ) : null}
    </header>
  );
}
