import type { ReactNode } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { voiceMeetingCopy } from '@/components/workspace/voice-meeting.shell-copy';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { workspaceChromeCopy } from '../workspace-chrome.shell-copy';

export function ContentLandingHeader({
  title,
  navigationOrigin,
  onBack,
  onOpenFileTools,
  versionControl,
}: {
  readonly title: string;
  readonly navigationOrigin?: WorkspaceFileNavigationOrigin;
  readonly onBack?: () => void;
  readonly onOpenFileTools?: () => void;
  readonly versionControl?: ReactNode;
}) {
  const t = useShellCopy(voiceMeetingCopy);
  const workspace = useShellCopy(workspaceChromeCopy);
  return (
    // In a narrow column (side-by-side panes, 390px) the controls wrap onto a second line so the
    // title keeps at least ~8rem instead of shrinking to a single character.
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-cafe-subtle px-3 py-2">
      <h2 className="min-w-[8rem] flex-1 truncate text-sm font-semibold" title={title}>
        {title}
      </h2>
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
        {versionControl}
        {onOpenFileTools ? (
          <button
            type="button"
            onClick={onOpenFileTools}
            className="shrink-0 rounded-md px-2 py-1 text-xs text-cafe-muted hover:text-cafe"
          >
            文件工具
          </button>
        ) : null}
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="shrink-0 rounded-md px-2 py-1 text-xs text-cafe-muted hover:text-cafe"
          >
            {/* C 3480: a meeting-panel origin names its source explicitly (in the current shell language,
                since only the v2 meeting journey produces this origin) instead of the generic 返回来源. */}
            {navigationOrigin?.kind === 'meeting-transcript'
              ? `‹ ${t.meeting.title}`
              : navigationOrigin?.kind === 'workspace-tools-search'
                ? `‹ ${workspace.toolsSearch}`
                : navigationOrigin?.kind === 'workspace-home-artifact'
                  ? `‹ ${workspace.home}`
                  : navigationOrigin
                    ? '返回来源'
                    : '返回'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
