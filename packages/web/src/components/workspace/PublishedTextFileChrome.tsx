import { useShellCopy } from '../shell/shell-copy';
import { publishedTextCopy } from './published-text.shell-copy';
import type { PublishedTextViewerProps } from './WorkspaceFileViewer.types';
import { WorkspaceToolbarButton as Button } from './WorkspaceToolbarButton';

/** The existing reader's toolbar for a copy that has no workspace capabilities. */
export function PublishedTextFileChrome({
  props,
  rendered,
  onToggle,
}: {
  props: PublishedTextViewerProps;
  rendered: boolean;
  onToggle?: () => void;
}) {
  const t = useShellCopy(publishedTextCopy);
  return (
    <div className="shrink-0 border-b border-cafe-subtle bg-cafe-surface">
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <Button onClick={props.onBack} title={t.back}>
          {t.back}
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-cafe-secondary" title={props.file.path}>
          {props.file.path}
        </span>
        {props.reviewAction}
      </div>
      <div role="toolbar" aria-label={t.toolbar} className="flex min-w-0 items-center gap-2 overflow-x-auto px-3 pb-2">
        <span className="shrink-0 text-xs text-cafe-muted">{t.readonly}</span>
        {onToggle && (
          <Button onClick={onToggle} title={t.toggle}>
            {rendered ? t.source : t.rendered}
          </Button>
        )}
        <Button onClick={() => void navigator.clipboard.writeText(props.file.content)} title={t.copyTitle}>
          {t.copy}
        </Button>
        <a className="shrink-0 text-xs text-cafe-crosspost" href={props.publication.url} download={props.file.path}>
          {t.download}
        </a>
      </div>
    </div>
  );
}
