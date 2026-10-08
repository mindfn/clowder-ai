'use client';
import type { ReactNode } from 'react';
import { resolveShellCopy } from '@/components/shell/shell-copy';
import { readShellLanguage } from '@/components/shell/shell-language';
import { workspaceChromeCopy } from '@/components/workbench/workspace-chrome.shell-copy';
import { FileIcon } from './FileIcons';
import { V2WorkspaceMenu } from './V2WorkspaceMenu';
import type { WorkspaceFileViewerProps } from './WorkspaceFileViewer.types';
import { WorkspaceToolbarButton as Button } from './WorkspaceToolbarButton';

export function fileReturnLabel(origin: WorkspaceFileViewerProps['navigationOrigin']): string {
  if (origin?.kind === 'meeting-transcript') return '‹ 会议伴随';
  if (origin?.kind === 'workspace-changes') return '‹ 变更';
  if (origin?.kind === 'workspace-home-search' || origin?.kind === 'workspace-tools-search')
    return `‹ ${resolveShellCopy(workspaceChromeCopy, readShellLanguage()).toolsSearch}`;
  if (origin?.kind === 'workspace-home-artifact')
    return `‹ ${resolveShellCopy(workspaceChromeCopy, readShellLanguage()).home}`;
  if (origin?.kind === 'chat-file-link') return '‹ 聊天';
  if (origin?.kind === 'workspace-document') return '‹ 文档';
  if (origin?.kind === 'artifact-list') return '‹ 作品';
  return '‹ 文件';
}

function fileChromeBackLabel(p: Pick<WorkspaceFileViewerProps, 'navigationOrigin' | 'showFileQuotes'>): string {
  return fileReturnLabel(p.navigationOrigin);
}

/** Presentation only: content, editing, speech, navigation and annotations retain their owners. */
export function V2WorkspaceFileChrome({
  props: p,
  listen,
  cache,
  onAsk,
}: {
  props: WorkspaceFileViewerProps;
  listen: ReactNode;
  cache: ReactNode;
  onAsk: () => void;
}) {
  const path = p.openFilePath ?? p.file.path;
  const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '根目录';
  const toggle =
    !p.editMode && (p.isMarkdown || p.isHtml || p.isJsx) ? (
      <Button
        onClick={p.isMarkdown ? p.onToggleMarkdownRendered : p.isHtml ? p.onToggleHtmlPreview : p.onToggleJsxPreview}
        title="切换渲染与源码"
        activeClass="bg-cafe-accent text-[var(--cafe-accent-foreground)] hover:bg-cafe-accent-hover"
        active={p.isMarkdown ? p.markdownRendered : p.isHtml ? p.htmlPreview : p.jsxPreview}
      >
        {p.isMarkdown
          ? p.markdownRendered
            ? '渲染'
            : '源码'
          : (p.isHtml ? p.htmlPreview : p.jsxPreview)
            ? '预览'
            : '源码'}
      </Button>
    ) : null;
  return (
    <div
      hidden={p.focusMode}
      className={`${p.focusMode ? 'hidden' : 'block'} v2-file-chrome shrink-0`}
      data-testid="v2-file-chrome"
    >
      {!p.nestedWork ? (
        <div
          className="flex h-9 min-w-0 items-center border-b border-cafe-subtle bg-cafe-surface/60"
          data-testid="v2-file-tabs"
        >
          {p.onBack && !p.treeVisible && (
            <button
              type="button"
              onClick={p.onBack}
              data-testid="v2-file-back"
              className="shrink-0 border-r border-cafe-subtle px-3 py-2 text-xs font-semibold text-cafe-secondary"
            >
              {fileChromeBackLabel(p)}
            </button>
          )}
          <div className="flex min-w-0 flex-1 overflow-x-auto scrollbar-none">
            {p.openTabs.map((tab) => (
              <div
                key={tab}
                className={`group flex max-w-56 shrink-0 items-center border-r border-cafe-subtle text-xs ${tab === path ? 'bg-cafe-surface text-cafe-black' : 'text-cafe-muted'}`}
              >
                <button
                  type="button"
                  onClick={() => p.setOpenFile(tab)}
                  title={tab}
                  className="flex min-w-0 items-center gap-1.5 py-2 pl-3"
                >
                  <FileIcon name={tab} />
                  <span className="truncate">{tab.split('/').at(-1)}</span>
                </button>
                <button
                  type="button"
                  aria-label={`关闭 ${tab.split('/').at(-1)}`}
                  className="mx-1 shrink-0 rounded px-1 hover:bg-cafe-surface-sunken"
                  onClick={() => p.closeTab(tab)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div
        role="toolbar"
        aria-label="文件操作"
        data-testid="workspace-file-toolbar"
        data-v2-workspace-menu-boundary=""
        className="flex h-10 min-w-0 items-center gap-2 border-b border-cafe-subtle bg-cafe-surface px-3"
      >
        <button
          type="button"
          onClick={p.onRevealInTree}
          disabled={!p.onRevealInTree}
          data-testid="v2-file-directory"
          title="在文件列表中显示"
          className="min-w-0 flex-1 truncate text-left text-xs text-cafe-muted"
        >
          {p.nestedWork ? path.split('/').at(-1) || path : directory}
        </button>
        {!p.nestedWork ? (
          <span className="shrink-0 text-micro text-cafe-muted">
            {p.file.size < 1024 ? `${p.file.size}B` : `${Math.round(p.file.size / 1024)}KB`}
          </span>
        ) : null}
        <span className="v2-file-view-toggle shrink-0">{toggle}</span>
        <Button
          onClick={onAsk}
          disabled={p.modificationDisabled || (p.onRequestModification ? p.editMode : false)}
          title="把这个文件交给当前对话，请猫修改"
        >
          请猫修改
        </Button>
        {p.collaborationAvailable && p.onOpenCollaboration && (
          <Button
            onClick={p.onOpenCollaboration}
            disabled={p.editMode}
            title={p.editMode ? '请先保存或退出编辑' : '打开此文件的批注'}
          >
            批注{p.annotationCount != null ? ` ${p.annotationCount}` : ''}
          </Button>
        )}
        {!p.isMarkdown && p.canEdit && (
          <Button onClick={p.onToggleEdit} active={p.editMode} title="编辑文件">
            {p.editMode ? '编辑中' : '编辑'}
          </Button>
        )}
        <span className="v2-file-listen shrink-0">{listen}</span>
        {p.nestedWork && p.onBack ? (
          <button
            type="button"
            className="shrink-0 rounded border border-cafe-subtle px-2 py-1 text-xs"
            data-testid="v2-file-back"
            onClick={p.onBack}
          >
            {fileReturnLabel(p.navigationOrigin)}
          </button>
        ) : null}
        <V2WorkspaceMenu
          width={160}
          trigger="更多 ▾"
          triggerProps={{
            title: '更多文件操作',
            className:
              'cursor-pointer list-none rounded px-2 py-1 text-xs text-cafe-secondary hover:bg-cafe-surface-sunken',
          }}
          panelClassName="flex flex-col items-stretch gap-1 p-2"
        >
          <span className="v2-file-menu-view">{toggle}</span>
          <span className="v2-file-menu-listen">{listen}</span>
          {p.isMarkdown && p.canEdit && (
            <Button onClick={p.onToggleEdit} active={p.editMode} title="编辑文件">
              {p.editMode ? '编辑中' : '编辑'}
            </Button>
          )}
          {cache}
          <Button
            onClick={() => void navigator.clipboard.writeText(p.file.content)}
            title={p.file.truncated ? '复制已加载内容' : '复制文件全文'}
          >
            {p.file.truncated ? '复制已加载内容' : '复制内容'}
          </Button>
          <Button
            onClick={() =>
              void navigator.clipboard.writeText(p.currentWorktree ? `${p.currentWorktree.root}/${path}` : path)
            }
            title="复制文件路径"
          >
            复制路径
          </Button>
          <Button onClick={() => p.revealInFinder(path)} title="在访达中显示">
            在访达中显示
          </Button>
          {p.navigationOrigin?.kind === 'chat-file-link' && p.onBack && (
            <Button onClick={p.onBack} title={`返回消息 ${p.navigationOrigin.messageId}`}>
              返回来源 · {p.navigationOrigin.messageId}
            </Button>
          )}
        </V2WorkspaceMenu>
      </div>
    </div>
  );
}
