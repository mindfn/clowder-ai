import type { MessageQuoteSource } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import type { FileData, WorktreeEntry } from '@/hooks/useWorkspace';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import type { WorkspaceFileSave } from './workspace-file-draft';

/** A published copy has display bytes and its source, but no F063 locator or write/listen authority. */
export interface PublishedTextViewerProps {
  file: FileData;
  publication: { url: string; quoteSource?: MessageQuoteSource };
  onBack: () => void;
  reviewAction?: ReactNode;
}

export interface WorkspaceFileViewerProps {
  file: FileData;
  openFilePath: string | null;
  openTabs: string[];
  canEdit: boolean;
  editMode: boolean;
  isMarkdown: boolean;
  isHtml: boolean;
  isJsx: boolean;
  markdownRendered: boolean;
  htmlPreview: boolean;
  jsxPreview: boolean;
  saveError: string | null;
  scrollToLine: number | null;
  worktreeId: string | null;
  currentWorktree?: WorktreeEntry;
  setOpenFile: (path: string) => void;
  closeTab: (path: string) => void;
  onCloseCurrentTab: () => void;
  onToggleEdit: () => void;
  onToggleMarkdownRendered: () => void;
  onToggleHtmlPreview: () => void;
  onToggleJsxPreview: () => void;
  collaborationAvailable?: boolean;
  onOpenCollaboration?: () => void;
  onSave: WorkspaceFileSave;
  onDirtyChange?: (dirty: boolean) => void;
  pendingExternalSha?: string | null;
  onApplyExternalChange?: () => void;
  onDismissExternalChange?: () => void;
  revealInFinder: (path: string) => void;
  onFocusMode?: () => void;
  focusDisabled?: boolean;
  restoreScrollTop?: number | null;
  restoreKey?: string;
  onScrollTopChange?: (scrollTop: number) => void;
  focusMode?: boolean;
  navigationOrigin?: WorkspaceFileNavigationOrigin;
  onBack?: () => void;
  onRevealInTree?: () => void;
  annotationCount?: number | null;
  treeVisible?: boolean;
  onRequestModification?: () => void;
  modificationDisabled?: boolean;
  onQuoteSelected?: (quote: string) => void;
  showFileQuotes?: boolean;
  /** The Workspace working set already presents the file tab. */
  nestedWork?: boolean;
}
