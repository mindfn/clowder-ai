import type { UnifiedAttentionReadV1 } from '@cat-cafe/shared';

export function MailboxPagination({
  read,
  onNextPage,
  onPreviousPage,
}: {
  read: UnifiedAttentionReadV1 | null;
  onNextPage?: () => void;
  onPreviousPage?: () => void;
}) {
  if (!read || (!read.page.hasMore && read.page.offset === 0)) return null;
  return (
    <div className="pt-2 text-xs">
      {read.page.hasMore ? (
        <p className="m-0 pb-1.5" style={{ color: 'var(--shell-muted)' }} data-testid="mailbox-has-more">
          还有更多事项，本页显示 {read.items.length} 件
        </p>
      ) : null}
      <nav aria-label="待办分页" className="flex items-center justify-between gap-2">
        <button
          type="button"
          data-testid="mailbox-previous-page"
          disabled={read.page.offset === 0 || !onPreviousPage}
          onClick={onPreviousPage}
          className="shell-nav-row shell-focusable rounded-lg px-2 py-1"
        >
          上一页
        </button>
        <span>第 {Math.floor(read.page.offset / read.page.limit) + 1} 页</span>
        <button
          type="button"
          data-testid="mailbox-next-page"
          disabled={!read.page.hasMore || !onNextPage}
          onClick={onNextPage}
          className="shell-nav-row shell-focusable rounded-lg px-2 py-1"
        >
          下一页
        </button>
      </nav>
    </div>
  );
}
