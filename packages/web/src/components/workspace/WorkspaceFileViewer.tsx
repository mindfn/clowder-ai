'use client';

import { useCallback, useRef, useState } from 'react';
import { createFileContextAttachment, createQuoteContextAttachment } from '@/components/chat-context-reference';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { useShellPresentation } from '../shell/shell-presentation';
import { ClassicWorkspaceFileChrome } from './ClassicWorkspaceFileChrome';
import { FileContentRenderer } from './FileContentRenderer';
import { PublishedTextFileChrome } from './PublishedTextFileChrome';
import { type MarkdownSelectionAction, useMarkdownSelectionAction } from './useMarkdownSelectionAction';
import { useWorkspaceListenMode } from './useWorkspaceListenMode';
import { V2WorkspaceFileChrome } from './V2WorkspaceFileChrome';
import { WorkspaceFilePreviewDraftNotice } from './WorkspaceFileDraftNotice';
import type { PublishedTextViewerProps, WorkspaceFileViewerProps } from './WorkspaceFileViewer.types';
import { WorkspaceListenActions } from './WorkspaceListenActions';
import { addQuoteToChat, addWorkspaceFileQuoteToChat } from './workspace-file-quote';

export function WorkspaceFileViewer(props: WorkspaceFileViewerProps | PublishedTextViewerProps) {
  const published = 'publication' in props ? props : null;
  const workspace = 'publication' in props ? null : props;
  const { file } = props;
  const [rendered, setRendered] = useState(true);
  const {
    openFilePath,
    editMode,
    isMarkdown,
    markdownRendered,
    isHtml,
    isJsx,
    htmlPreview,
    jsxPreview,
    worktreeId,
    currentWorktree,
  } = workspace ?? {
    openFilePath: file.path,
    editMode: false,
    isMarkdown: /\.(md|markdown)$/i.test(file.path),
    markdownRendered: rendered,
    isHtml: false,
    isJsx: false,
    htmlPreview: false,
    jsxPreview: false,
    worktreeId: null,
    currentWorktree: undefined,
  };
  const quoteSource = published ? (published.publication.quoteSource ?? false) : undefined;
  const isV2 = useShellPresentation() === 'v2';
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const mdContainerRef = useRef<HTMLDivElement>(null);
  const mdSelectionAction = useMarkdownSelectionAction(
    mdContainerRef,
    isMarkdown && markdownRendered && !editMode && quoteSource !== false,
    openFilePath,
    // The loaded file's version, only when it is the file this tab names.
    file.path === openFilePath ? file.sha256 : null,
  );

  const handleMdAddToChat = useCallback(
    (action: MarkdownSelectionAction, comment: string) => {
      if (!openFilePath) return;
      if (quoteSource === false) return false;
      if (quoteSource) {
        if (quoteSource.artifactFile?.displayDigest !== `sha256:${action.version}`) return false;
        return (
          addQuoteToChat(
            currentThreadId,
            createQuoteContextAttachment(action.text, quoteSource, {
              comment,
              selectionStart: action.selectionStart,
              selectionEnd: action.selectionEnd,
            }),
          ).kind === 'added'
        );
      }
      const result = addWorkspaceFileQuoteToChat(currentThreadId, {
        text: action.text,
        comment,
        path: openFilePath,
        // The version the selected words were made in (taken with the selection), not the one on screen at save time.
        revision: action.version ?? null,
        worktreeId,
        branch: currentWorktree?.branch,
        language: 'markdown',
        selectionStart: action.selectionStart,
        selectionEnd: action.selectionEnd,
      });
      return result.kind === 'added';
    },
    [currentThreadId, currentWorktree, openFilePath, worktreeId, quoteSource],
  );

  const rawUrl = (path: string) =>
    published
      ? published.publication.url
      : `${API_URL}/api/workspace/file/raw?worktreeId=${encodeURIComponent(worktreeId ?? '')}&path=${encodeURIComponent(path)}`;
  const listenMode = useWorkspaceListenMode({
    file,
    openFilePath,
    worktreeId,
    enabled: !!workspace && isMarkdown && markdownRendered && !editMode && !file.truncated,
  });

  const handleAskCat = () => {
    if (!workspace) return;
    if (workspace.onRequestModification) return workspace.onRequestModification();
    if (!openFilePath) return;
    useChatStore.getState().setPendingChatInsert({
      threadId: currentThreadId,
      text: '请帮我修改这份文件：',
      contextAttachments: [createFileContextAttachment(openFilePath, worktreeId)],
    });
  };
  const listenProps = {
    active: listenMode.active,
    cache: listenMode.cache,
    hasSentences: listenMode.sentences.length > 0,
    onCancelCache: listenMode.cancelCache,
    onStartCache: listenMode.startCache,
    onStartListen: () => listenMode.start(),
  };
  const listenAvailable = !!workspace && isMarkdown && markdownRendered && !editMode;
  const listenAction = listenAvailable ? (
    <WorkspaceListenActions {...listenProps} action="listen" listenLabel="朗读" />
  ) : null;
  const cacheAction = listenAvailable ? <WorkspaceListenActions {...listenProps} action="cache" /> : null;

  return (
    <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col animate-fade-in" data-testid="workspace-file-viewer">
      {published ? (
        <PublishedTextFileChrome
          props={published}
          rendered={rendered}
          onToggle={isMarkdown ? () => setRendered((value) => !value) : undefined}
        />
      ) : workspace && isV2 ? (
        <V2WorkspaceFileChrome props={workspace} listen={listenAction} cache={cacheAction} onAsk={handleAskCat} />
      ) : workspace ? (
        <ClassicWorkspaceFileChrome props={workspace} listenMode={listenMode} />
      ) : null}

      {workspace?.saveError && (
        <div className="px-3 py-1.5 text-micro text-conn-red-text bg-[var(--semantic-critical-surface)] border-b border-[var(--semantic-critical)]">
          {workspace.saveError}
        </div>
      )}

      {workspace?.pendingExternalSha && (
        <div className="px-3 py-1.5 text-micro text-conn-amber-text bg-[var(--semantic-warning-surface)] border-b border-[var(--semantic-warning)] flex items-center justify-between">
          <span>文件已被外部修改</span>
          <span className="flex gap-2">
            <button
              type="button"
              onClick={workspace.onApplyExternalChange}
              className="underline hover:text-conn-amber-text"
            >
              重新加载
            </button>
            <button
              type="button"
              onClick={workspace.onDismissExternalChange}
              className="underline hover:text-conn-amber-text"
            >
              忽略
            </button>
          </span>
        </div>
      )}

      {/* File content */}
      {workspace &&
        !editMode &&
        ((isMarkdown && markdownRendered) || (isHtml && htmlPreview) || (isJsx && jsxPreview)) && (
          <WorkspaceFilePreviewDraftNotice
            worktreeId={worktreeId}
            path={file.path}
            sha256={file.sha256}
            content={file.content}
          />
        )}
      <FileContentRenderer
        file={file}
        openFilePath={openFilePath}
        isMarkdown={isMarkdown}
        isHtml={isHtml}
        isJsx={isJsx}
        markdownRendered={markdownRendered}
        htmlPreview={htmlPreview}
        jsxPreview={jsxPreview}
        editMode={editMode}
        scrollToLine={workspace?.scrollToLine ?? null}
        worktreeId={worktreeId}
        currentWorktree={currentWorktree}
        mdContainerRef={mdContainerRef}
        mdSelectionAction={mdSelectionAction}
        onMdAddToChat={handleMdAddToChat}
        onSave={workspace?.onSave}
        onDirtyChange={workspace?.onDirtyChange}
        rawUrl={rawUrl}
        revealInFinder={workspace?.revealInFinder}
        restoreScrollTop={workspace?.restoreScrollTop}
        restoreKey={workspace?.restoreKey}
        onScrollTopChange={workspace?.onScrollTopChange}
        listenSentences={listenMode.active ? listenMode.sentences : undefined}
        activeListenAnchor={listenMode.activeAnchor}
        onListenSentenceStart={listenMode.active ? listenMode.start : undefined}
        showFileQuotes={workspace?.showFileQuotes}
        onQuoteSelected={workspace?.onQuoteSelected}
        quoteSource={quoteSource}
        publishedQuoteSource={published?.publication.quoteSource}
      />

      {file.truncated && (
        <div className="px-3 py-1.5 text-micro text-conn-amber-text bg-[var(--ws-editor-bg)] border-t border-[var(--semantic-warning)]">
          文件已截断 (超过 1MB)
        </div>
      )}
    </div>
  );
}
