import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import type { ThreadState } from '@/stores/chat-types';
import { useLabelStore } from '@/stores/label-store';
import { API_URL } from '@/utils/api-client';
// F174 D2b-2 (rev): per-cat callback-auth dot was rejected (铲屎官 alpha 反馈
// "莫名其妙的颜色" — 16px participant avatars lacked any affordance). Status now
// surfaces system-level via <CallbackAuthHealthIndicator /> in ChatContainerHeader,
// and per-cat (with "AFFECTED CATS" affordance) inside HubCallbackAuthPanel.
import { CatAvatar } from '../CatAvatar';
import { HubIcon } from '../icons/HubIcon';
import { PawIcon } from '../icons/PawIcon';
import { ThreadCatStatus } from '../ThreadCatStatus';
import { ThreadCatSettings } from './ThreadCatSettings';
import { ThreadLabelPicker } from './ThreadLabelPicker';
import { formatRelativeTime } from './thread-utils';

export interface ThreadItemProps {
  id: string;
  title: string | null;
  participants: string[];
  lastActiveAt: number;
  isActive: boolean;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
  onRename?: (id: string, title: string) => void | Promise<void>;
  onTogglePin?: (id: string, pinned: boolean) => void | Promise<void>;
  onToggleFavorite?: (id: string, favorited: boolean) => void | Promise<void>;
  onUpdatePreferredCats?: (id: string, cats: string[]) => void | Promise<void>;
  onUpdateLabels?: (id: string, labels: string[]) => void | Promise<void>;
  isPinned?: boolean;
  isFavorited?: boolean;
  threadState?: ThreadState;
  indented?: boolean;
  preferredCats?: string[];
  threadLabels?: string[];
  isHubThread?: boolean;
}

export function ThreadItem({
  id,
  title,
  participants,
  lastActiveAt,
  isActive,
  onSelect,
  onDelete,
  onRename,
  onTogglePin,
  onToggleFavorite,
  onUpdatePreferredCats,
  onUpdateLabels,
  isPinned,
  isFavorited,
  threadState,
  indented,
  preferredCats,
  threadLabels,
  isHubThread,
}: ThreadItemProps) {
  const { getCatById } = useCatData();
  const canDelete = id !== 'default' && onDelete;
  const canRename = id !== 'default' && onRename;
  const canPin = id !== 'default' && onTogglePin;
  const canFavorite = id !== 'default' && onToggleFavorite;
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const ime = useIMEGuard();

  useEffect(() => {
    if (!isEditing) setDraftTitle(title ?? '');
  }, [title, isEditing]);

  useEffect(() => {
    if (!isEditing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isEditing]);

  useEffect(() => {
    if (isEditing) setIsMoreOpen(false);
  }, [isEditing]);

  useEffect(() => {
    if (!isMoreOpen) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (moreButtonRef.current?.contains(target) || moreMenuRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-thread-action-popover="true"]')) return;
      setIsMoreOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMoreOpen(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMoreOpen]);

  const submitRename = useCallback(async () => {
    if (!onRename) return;
    const next = draftTitle.trim();
    if (!next) {
      setDraftTitle(title ?? '');
      setIsEditing(false);
      return;
    }
    if (next === (title ?? '')) {
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    try {
      await onRename(id, next);
      setIsEditing(false);
    } finally {
      setIsSaving(false);
    }
  }, [onRename, draftTitle, title, id]);

  // Build hover tooltip: full title + participants + time (clowder-ai#29)
  const displayTitle = title ?? (id === 'default' ? '大厅' : '未命名对话');
  const hasDraft = !isActive && (threadState?.hasDraft ?? false);
  const participantNames = participants.map((catId) => getCatById(catId)?.displayName ?? catId).join(', ');
  const tooltipLines = [displayTitle];
  if (participantNames) tooltipLines.push(`参与: ${participantNames}`);
  tooltipLines.push(formatRelativeTime(lastActiveAt, false));
  const tooltip = tooltipLines.join('\n');
  const hasMoreActions = id !== 'default' && !isEditing;
  const menuTriggerClassName =
    'block w-full text-left px-3 py-1.5 text-xs text-cafe-secondary hover:bg-cafe-surface-elevated transition-colors';

  const startRename = useCallback(() => {
    setIsMoreOpen(false);
    setIsEditing(true);
  }, []);

  const exportThread = useCallback(() => {
    setIsMoreOpen(false);
    window.open(`${API_URL}/api/export/thread/${id}?format=md`);
  }, [id]);

  const toggleFavorite = useCallback(() => {
    if (!onToggleFavorite) return;
    setIsMoreOpen(false);
    void onToggleFavorite(id, !isFavorited);
  }, [id, isFavorited, onToggleFavorite]);

  return (
    <div
      data-thread-id={id}
      className={`group relative mx-2 rounded-xl ${indented ? 'pl-5 pr-3' : 'px-3'} py-2.5 transition-colors cursor-pointer ${
        isActive ? 'bg-[var(--console-active-bg)]' : 'hover:bg-[var(--console-hover-bg)]'
      }`}
      onClick={() => onSelect(id)}
      title={tooltip}
    >
      {/* Title row */}
      <div className="flex items-start justify-between gap-1 mb-1">
        {isEditing ? (
          <input
            ref={inputRef}
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !ime.isComposing()) {
                e.preventDefault();
                void submitRename();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setDraftTitle(title ?? '');
                setIsEditing(false);
              }
            }}
            onBlur={() => {
              void submitRename();
            }}
            disabled={isSaving}
            maxLength={200}
            className="text-sm px-1.5 py-0.5 rounded border border-cafe-subtle focus:outline-none focus:border-cafe-accent w-full mr-2 disabled:opacity-70"
          />
        ) : (
          <span
            className={`text-sm leading-snug line-clamp-2 flex-1 min-w-0 ${isActive ? 'font-semibold text-cafe-black' : 'text-cafe-secondary'}`}
          >
            {isHubThread && <HubIcon className="w-3.5 h-3.5 inline-block mr-1 text-cafe-accent align-text-bottom" />}
            {title ?? (id === 'default' ? '大厅' : '未命名对话')}
          </span>
        )}
        <div className="flex items-center gap-0.5 flex-shrink-0 mt-0.5">
          {/* Fixed thread actions: pin, delete, more. */}
          {canPin && !isEditing && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                void onTogglePin(id, !isPinned);
              }}
              className={`p-0.5 rounded transition-all ${
                isPinned
                  ? 'text-cafe-accent'
                  : 'opacity-0 group-hover:opacity-100 text-cafe-muted hover:text-cafe-accent'
              }`}
              title={isPinned ? '取消置顶' : '置顶'}
            >
              <PinIcon />
            </button>
          )}
          {canDelete && !isEditing && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(id);
              }}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-cafe-muted hover:bg-conn-red-bg hover:text-conn-red-text transition-all"
              title="删除对话"
            >
              <DeleteIcon />
            </button>
          )}
          {hasMoreActions && (
            <div className="relative">
              <button
                ref={moreButtonRef}
                onClick={(e) => {
                  e.stopPropagation();
                  setIsMoreOpen((open) => !open);
                }}
                className={`p-0.5 rounded transition-all ${
                  isMoreOpen
                    ? 'text-cafe-secondary bg-cafe-surface-elevated'
                    : 'opacity-0 group-hover:opacity-100 text-cafe-muted hover:text-cafe-secondary'
                }`}
                title="更多操作"
                aria-haspopup="menu"
                aria-expanded={isMoreOpen}
              >
                <MoreVerticalIcon />
              </button>
              {isMoreOpen && (
                <div
                  ref={moreMenuRef}
                  role="menu"
                  aria-label="对话操作"
                  className="absolute right-0 top-5 z-50 min-w-[144px] rounded-lg border border-cafe bg-cafe-surface py-1 shadow-lg"
                  onClick={(e) => e.stopPropagation()}
                >
                  {onUpdatePreferredCats && (
                    <ThreadCatSettings
                      threadId={id}
                      currentCats={preferredCats ?? []}
                      onSave={onUpdatePreferredCats}
                      triggerLabel="设置默认猫猫"
                      triggerClassName={menuTriggerClassName}
                      triggerRole="menuitem"
                    />
                  )}
                  {canRename && <ThreadActionMenuItem onClick={startRename}>重命名对话</ThreadActionMenuItem>}
                  <ThreadActionMenuItem onClick={exportThread}>导出对话</ThreadActionMenuItem>
                  {onUpdateLabels && (
                    <ThreadLabelPicker
                      threadId={id}
                      currentLabels={threadLabels ?? []}
                      onSave={onUpdateLabels}
                      triggerLabel="标签管理"
                      triggerClassName={menuTriggerClassName}
                      triggerRole="menuitem"
                    />
                  )}
                  {canFavorite && (
                    <ThreadActionMenuItem onClick={toggleFavorite}>
                      {isFavorited ? '取消收藏' : '收藏'}
                    </ThreadActionMenuItem>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {/* Bottom row: avatars + status + compact time */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          {participants.length > 0 ? (
            participants.map((catId) => <CatAvatar key={catId} catId={catId} size={16} />)
          ) : id !== 'default' ? (
            <>
              <PawIcon className="text-xs" />
              <span className="text-micro text-cafe-muted">还没有猫猫加入</span>
            </>
          ) : null}
          {preferredCats && preferredCats.length > 0 && (
            <div
              className="flex items-center gap-0.5 ml-1"
              title={`默认: ${preferredCats.map((id) => getCatById(id)?.displayName ?? id).join(', ')}`}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-2.5 w-2.5 text-cafe-muted shrink-0"
              >
                <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
              </svg>
              {preferredCats.map((catId) => (
                <span
                  key={catId}
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: getCatById(catId)?.color.primary ?? '#9CA3AF' }}
                />
              ))}
            </div>
          )}
          <LabelDots labels={threadLabels} />
          {threadState && (
            <ThreadCatStatus
              threadState={threadState}
              unreadCount={threadState.unreadCount}
              hasUserMention={threadState.hasUserMention}
            />
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {hasDraft && <span className="text-micro font-medium text-conn-red-text">[草稿]</span>}
          <span className="text-micro text-cafe-muted">{formatRelativeTime(lastActiveAt, true)}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Small icon components ───

function PinIcon() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
      <path d="M4.456 2.013a.75.75 0 011.06-.034l6.5 6a.75.75 0 01-.034 1.06l-1.99 1.838.637 3.22a.75.75 0 01-1.196.693L6.5 12.526l-2.933 2.264a.75.75 0 01-1.196-.693l.637-3.22-1.99-1.838a.75.75 0 01-.034-1.06l5.472-5.966z" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M5 3.25V4H2.75a.75.75 0 000 1.5h.3l.815 8.15A1.5 1.5 0 005.357 15h5.285a1.5 1.5 0 001.493-1.35l.815-8.15h.3a.75.75 0 000-1.5H11v-.75A2.25 2.25 0 008.75 1h-1.5A2.25 2.25 0 005 3.25zm2.25-.75a.75.75 0 00-.75.75V4h3v-.75a.75.75 0 00-.75-.75h-1.5z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function MoreVerticalIcon() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 4a1 1 0 110-2 1 1 0 010 2zm0 5a1 1 0 110-2 1 1 0 010 2zm0 5a1 1 0 110-2 1 1 0 010 2z" />
    </svg>
  );
}

function ThreadActionMenuItem({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="block w-full px-3 py-1.5 text-left text-xs text-cafe-secondary transition-colors hover:bg-cafe-surface-elevated"
    >
      {children}
    </button>
  );
}

function LabelDots({ labels }: { labels?: string[] }) {
  const { labels: allLabels } = useLabelStore();
  if (!labels || labels.length === 0) return null;
  const resolved = labels
    .map((id) => allLabels.find((l) => l.id === id))
    .filter((l): l is NonNullable<typeof l> => l !== undefined);
  if (resolved.length === 0) return null;
  const shown = resolved.slice(0, 2);
  const overflow = resolved.length - shown.length;
  return (
    <div className="flex items-center gap-0.5 ml-1" title={resolved.map((l) => l.name).join(', ')}>
      {shown.map((l) => (
        <span
          key={l.id}
          className="inline-flex items-center gap-0.5 rounded-full px-1 py-px text-micro leading-tight text-cafe-secondary"
          style={{ backgroundColor: `${l.color}18` }}
        >
          <span className="inline-block w-1 h-1 rounded-full flex-shrink-0" style={{ backgroundColor: l.color }} />
          <span className="max-w-[32px] truncate">{l.name}</span>
        </span>
      ))}
      {overflow > 0 && <span className="text-micro text-cafe-muted">+{overflow}</span>}
    </div>
  );
}
