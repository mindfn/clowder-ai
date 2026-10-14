import type { UnifiedAttentionReadV1 } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ApprovalSessions } from './mailbox/approval-sessions';
import { MailboxApprovalTools, MailboxSecondLayer } from './mailbox/MailboxApprovalTools';
import { MailboxMentionControls } from './mailbox/MailboxMentionControls';
import { MailboxMentionUndo } from './mailbox/MailboxMentionUndo';
import { MailboxPagination } from './mailbox/MailboxPagination';
import { MailboxPanelHeader } from './mailbox/MailboxPanelHeader';
import { MailboxRow } from './mailbox/MailboxRow';
import type { MailboxSection } from './mailbox/mailbox-navigation';
import { useMailboxRows } from './mailbox/mailbox-rows';
import type { OriginalPlace } from './mailbox/original-place';
import { RetainedResult } from './mailbox/RetainedResults';
import {
  MAILBOX_NAME,
  type MailboxState,
  mailboxPartialNote,
  mailboxStateText,
  sourceStatusText,
} from './unified-mailbox-state';
import type { UnifiedAttentionView } from './use-unified-attention';

const RAIL_WIDTH_FALLBACK = 52;
const PANEL_WIDTH = 440;
const MUTED = { color: 'var(--shell-muted)' } as const;

function SourceNotes({ read }: { read: UnifiedAttentionReadV1 }) {
  const notes = [
    { id: 'approvals', label: '审批', text: sourceStatusText(read.sources.approvals) },
    { id: 'needs-me', label: '等你判断或修复', text: sourceStatusText(read.sources.needsMe) },
    ...(read.sources.userMentions
      ? [{ id: 'user-mentions', label: '@你', text: sourceStatusText(read.sources.userMentions) }]
      : []),
  ].filter((note) => note.text !== null);
  if (notes.length === 0) return null;
  return (
    <ul className="m-0 mb-1 list-none px-1 p-0 text-xs" style={MUTED}>
      {notes.map((note) => (
        <li key={note.id} data-testid={`mailbox-source-note-${note.id}`}>
          {note.label}：{note.text}
        </li>
      ))}
    </ul>
  );
}

/** What the read says about itself above the rows: its state, which side is missing, and that rows may be the previous read. */
function ReadNotes({
  state,
  read,
  stale,
}: {
  state: MailboxState;
  read: UnifiedAttentionReadV1 | null;
  stale: boolean;
}) {
  const scopedKind =
    read?.mentionPeriod === 'handled' ? '已处理请求' : read?.mentionPeriod === 'earlier' ? '更早的请求' : null;
  const emptyPending = state.kind === 'empty' && read?.mentionPeriod !== 'handled' && (read?.totalCount ?? 0) === 0;
  const label = scopedKind
    ? `${read?.totalCount === undefined ? '部分' : read.totalCount} 条${scopedKind}`
    : mailboxStateText(state);
  const partialNote = read && state.kind === 'partial' ? mailboxPartialNote(read) : null;
  return (
    <>
      <div className="pb-1.5 text-xs" style={MUTED} data-testid="mailbox-state-text">
        {emptyPending ? (
          <p className="m-0 py-2 text-sm" data-testid="mailbox-empty">
            暂无待办
          </p>
        ) : (
          label
        )}
      </div>
      {read ? <SourceNotes read={read} /> : null}
      {partialNote ? (
        <p className="m-0 pb-1 text-xs" style={MUTED} data-testid="mailbox-partial-note">
          {partialNote}
        </p>
      ) : null}
      {stale ? (
        <p className="m-0 pb-1 text-xs" style={MUTED} data-testid="mailbox-stale-note">
          上次读到的内容，正在更新
        </p>
      ) : null}
    </>
  );
}

/** The panel docks against the rail's right edge; without a rail in the tree (a bare unit render) it uses the rail's width. */
function useRailEdge(anchor: React.RefObject<HTMLElement | null>): number | null {
  const [edge, setEdge] = useState<number | null>(null);
  useEffect(() => {
    const rail = anchor.current?.closest('[data-testid="world-rail"]');
    setEdge(Math.round(rail?.getBoundingClientRect().right || RAIL_WIDTH_FALLBACK));
  }, [anchor]);
  return edge;
}

/** A nested dialog (for example a card's reject-feedback dialog) owns Escape while it is open. */
function useEscapeToClose(panel: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const otherDialog = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].some(
        (dialog) => dialog !== panel.current,
      );
      if (!otherDialog) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [panel, onClose]);
}

/** Which row is open. A row that left the read is forgotten, not merely hidden: if a later read brings it back it starts closed. */
function useOpenRow(keys: string[], loading: boolean) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const keysSignature = keys.join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keysSignature stands for keys
  useEffect(() => {
    if (!loading) setExpandedKey((current) => (current !== null && !keys.includes(current) ? null : current));
  }, [keysSignature, loading]);
  const openKey = expandedKey !== null && (loading || keys.includes(expandedKey)) ? expandedKey : null;
  return { openKey, toggle: (key: string) => setExpandedKey(openKey === key ? null : key) };
}

/**
 * What the panel shows, and whose it is. While re-reading, the previous rows may stay visible, but only labelled as the
 * previous read — never as current. The owner is the read's verified identity (a previous read is shown only once its owner is
 * confirmed again); with no read to confirm one there is no owner, and so nothing that belongs to an owner is shown.
 */
function panelRows(view: UnifiedAttentionView, sessions: ApprovalSessions) {
  const read = view.result.kind === 'ok' ? view.result.read : null;
  const staleRead = view.result.kind === 'loading' ? view.staleRead : null;
  const shown = read ?? staleRead;
  const items = shown?.items ?? [];
  const ownerUserId = shown?.identity.ownerUserId ?? null;
  return {
    read,
    staleRead,
    items,
    ownerUserId,
    hosted: ownerUserId !== null ? { sessions, ownerUserId } : undefined,
  };
}

/**
 * 待办 as a full-height panel that slides out beside the rail (Café 1.6). It is non-modal: it stays until it is closed
 * (×, Escape, the rail button again) and the work area behind it keeps working, so a click elsewhere does not dismiss it
 * (the design owner's call). A dialog opened by a card inside it must take Escape first and must never unmount the panel or
 * lose a draft; that is proven where such cards are hosted (S3-2b), not here. Handled requests have their own page; approval records stay in the existing approval consumer.
 */
export function MailboxPanel({
  anchor,
  state,
  view,
  sessions,
  onOpenPlace,
  onClose,
  section = 'pending',
  onSectionChange,
  selectedProposalId = null,
  onOpenSchedule,
}: {
  anchor: React.RefObject<HTMLButtonElement | null>;
  state: MailboxState;
  view: UnifiedAttentionView;
  /** Where decisions made on an approval's original card are followed (kept by the rail button, so they outlive this panel). */
  sessions: ApprovalSessions;
  onOpenPlace: (place: OriginalPlace) => void;
  onClose: () => void;
  section?: MailboxSection;
  onSectionChange?: (section: MailboxSection) => void;
  selectedProposalId?: string | null;
  onOpenSchedule?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const left = useRailEdge(anchor);

  const mentionOwner = useRef<string | null>(null);
  const { read, staleRead, items, ownerUserId, hosted } = panelRows(view, sessions);
  if (ownerUserId !== null) mentionOwner.current = ownerUserId;
  else if (view.result.kind === 'failed') mentionOwner.current = null;
  const allRows = useMailboxRows(items, sessions, ownerUserId);
  const rows =
    section === 'history' ? allRows.filter((row) => row.kind === 'item' && row.item.kind === 'user_mention') : allRows;
  const keys = rows.map((row) => row.key);
  const { openKey, toggle } = useOpenRow(keys, view.result.kind === 'loading');
  const canRetry =
    state.kind === 'unavailable' || state.kind === 'partial' || (state.kind === 'has-items' && state.partial);
  // The panel counts the entire authoritative read; the rail separately counts only decisions.
  const total = state.kind === 'has-items' ? state.count : null;

  // A hidden element can't take focus, so move focus in only once the panel is positioned and visible.
  useEffect(() => {
    if (left === null) return;
    const first =
      panelRef.current?.querySelector<HTMLElement>('[data-testid="mailbox-item-toggle"]:not(:disabled)') ??
      panelRef.current?.querySelector<HTMLElement>('[data-testid="mailbox-close"]');
    (first ?? panelRef.current)?.focus();
  }, [left]);
  useEscapeToClose(panelRef, onClose);
  const handledSelection = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedProposalId) {
      handledSelection.current = null;
      return;
    }
    if (handledSelection.current === selectedProposalId) return;
    const row = rows.find((row) => row.kind === 'item' && row.item.approval?.proposalId === selectedProposalId);
    if (row) {
      handledSelection.current = selectedProposalId;
      if (openKey !== row.key) toggle(row.key);
    }
  }, [selectedProposalId, rows, openKey, toggle]);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={MAILBOX_NAME}
      tabIndex={-1}
      data-testid="mailbox-panel"
      className="shell-slide-in fixed bottom-0 top-0 z-[90] flex flex-col outline-none"
      style={{
        left: left ?? RAIL_WIDTH_FALLBACK,
        width: `min(${PANEL_WIDTH}px, calc(100vw - ${left ?? RAIL_WIDTH_FALLBACK}px))`,
        visibility: left === null ? 'hidden' : 'visible',
        background: 'var(--shell-work)',
        borderRight: '1px solid var(--shell-hairline-strong)',
        boxShadow: '4px 0 10px rgb(20 20 19 / 0.08)',
        color: 'var(--shell-ink)',
      }}
    >
      <MailboxPanelHeader
        section={section}
        total={total}
        handled={read?.mentionCounts?.handled ?? null}
        onClose={onClose}
        onBack={() => onSectionChange?.('pending')}
        onOpenSchedule={onOpenSchedule}
      />
      {section === 'tools' && read !== null ? (
        <MailboxApprovalTools
          section={section}
          view={view}
          sessions={sessions}
          onOpenPlace={onOpenPlace}
          onBack={() => onSectionChange?.('pending')}
        />
      ) : (
        <div
          role="region"
          id="mailbox-tabpanel"
          aria-labelledby="mailbox-tab-needs-me"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[22px] pb-4"
        >
          <MailboxMentionUndo
            key={mentionOwner.current}
            owner={mentionOwner.current ?? undefined}
            visible={ownerUserId !== null && ownerUserId === mentionOwner.current}
            disabled={read === null}
          />
          {section === 'pending' ? <MailboxMentionControls key={mentionOwner.current} read={read} view={view} /> : null}
          <ReadNotes state={state} read={read} stale={staleRead !== null} />
          {rows.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {rows.map((row) =>
                row.kind === 'retained' ? (
                  <RetainedResult key={row.key} session={row.session} sessions={sessions} />
                ) : (
                  <MailboxRow
                    key={row.key}
                    item={row.item}
                    rowKey={row.key}
                    stale={staleRead !== null}
                    expanded={openKey === row.key}
                    onToggle={() => toggle(row.key)}
                    onOpen={onOpenPlace}
                    hosted={hosted}
                  />
                ),
              )}
            </ul>
          ) : null}
          <MailboxPagination read={read} onNextPage={view.nextPage} onPreviousPage={view.previousPage} />
          {canRetry ? (
            <div className="pt-1.5">
              <button
                type="button"
                onClick={view.refetch}
                data-testid="mailbox-retry"
                className="shell-nav-row shell-focusable rounded-lg px-2 py-1 text-xs"
              >
                重试
              </button>
            </div>
          ) : null}
          {onSectionChange && section === 'pending' ? (
            <MailboxSecondLayer disabled={read === null} onNavigate={onSectionChange} />
          ) : null}
        </div>
      )}
    </div>,
    document.body,
  );
}
