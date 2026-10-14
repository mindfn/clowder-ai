'use client';

import type { ReactNode, Ref } from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useChatHistory } from '@/hooks/useChatHistory';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { useConnectionStatus } from '@/hooks/useConnectionStatus';
import { useSendMessage } from '@/hooks/useSendMessage';
import { useThreadLiveness, useThreadMessages } from '@/hooks/useThreadScopedSelectors';
import { useChatStore } from '@/stores/chatStore';
import { computeCliDiagnosticsDedup } from '@/utils/cli-diagnostics-dedup';
import { computeScrollRecomputeSignal } from '@/utils/scrollRecomputeSignal';
import { ChatInput } from '../ChatInput';
import { ChatMessageRow } from '../ChatMessageRow';
import { ConnectionStatusBar } from '../ConnectionStatusBar';
import { buildChatTimelineProjectionKey } from '../chat-timeline-projection-key';
import { useCompanionConversation } from '../concierge/useCompanionConversation';
import { HubCatEditor } from '../HubCatEditor';
import { HubCoCreatorEditor } from '../HubCoCreatorEditor';
import { PawIcon } from '../icons/PawIcon';
import { MessageSelectionToolbar } from '../MessageSelectionToolbar';
import { messageMountPolicy } from '../message-mount-policy';
import { isMessageSelectableForBundle, MAX_SELECTED_MESSAGES } from '../message-selection';
import { ImportedSessionNotice } from '../new-conversation/ImportedSessionNotice';
import { collectExactLiveInvocationIds, collectSettlingInvocationIds } from '../queue-receipt-projection';
import { ReplyRecallRuntimeProvider } from '../reply-layers/ReplyRecallRuntimeProvider';
import { projectReplyHandoffs } from '../reply-layers/reply-handoff';
import { canRenderReplyLayers } from '../reply-layers/reply-presentation';
import type { CardConfirmationEntry } from '../rich/CardBlock';
import { useShellPresentation } from '../shell/shell-presentation';
import { ThreadComposerContext } from '../ThreadComposerContext';
import { TransferTargetPicker } from '../TransferTargetPicker';
import { VoteActiveBar } from '../VoteActiveBar';
import { ThreadChatHistoryNavigation } from './ThreadChatHistoryNavigation';
import { ThreadChatPendingMembers } from './ThreadChatPendingMembers';
import { useThreadChatRuntime } from './ThreadChatRuntimeProvider';
import { ThreadExecutionLayer } from './ThreadExecutionLayer';
import { type RegisterChatReadingPort, useThreadChatReadingPort } from './useThreadChatReadingPort';
import { useThreadChatSelection } from './useThreadChatSelection';

export type ThreadChatDensity = 'full' | 'compact';
export type ThreadChatPresentation = 'conversation' | 'composer-only';

function useThreadChatHistoryPresentation(presentation: ThreadChatPresentation) {
  const historyHostRef = useRef<HTMLDivElement>(null);
  const composerOnly = presentation === 'composer-only';
  useEffect(() => {
    const historyHost = historyHostRef.current;
    if (!historyHost) return;
    if (composerOnly) historyHost.setAttribute('inert', '');
    else historyHost.removeAttribute('inert');
  }, [composerOnly]);
  return { historyHostRef, composerOnly };
}

function historyHostClassName(composerOnly: boolean): string {
  return `relative min-h-0 flex-1 overflow-hidden ${composerOnly ? 'invisible pointer-events-none' : ''}`;
}

function footerClassName(compact: boolean, composerOnly: boolean): string | undefined {
  return compact || composerOnly
    ? 'relative z-10 border-t border-cafe-divider bg-cafe-surface pointer-events-auto'
    : undefined;
}

export type ThreadChatActivity = {
  threadId: string;
  messageCount: number;
  hasActiveInvocation: boolean;
};

export interface ThreadChatSurfaceProps {
  threadId: string;
  density: ThreadChatDensity;
  presentation?: ThreadChatPresentation;
  emptyState?: ReactNode;
  timelineLead?: ReactNode;
  footerLead?: ReactNode;
  footerTail?: ReactNode;
  footerRef?: Ref<HTMLDivElement>;
  composerClassName?: string;
  composerPlaceholder?: string;
  composerSeed?: { id: string; text: string };
  messageConfirmations?: ReadonlyMap<string, CardConfirmationEntry[]>;
  acceptUnscopedInteractiveSend?: boolean;
  onComposerFocusChange?: (focused: boolean) => void;
  onActivity?: (activity: ThreadChatActivity) => void;
  onReadingPort?: RegisterChatReadingPort;
}

export function ThreadChatSurface({
  threadId,
  density,
  presentation = 'conversation',
  emptyState,
  timelineLead,
  footerLead,
  footerTail,
  footerRef,
  composerClassName,
  composerPlaceholder,
  composerSeed,
  messageConfirmations,
  acceptUnscopedInteractiveSend = false,
  onComposerFocusChange,
  onActivity,
  onReadingPort,
}: ThreadChatSurfaceProps) {
  const companion = useCompanionConversation(threadId);
  // The composer is told it is hosted with the one execution row only in the new shell (see ChatInput `presentation`).
  const composerPresentation = useShellPresentation();
  const [pianoReady, setPianoReady] = useState(false);
  const messages = useThreadMessages(threadId);
  const liveness = useThreadLiveness(threadId);
  const { hasActive: hasActiveInvocation, activeInvocations, catInvocations } = liveness;
  const { socketConnected } = useThreadChatRuntime([threadId]);
  const history = useChatHistory(threadId);
  const {
    handleScroll,
    jumpToLatest,
    jumpToMessage,
    beginUserScroll,
    scrollContainerRef,
    messagesEndRef,
    isLoadingHistory,
    hasMore,
  } = history;
  useThreadChatReadingPort(threadId, presentation, onReadingPort, history);
  const { handleSend, uploadStatus, uploadError } = useSendMessage(threadId);
  const interactiveSendContext = `thread-chat-surface:${useId()}`;
  const { getCatById, refresh: refreshCats } = useCatData();
  const coCreator = useCoCreatorConfig();
  const [editingCatId, setEditingCatId] = useState<string | null>(null);
  const [coCreatorEditorOpen, setCoCreatorEditorOpen] = useState(false);
  const editingCat = editingCatId ? (getCatById(editingCatId) ?? null) : null;
  const connectionStatus = useConnectionStatus(socketConnected);
  const uiThinkingExpandedByDefault = useChatStore((state) => state.uiThinkingExpandedByDefault);
  const isOfflineSnapshot = useChatStore((state) => state.isOfflineSnapshot);
  const { historyHostRef, composerOnly } = useThreadChatHistoryPresentation(presentation);
  const compact = density === 'compact';

  const settlingInvocationIds = useMemo(
    () => collectSettlingInvocationIds(activeInvocations, catInvocations),
    [activeInvocations, catInvocations],
  );
  const activeInvocationIds = useMemo(
    () => collectExactLiveInvocationIds(activeInvocations, catInvocations),
    [activeInvocations, catInvocations],
  );
  const cliDedupMap = useMemo(() => computeCliDiagnosticsDedup(messages), [messages]);
  const timelineProjectionKey = useMemo(() => buildChatTimelineProjectionKey(messages, threadId), [messages, threadId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: projection key captures the cross-message fields consumed by rows.
  const timelineProjectionMessages = useMemo(
    () => messages,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timelineProjectionKey],
  );
  const replyHandoffTimeline = useMemo(
    () =>
      projectReplyHandoffs(timelineProjectionMessages, (message) =>
        canRenderReplyLayers(message, {
          shellPresentation: composerPresentation,
          compact,
          getCatById,
          currentThreadId: threadId,
        }),
      ),
    [compact, composerPresentation, getCatById, threadId, timelineProjectionMessages],
  );
  const selection = useThreadChatSelection(messages);
  const handleEditCat = useCallback((catId: string) => setEditingCatId(catId), []);
  const handleEditCoCreator = useCallback(() => setCoCreatorEditorOpen(true), []);
  const projectedEmptyState = emptyState ?? (
    <div className={density === 'compact' ? 'mt-4 text-center' : 'mt-20 text-center'}>
      <PawIcon className="mx-auto mb-3 h-10 w-10 text-cafe-muted" />
      <p className="text-sm text-cafe-secondary">还没有消息，发一句试试吧</p>
    </div>
  );

  useEffect(() => {
    onActivity?.({ threadId, messageCount: messages.length, hasActiveInvocation });
  }, [hasActiveInvocation, messages.length, onActivity, threadId]);

  useEffect(() => {
    const handleInteractiveSend = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; sendContext?: string; targetThreadId?: string }>).detail;
      const ownsContext = detail.sendContext === interactiveSendContext;
      const ownsUnscoped =
        acceptUnscopedInteractiveSend &&
        !detail.sendContext &&
        (!detail.targetThreadId || detail.targetThreadId === threadId);
      if ((!ownsContext && !ownsUnscoped) || !detail.text) return;
      handleSend(detail.text);
    };
    window.addEventListener('cat-cafe:interactive-send', handleInteractiveSend);
    return () => window.removeEventListener('cat-cafe:interactive-send', handleInteractiveSend);
  }, [acceptUnscopedInteractiveSend, handleSend, interactiveSendContext, threadId]);

  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      data-thread-chat-surface
      data-thread-chat-density={density}
      data-thread-id={threadId}
    >
      {!composerOnly && companion.header}
      <div
        ref={historyHostRef}
        className={historyHostClassName(composerOnly)}
        aria-hidden={composerOnly || undefined}
        data-thread-chat-history
      >
        <main
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className={
            composerPresentation === 'v2'
              ? compact
                ? 'h-full overflow-y-auto pl-3 pr-[42px] py-3'
                : 'h-full overflow-y-auto p-4 pr-10'
              : compact
                ? 'h-full overflow-y-auto px-3 py-3'
                : 'h-full overflow-y-auto p-4'
          }
          tabIndex={composerPresentation === 'v2' ? -1 : undefined}
          data-message-piano-ready={(composerPresentation === 'v2' && pianoReady) || undefined}
          aria-label="对话内容"
          data-guide-id="bootcamp.preview-result"
          data-bootcamp-host="chat-messages"
          data-chat-container
        >
          <div
            data-thread-chat-reading-column
            className={composerPresentation === 'v2' && !compact ? 'mx-auto w-full max-w-[720px]' : ''}
          >
            {isLoadingHistory && <div className="py-3 text-center text-sm text-cafe-muted">加载历史消息...</div>}
            <ConnectionStatusBar
              api={connectionStatus.api}
              socket={connectionStatus.socket}
              upstream={connectionStatus.upstream}
              isReadonly={connectionStatus.isReadonly}
              checkedAt={connectionStatus.checkedAt}
              isOfflineSnapshot={isOfflineSnapshot}
            />
            {composerPresentation === 'v2' && !compact && <ImportedSessionNotice threadId={threadId} />}
            {timelineLead}
            {!hasMore && messages.length > 0 && (
              <div className="py-3 text-center text-xs text-cafe-muted">没有更多消息了</div>
            )}
            <ReplyRecallRuntimeProvider enabled={composerPresentation === 'v2'} threadId={threadId} messages={messages}>
              {messages.length === 0 && !isLoadingHistory
                ? projectedEmptyState
                : messages.map((message, index) => {
                    const dedupInfo = cliDedupMap.get(message.id);
                    const mountPolicy = messageMountPolicy(index, messages.length);
                    const selected = selection.selectedMessageIds.has(message.id);
                    const selectionEligible =
                      isMessageSelectableForBundle(message) &&
                      (!selection.selectionMode ||
                        selected ||
                        selection.selectedMessageIds.size < MAX_SELECTED_MESSAGES);
                    return (
                      <ChatMessageRow
                        key={message.id}
                        message={message}
                        compact={compact}
                        threadId={threadId}
                        timelineMessages={timelineProjectionMessages}
                        replyHandoffTimeline={replyHandoffTimeline}
                        settlingInvocationIds={message.extra?.queueReceipt ? settlingInvocationIds : undefined}
                        activeInvocationIds={message.extra?.queueReceipt ? activeInvocationIds : undefined}
                        getCatById={getCatById}
                        onEditCat={handleEditCat}
                        onEditCoCreator={handleEditCoCreator}
                        hideDiagnosticsPanel={dedupInfo?.hideDiagnosticsPanel}
                        dedupCount={dedupInfo?.dedupCount}
                        selectionMode={selection.selectionMode}
                        selected={selected}
                        selectionEligible={selectionEligible}
                        onEnterSelection={selection.enterMessageSelection}
                        onToggleSelection={selection.toggleMessageSelection}
                        forwardingDisabled={connectionStatus.forwardingBlocked}
                        eager={mountPolicy.eager}
                        backgroundMountDelayMs={mountPolicy.backgroundMountDelayMs}
                        sendContext={interactiveSendContext}
                        confirmations={messageConfirmations?.get(message.id)}
                      />
                    );
                  })}
              <ThreadChatPendingMembers threadId={threadId} messages={messages} liveness={liveness} />
            </ReplyRecallRuntimeProvider>
            <div ref={messagesEndRef} />
          </div>
        </main>
        <ThreadChatHistoryNavigation
          visible={!composerOnly}
          bottomProps={{
            scrollContainerRef,
            messagesEndRef,
            onJumpToLatest: jumpToLatest,
            recomputeSignal: computeScrollRecomputeSignal(threadId, messages, uiThinkingExpandedByDefault ? 1 : 0),
            observerKey: `${threadId}:${density}`,
          }}
          navigatorProps={{
            messages,
            scrollContainerRef,
            onJumpToMessage: jumpToMessage,
            beginUserScroll,
            compact,
            hasMore,
            observerKey: `${threadId}:${density}`,
            onTrackReadyChange: setPianoReady,
          }}
        />
      </div>

      <div ref={footerRef} className={footerClassName(compact, composerOnly)} data-thread-chat-footer>
        <ThreadExecutionLayer threadId={threadId} />
        <VoteActiveBar threadId={threadId} onEnd={() => {}} />
        {footerLead}
        {selection.selectionMode ? (
          <MessageSelectionToolbar
            threadId={threadId}
            selectedMessageIds={selection.normalizedSelectedMessageIds}
            onCancel={selection.clearMessageSelection}
            onExportSuccess={selection.clearMessageSelection}
            forwardingDisabled={connectionStatus.forwardingBlocked}
            onForward={selection.openSelectionForward}
          />
        ) : (
          <div className={composerClassName}>
            <ChatInput
              key={threadId}
              presentation={composerPresentation}
              composerContext={
                composerPresentation === 'v2' ? <ThreadComposerContext threadId={threadId} /> : undefined
              }
              threadId={threadId}
              onSend={(content, images, whisper, deliveryMode, replyToId, messageDisposition, contextAttachments) =>
                handleSend(
                  content,
                  images,
                  undefined,
                  whisper,
                  deliveryMode,
                  replyToId,
                  messageDisposition,
                  contextAttachments,
                  { consumeComposerDraft: true },
                )
              }
              disabled={connectionStatus.isReadonly}
              hasActiveInvocation={hasActiveInvocation}
              uploadStatus={uploadStatus}
              uploadError={uploadError}
              placeholder={composerPlaceholder}
              seed={composerSeed ?? companion.composerSeed}
              onFocusChange={onComposerFocusChange}
            />
          </div>
        )}
        {footerTail}
        <TransferTargetPicker
          open={selection.selectionForwardOpen && !connectionStatus.forwardingBlocked}
          admissionBlocked={connectionStatus.forwardingBlocked}
          sourceThreadId={threadId}
          items={selection.selectedBundleItems}
          onClose={selection.closeSelectionForward}
          onSuccess={selection.clearMessageSelection}
        />
      </div>
      {editingCat && (
        <HubCatEditor
          open
          cat={editingCat}
          draft={null}
          onClose={() => setEditingCatId(null)}
          onSaved={async () => {
            await refreshCats();
            setEditingCatId(null);
          }}
        />
      )}
      <HubCoCreatorEditor
        open={coCreatorEditorOpen}
        coCreator={coCreator}
        onClose={() => setCoCreatorEditorOpen(false)}
        onSaved={() => setCoCreatorEditorOpen(false)}
      />
    </section>
  );
}
