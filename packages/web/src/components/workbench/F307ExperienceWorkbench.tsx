'use client';

import { createMessagePublicationSurface } from './message-publication-surface';

/*
Architecture cell: hub-action-surface
Real-shell host for the shared F307 Workbench kernel.
*/

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ListenModePlayer } from '@/components/listen-mode/ListenModePlayer';
import { defaultSettingsSectionPath } from '@/components/settings/settings-entry-path';
import { resolveShellCopy, useShellCopy } from '@/components/shell/shell-copy';
import { readShellLanguage } from '@/components/shell/shell-language';
import { resolveShellNavTarget } from '@/components/shell/shell-navigation';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { useSettingsReadingEntry } from '@/components/shell/useSettingsSourceReturn';
import type {
  F284WorkspaceSnapshot,
  WorkbenchAction,
  WorkbenchLayoutState,
  WorkspaceSurfaceDescriptor,
} from '@/components/workbench/workbench-contract';
import { projectWorkbench } from '@/components/workbench/workbench-model';
import { voiceMeetingCopy } from '@/components/workspace/voice-meeting.shell-copy';
import type { WorkspaceDevSurface } from '@/components/workspace/WorkspaceLauncher';
import { canonicalLauncherDestination } from '@/components/workspace/WorkspaceLauncher';
import type { LauncherWorkspaceSearch } from '@/components/workspace/WorkspaceLauncherSearch';
import { useWorkspaceExecutionRequest } from '@/components/workspace-home/execution-detail-request';
import type { OpenHomeArtifact } from '@/components/workspace-home/HomeWorksSummary';
import { useCatData } from '@/hooks/useCatData';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import type { WorkspaceFileNavigationOrigin, WorkspaceOpenRequest } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { captureChatReadingBeforeLayoutChange } from '@/utils/chat-layout-change';
import { DEFAULT_ARTIFACT_WORK_CHAT_BASIS, isWorkspaceFullWindowSurface } from './artifact-work-presentation';
import { toggleArtifactWorkFullWindow } from './artifact-work-presentation-actions';
import { restoreEvolutionMediaOrigin } from './evolution-media-navigation';
import { useF307ExperienceWorkbenchStore } from './experience-workbench-store';
import { F307OwnerSurfaceRenderer } from './F307OwnerSurfaceRenderer';
import { F307MountedSurface } from './F307WorkbenchSidecar';
import { F307WorkbenchTabs } from './F307WorkbenchTabs';
import { F307WorkspaceHomePage } from './F307WorkspaceHomePage';
import { createPublicationSurface } from './publication-surface';
import {
  createArtifactSurface,
  createEvolutionProgramSurface,
  createFilePreviewSurface,
  createFileSurface,
  createFilesSurface,
  createPullRequestChangesSurface,
  createTeamWorkspaceSurface,
  createWorkspaceDestinationSurface,
  createWorkspaceModeSurface,
  resolveFileTarget,
} from './real-surface-adapters';
import { returnFileCard } from './return-file-card';
import type { ToolsReturnRequest } from './use-tools-viewport-return';
import { useWorkspaceDestinationAdmission } from './use-workspace-destination-admission';
import { WorkbenchToolsContent } from './WorkbenchToolsContent';
import { selectRecentSurfaces } from './workbench-recent-visits';
import { workspaceChromeCopy } from './workspace-chrome.shell-copy';
import { workspaceEntryTitle } from './workspace-entry-title';
import { workspaceFileReturnAction } from './workspace-file-return';
import { rememberWorkspaceForeground } from './workspace-presentation-lock';

function WorkbenchActivity({
  layout,
  dispatch,
  copy,
}: {
  layout: WorkbenchLayoutState;
  dispatch: (action: WorkbenchAction) => void;
  copy: typeof workspaceChromeCopy.zh;
}) {
  return layout.activity.map((item) => (
    <div
      key={item.id}
      className="flex shrink-0 items-center gap-3 border-b border-[var(--semantic-info)]/20 bg-[var(--semantic-info-surface)] px-3 py-2"
      data-testid={`f307-activity-${item.kind}`}
    >
      <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--semantic-info)]" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate text-xs text-cafe-secondary">{item.message}</p>
      {item.surface && (
        <button
          type="button"
          onClick={() => {
            if (!item.surface) return;
            dispatch({
              type: 'open-surface',
              surface: item.surface,
              entitlement: { kind: 'user', reason: 'surface-tab' },
            });
            dispatch({ type: 'dismiss-activity', activityId: item.id });
          }}
          className="text-xs font-semibold text-[var(--semantic-info)] hover:underline"
        >
          {copy.activity.view}
        </button>
      )}
      <button
        type="button"
        onClick={() => dispatch({ type: 'dismiss-activity', activityId: item.id })}
        className="flex h-6 w-6 items-center justify-center rounded-md text-cafe-muted hover:bg-cafe-surface"
        aria-label={copy.activity.dismiss}
      >
        <span className="h-3.5 w-3.5">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </span>
      </button>
    </div>
  ));
}

function RecentlyClosedSurfaces({
  layout,
  dispatch,
  onRestore,
  copy,
}: {
  layout: WorkbenchLayoutState;
  dispatch: (action: WorkbenchAction) => void;
  onRestore: () => void;
  copy: typeof workspaceChromeCopy.zh;
}) {
  const [expanded, setExpanded] = useState(false);
  if (layout.recentlyClosed.length === 0) return null;
  return (
    <aside
      className="shrink-0 border-t border-cafe-subtle bg-[var(--console-panel-bg)] px-3 py-2"
      data-testid="f307-recently-closed"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="rounded-lg px-2 py-1 text-micro font-semibold text-cafe-muted hover:bg-cafe-surface-sunken hover:text-cafe"
          aria-expanded={expanded}
          aria-label={expanded ? copy.recentlyClosed.collapse : copy.recentlyClosed.expand}
          data-testid="f307-recently-closed-toggle"
        >
          {copy.recentlyClosed.label(layout.recentlyClosed.length)}
        </button>
        {expanded &&
          layout.recentlyClosed.map((surface) => (
            <button
              key={surface.id}
              type="button"
              onClick={() => {
                dispatch({
                  type: 'restore-surface',
                  surfaceId: surface.id,
                  entitlement: { kind: 'user', reason: 'recently-closed' },
                });
                setExpanded(false);
                onRestore();
              }}
              className="rounded-lg bg-cafe-surface-sunken px-2 py-1 text-micro font-semibold text-cafe-secondary hover:text-cafe"
              data-testid={`f307-restore-${surface.type}`}
            >
              {copy.recentlyClosed.restore(surface.title)}
            </button>
          ))}
      </div>
    </aside>
  );
}

function zeroTopologyContract(hydrated: boolean, zeroTopology: boolean, homeFocused: boolean): string {
  if (!hydrated) return 'pending-hydration';
  if (zeroTopology && homeFocused) return 'canonical-home';
  return 'not-applicable';
}

function useExplicitWorkspaceNavigation({
  dispatch,
  hydrated,
  isDesktop,
  layout,
  request,
  onConsumed,
  setHomeOpen,
  threadId,
}: {
  dispatch: (action: WorkbenchAction) => void;
  hydrated: boolean;
  isDesktop: boolean;
  layout: WorkbenchLayoutState;
  request?: WorkspaceOpenRequest | null;
  onConsumed?: (revision: number) => void;
  setHomeOpen: (open: boolean) => void;
  threadId?: string;
}) {
  const consumedRevision = useRef(0);
  const { getCatById } = useCatData();
  const previewEnabled = useShellPresentation() === 'v2';
  const entryCopy = useShellCopy(workspaceChromeCopy);
  useEffect(() => {
    if (
      !hydrated ||
      !request ||
      request.revision <= consumedRevision.current ||
      (request.threadId && request.threadId !== threadId)
    ) {
      return;
    }
    const surface =
      request.target.kind === 'message-publication'
        ? createMessagePublicationSurface(request.target.source, request.target.title)
        : request.target.kind === 'publication'
          ? createPublicationSurface(request.target)
          : request.target.kind === 'team'
            ? createTeamWorkspaceSurface({ threadId, subject: request.target.subject })
            : request.target.kind === 'evolution-program'
              ? createEvolutionProgramSurface(request.target.programId)
              : request.target.kind === 'artifact'
                ? createArtifactSurface({
                    threadId: request.threadId,
                    artifact: request.target.artifact,
                    navigationOrigin: request.target.navigationOrigin,
                  })
                : request.target.kind === 'file'
                  ? (previewEnabled ? createFilePreviewSurface : createFileSurface)({
                      worktreeId: request.target.worktreeId,
                      path: request.target.path,
                      scrollToLine: request.target.line ?? null,
                      navigationOrigin: request.target.navigationOrigin,
                    })
                  : request.target.kind === 'reveal'
                    ? createFilesSurface(request.target.worktreeId, {
                        reveal: { path: request.target.path, request: request.revision },
                        navigationOrigin: request.target.navigationOrigin,
                        repoRoot: request.target.repoRoot,
                      })
                    : createWorkspaceModeSurface(request.target.mode, threadId);
    const chat = useChatStore.getState();
    const source =
      request.target.kind === 'message-publication'
        ? request.target.source
        : request.target.kind === 'publication'
          ? request.target.messagePublicationSource
          : undefined;
    const messages =
      source?.threadId === chat.currentThreadId
        ? chat.messages
        : source
          ? (chat.threadStates[source.threadId]?.messages ?? [])
          : [];
    const entryTitle = workspaceEntryTitle(
      request.target,
      messages,
      (id) => resolveCatDisplayName(id, getCatById),
      entryCopy.image,
    );
    if (entryTitle) surface.title = entryTitle;
    if (isDesktop && request.target.kind === 'mode' && request.target.mode === 'product-schedule')
      captureChatReadingBeforeLayoutChange();
    consumedRevision.current = request.revision;
    const fileTarget = previewEnabled && request.target.kind === 'file' ? resolveFileTarget(surface) : null;
    const existing = layout.surfaces.find((candidate) => {
      if (candidate.id === surface.id) return true;
      if (!fileTarget) return false;
      const file = resolveFileTarget(candidate);
      return !!file && file.worktreeId === fileTarget.worktreeId && file.path === fileTarget.path;
    });
    // Reopening an exact old root-scoped file updates its coordinates without migrating its permanent identity.
    if (fileTarget && existing) {
      surface.id = existing.id;
      surface.objectRef = existing.objectRef;
    }
    // A reveal is an action on the tree, so asking again re-runs it even when the same tree is showing.
    const alreadyFocused =
      request.target.kind !== 'reveal' &&
      layout.activeSurfaceId === surface.id &&
      existing?.ownerStateRef.key === surface.ownerStateRef.key &&
      existing?.resultTargetRef?.owner === surface.resultTargetRef?.owner &&
      existing?.resultTargetRef?.key === surface.resultTargetRef?.key &&
      JSON.stringify(existing?.navigationOrigin) === JSON.stringify(surface.navigationOrigin) &&
      JSON.stringify(existing?.returnTargetRef) === JSON.stringify(surface.returnTargetRef);
    if (!alreadyFocused) {
      dispatch({
        type:
          previewEnabled &&
          request.disposition === 'preview' &&
          (request.target.kind === 'file' ||
            request.target.kind === 'artifact' ||
            request.target.kind === 'publication' ||
            request.target.kind === 'message-publication')
            ? 'open-preview-surface'
            : 'open-surface',
        surface,
        entitlement: { kind: 'user', reason: 'open-from-chat' },
        visitThreadId: request.threadId,
      });
    } else {
      dispatch({
        type: 'activate-surface',
        surfaceId: surface.id,
        entitlement: { kind: 'user', reason: 'open-from-chat' },
        visitThreadId: request.threadId,
      });
    }
    rememberWorkspaceForeground();
    setHomeOpen(false);
    if (request.target.kind === 'evolution-program') {
      useF307ExperienceWorkbenchStore.getState().enterMainAreaAttention(surface.id);
    } else if (isDesktop && threadId && request.target.kind === 'mode' && request.target.mode === 'product-schedule') {
      useF307ExperienceWorkbenchStore.getState().enterMainAreaAttention(surface.id, {
        kind: 'chat-workspace',
        threadId,
        chatBasis: DEFAULT_ARTIFACT_WORK_CHAT_BASIS,
      });
    }
    onConsumed?.(request.revision);
  }, [
    dispatch,
    hydrated,
    isDesktop,
    layout.activeSurfaceId,
    layout.surfaces,
    onConsumed,
    request,
    setHomeOpen,
    threadId,
    previewEnabled,
    getCatById,
    entryCopy.image,
  ]);
}

function ownerSurfaceVisible(
  workbenchVisible: boolean,
  homeFocused: boolean,
  visibleSurfaceIds: ReadonlySet<string>,
  surfaceId: string,
): boolean {
  return workbenchVisible && !homeFocused && visibleSurfaceIds.has(surfaceId);
}

function ownerSidecarVisible(
  workbenchVisible: boolean,
  homeFocused: boolean,
  mainAreaAttentionSurfaceId: string | null,
  focusSurfaceId: string | null,
): boolean {
  return workbenchVisible && !homeFocused && mainAreaAttentionSurfaceId === null && focusSurfaceId === null;
}

export function F307ExperienceWorkbench({
  foregroundSurfaceId,
  onOpenHome,
  threadId,
  defaultCatId = 'opus',
  visible = true,
  statusSurface,
  artifactWorkHostAvailable = false,
  onSelectDevSurface,
  f284WorkspaceState,
  worktreeId,
  canonicalWorktreeId,
  worktreeLoading = false,
  worktreeError = null,
  openFilePath,
  preview,
  repository,
  rootSelection,
  workspaceSearch,
  workspaceOpenRequest,
  onWorkspaceOpenRequestConsumed,
  onRestoreWorkspaceSearch,
  onReturnToChatMessage,
  onOpenAppRoute,
}: {
  foregroundSurfaceId?: string | null;
  onOpenHome?: () => void;
  threadId?: string;
  defaultCatId?: string;
  visible?: boolean;
  statusSurface?: ReactNode;
  artifactWorkHostAvailable?: boolean;
  onSelectDevSurface: (surface: WorkspaceDevSurface) => void;
  f284WorkspaceState?: F284WorkspaceSnapshot;
  worktreeId: string | null;
  canonicalWorktreeId?: string | null;
  worktreeLoading?: boolean;
  worktreeError?: string | null;
  openFilePath: string | null;
  preview: { port?: number; path: string };
  repository?: { name: string; branch: string };
  rootSelection?: import('./workspace-root-selection').WorkspaceRootSelection;
  workspaceSearch?: LauncherWorkspaceSearch;
  workspaceOpenRequest?: WorkspaceOpenRequest | null;
  onWorkspaceOpenRequestConsumed?: (revision: number) => void;
  onRestoreWorkspaceSearch?: (query: string) => void;
  onReturnToChatMessage?: (input: { threadId: string; messageId: string }) => void;
  /**
   * Leaves the workbench for another app route (e.g. a Settings file card). The host owns routing,
   * so the workbench kernel stays mountable outside the Next app router.
   */
  onOpenAppRoute: (href: string) => void;
}) {
  const isDesktop = useIsDesktop();
  const t = useShellCopy(workspaceChromeCopy);
  const [homeOpen, setHomeOpen] = useState(false);
  const [homeSearchQuery, setHomeSearchQuery] = useState('');
  const [toolsReturnRequest, setToolsReturnRequest] = useState<ToolsReturnRequest>();
  const toolsReturnSequence = useRef(0);
  const captureSettingsOrigin = useSettingsReadingEntry();
  const toolsScopeKey = JSON.stringify([threadId, worktreeId]);
  const previousToolsScope = useRef(toolsScopeKey);
  useEffect(() => {
    if (previousToolsScope.current === toolsScopeKey) return;
    previousToolsScope.current = toolsScopeKey;
    setToolsReturnRequest(undefined);
    setHomeSearchQuery('');
    setHomeSearchReturnOrigin(undefined);
  }, [toolsScopeKey]);
  const scopedToolsReturn =
    toolsReturnRequest?.threadId === threadId && toolsReturnRequest?.worktreeId === worktreeId
      ? toolsReturnRequest
      : undefined;

  const [homeSearchReturnOrigin, setHomeSearchReturnOrigin] = useState<
    Extract<WorkspaceFileNavigationOrigin, { kind: 'workspace-home-search' }> | undefined
  >();
  const [homeArtifactReturnOrigin, setHomeArtifactReturnOrigin] = useState<
    Extract<WorkspaceFileNavigationOrigin, { kind: 'workspace-home-artifact' }> | undefined
  >();
  useEffect(
    () => setHomeArtifactReturnOrigin((origin) => (origin?.threadId === threadId ? origin : undefined)),
    [threadId],
  );
  const layout = useF307ExperienceWorkbenchStore((state) => state.layout);
  const hydrated = useF307ExperienceWorkbenchStore((state) => state.hydrated);
  const dispatch = useF307ExperienceWorkbenchStore((state) => state.dispatch);
  // This callback is supplied only to explicit controls, never to automatic foreground/lock binding.
  const dispatchInput = useCallback(
    (action: WorkbenchAction) => dispatch({ ...action, visitThreadId: threadId } as WorkbenchAction),
    [dispatch, threadId],
  );
  const hydrate = useF307ExperienceWorkbenchStore((state) => state.hydrate);
  const attentionPresentation = useF307ExperienceWorkbenchStore((state) => state.mainAreaAttentionPresentation);
  const mainAreaAttentionSurfaceId = useF307ExperienceWorkbenchStore((state) => state.mainAreaAttentionSurfaceId);
  const enterMainAreaAttention = useF307ExperienceWorkbenchStore((state) => state.enterMainAreaAttention);
  const exitMainAreaAttention = useF307ExperienceWorkbenchStore((state) => state.exitMainAreaAttention);
  const focusSurfaceId = useF307ExperienceWorkbenchStore((state) => state.focusSurfaceId);
  const enterFocusMode = useF307ExperienceWorkbenchStore((state) => state.enterFocusMode);
  const exitFocusMode = useF307ExperienceWorkbenchStore((state) => state.exitFocusMode);
  /*
  Architecture cell: hub-action-surface
  This is a transient projection, not a second owner store.
  */
  const artifactWorkPresentation = useF307ExperienceWorkbenchStore((state) => state.artifactWorkPresentation);

  useEffect(() => {
    if (!hydrated) hydrate(f284WorkspaceState);
  }, [f284WorkspaceState, hydrate, hydrated]);

  useEffect(() => {
    if (!isDesktop && mainAreaAttentionSurfaceId !== null) exitMainAreaAttention();
  }, [exitMainAreaAttention, isDesktop, mainAreaAttentionSurfaceId]);

  useExplicitWorkspaceNavigation({
    dispatch,
    hydrated,
    isDesktop,
    layout,
    request: workspaceOpenRequest,
    onConsumed: onWorkspaceOpenRequestConsumed,
    setHomeOpen,
    threadId,
  });

  const isV2 = useShellPresentation() === 'v2';
  const controlCopy = isV2 ? t : workspaceChromeCopy.zh;
  const projection = projectWorkbench(layout, isDesktop ? 1024 : 390);
  const zeroTopology = projection.visibleSurfaceIds.length === 0;
  const foregroundUnavailable =
    foregroundSurfaceId != null && !layout.surfaces.some((surface) => surface.id === foregroundSurfaceId);
  const homeFocused = homeOpen || zeroTopology || foregroundSurfaceId === null || foregroundUnavailable;
  const activeWorkspaceSurface = homeFocused
    ? undefined
    : layout.surfaces.find((surface) => surface.id === layout.activeSurfaceId);
  useEffect(() => {
    if (foregroundSurfaceId != null) setHomeOpen(false);
  }, [foregroundSurfaceId]);
  // A queued explicit request wins initial foreground restoration; a later foreground input still closes Home.
  useWorkspaceExecutionRequest(threadId, setHomeOpen);
  const topologyContract = zeroTopologyContract(hydrated, zeroTopology, homeFocused);
  const visibleSurfaceIds = new Set(
    focusSurfaceId !== null
      ? [focusSurfaceId]
      : mainAreaAttentionSurfaceId === null
        ? projection.visibleSurfaceIds
        : [mainAreaAttentionSurfaceId],
  );

  useEffect(() => {
    if (focusSurfaceId !== null && (!visible || homeFocused)) exitFocusMode();
  }, [exitFocusMode, focusSurfaceId, homeFocused, visible]);
  const openSurfaceIds = new Set([
    ...layout.surfaces.map((surface) => surface.id),
    ...(layout.sidecar ? [layout.sidecar.id] : []),
  ]);
  const hostedSurfaces = [
    ...layout.surfaces,
    ...(layout.sidecar && !layout.surfaces.some((surface) => surface.id === layout.sidecar?.id)
      ? [layout.sidecar]
      : []),
    ...layout.recentlyClosed.filter((surface) => surface.type !== 'thread-replay' && !openSurfaceIds.has(surface.id)),
  ];
  const openSurfaceFromOwner = (
    nextSurface: WorkspaceSurfaceDescriptor,
    sourceSurfaceId: string,
    reason: 'workspace-home-selection' | 'return-origin',
  ) => {
    const keepFocus = useF307ExperienceWorkbenchStore.getState().focusSurfaceId === sourceSurfaceId;
    const fileTarget = isV2 && reason !== 'return-origin' ? resolveFileTarget(nextSurface) : null;
    const opened = fileTarget
      ? {
          ...nextSurface,
          ...createFilePreviewSurface({
            ...fileTarget,
            navigationOrigin: nextSurface.navigationOrigin,
            rootSelection: nextSurface.rootSelection,
          }),
        }
      : nextSurface;
    dispatchInput({
      type: fileTarget ? 'open-preview-surface' : 'open-surface',
      surface: opened,
      entitlement: { kind: 'user', reason },
    });
    // Preview open can retain an existing permanent identity instead of the requested one.
    const activeSurfaceId = useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId;
    if (keepFocus && activeSurfaceId !== null) enterFocusMode(activeSurfaceId);
  };
  const openHomeSurface = useCallback(
    (surface: WorkspaceSurfaceDescriptor) => {
      const before = useF307ExperienceWorkbenchStore.getState().layout;
      if (surface.type === 'thread-replay' && !before.surfaces.some((item) => item.id === surface.id))
        captureChatReadingBeforeLayoutChange();
      dispatchInput({
        type: 'open-surface',
        surface,
        entitlement: { kind: 'user', reason: 'workspace-home-selection' },
      });
      const accepted = useF307ExperienceWorkbenchStore.getState().layout;
      if (accepted.activeSurfaceId !== surface.id) return;
      rememberWorkspaceForeground();
      setHomeOpen(false);
    },
    [dispatchInput],
  );
  const threadTitle = useChatStore((state) => state.threads.find((thread) => thread.id === threadId)?.title);
  const destinationAdmission = useWorkspaceDestinationAdmission({
    context: { threadId, threadTitle, worktreeId, canonicalWorktreeId, openFilePath, preview },
    worktreeLoading,
    worktreeError,
    onSelectSurface: openHomeSurface,
  });
  useEffect(() => {
    if (destinationAdmission.message) setHomeOpen(true);
  }, [destinationAdmission.message]);
  const selectRecentSurface = (requested: WorkspaceSurfaceDescriptor) => {
    const current = useF307ExperienceWorkbenchStore.getState().layout;
    const surface = selectRecentSurfaces(current, threadId).find((candidate) => candidate.id === requested.id);
    if (!surface) return;
    const entitlement = { kind: 'user' as const, reason: 'workspace-home-selection' as const };
    if (current.surfaces.some((candidate) => candidate.id === surface.id))
      dispatchInput({ type: 'activate-surface', surfaceId: surface.id, entitlement });
    else if (current.sidecar?.id === surface.id)
      dispatchInput({ type: 'promote-sidecar', destination: 'tab', entitlement });
    else dispatchInput({ type: 'restore-surface', surfaceId: surface.id, entitlement });
    if (useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId !== surface.id) return;
    rememberWorkspaceForeground();
    setHomeOpen(false);
  };
  const openHomeArtifact = useCallback<OpenHomeArtifact>(
    (artifact, origin) => {
      const chat = useChatStore.getState();
      if (!threadId || origin.threadId !== threadId || chat.currentThreadId !== threadId) {
        useToastStore
          .getState()
          .addToast({ type: 'info', title: t.homeTab, message: t.homeOriginUnavailable, duration: 6000 });
        return;
      }
      if (artifact.type === 'pr') {
        const surface = createPullRequestChangesSurface({
          artifact,
          worktreeId: canonicalWorktreeId ?? worktreeId,
          threadId,
          navigationOrigin: origin,
        });
        if (surface) openHomeSurface(surface);
        else
          useToastStore
            .getState()
            .addToast({ type: 'info', title: 'PR', message: t.pullRequestSourceUnavailable, duration: 6000 });
        return;
      }
      chat.openPublishedArtifact(threadId, artifact, origin);
    },
    [threadId, t, canonicalWorktreeId, worktreeId, openHomeSurface],
  );
  const renderOwnerSurface = (surface: (typeof hostedSurfaces)[number], surfaceVisible: boolean) => (
    <F307OwnerSurfaceRenderer
      surface={surface}
      surfaceVisible={surfaceVisible}
      hostWorktreeId={canonicalWorktreeId ?? worktreeId}
      hostThreadId={threadId}
      focusMode={focusSurfaceId === surface.id}
      statusSurface={statusSurface}
      defaultCatId={defaultCatId}
      onOpenSurface={(nextSurface) => {
        openSurfaceFromOwner(nextSurface, surface.id, 'workspace-home-selection');
      }}
      onOpenArtifactWithReturn={({ artifact, returnSurface }) => {
        dispatchInput({
          type: 'open-artifact-with-return',
          artifact,
          returnSurface,
          presentation: isDesktop ? 'desktop' : 'mobile',
          entitlement: { kind: 'user', reason: 'workspace-home-selection' },
        });
      }}
      onRefreshSurface={(nextSurface) => dispatch({ type: 'refresh-surface', surface: nextSurface })}
      onReturnToFileOrigin={(fileSurface, origin) => {
        if (origin.kind === 'workspace-tools-search' || origin.kind === 'workspace-home-search') {
          if (origin.kind === 'workspace-tools-search' && origin.threadId !== threadId) {
            useToastStore
              .getState()
              .addToast({ type: 'info', title: t.openTools, message: t.searchOriginUnavailable, duration: 6000 });
            return;
          }
          exitMainAreaAttention();
          exitFocusMode();
          const session = useF307ExperienceWorkbenchStore.getState().artifactWorkPresentation.session;
          if (
            threadId &&
            session?.threadId === threadId &&
            session.surfaceId === fileSurface.id &&
            session.mode === 'full-window'
          )
            toggleArtifactWorkFullWindow(threadId, fileSurface);
          setHomeArtifactReturnOrigin(undefined);
          setHomeSearchQuery(origin.query);
          if (isV2) {
            setHomeSearchReturnOrigin(undefined);
            setToolsReturnRequest({
              generation: ++toolsReturnSequence.current,
              threadId,
              worktreeId,
              query: origin.query,
              ...(origin.kind === 'workspace-tools-search' ? { viewportOffsetPx: origin.viewportOffsetPx } : {}),
            });
          } else {
            setToolsReturnRequest(undefined);
            setHomeSearchReturnOrigin({
              kind: 'workspace-home-search',
              query: origin.query,
              ...(origin.kind === 'workspace-home-search' && origin.viewportOffsetPx !== undefined
                ? { viewportOffsetPx: origin.viewportOffsetPx }
                : {}),
            });
            onRestoreWorkspaceSearch?.(origin.query);
            setHomeOpen(true);
          }
          return;
        }
        if (origin.kind === 'workspace-home-artifact') {
          if (origin.threadId !== threadId) {
            useToastStore
              .getState()
              .addToast({ type: 'info', title: t.homeTab, message: t.homeOriginUnavailable, duration: 6000 });
            return;
          }
          exitMainAreaAttention();
          setHomeSearchReturnOrigin(undefined);
          setHomeArtifactReturnOrigin(origin);
          setHomeOpen(true);
          return;
        }
        if (origin.kind === 'workspace-changes') {
          const changes = createWorkspaceDestinationSurface(
            canonicalLauncherDestination('surface', 'changes'),
            origin.threadId ?? undefined,
            origin.worktreeId,
          );
          if (changes) openSurfaceFromOwner(changes, fileSurface.id, 'return-origin');
          exitMainAreaAttention();
          return;
        }
        if (origin.kind === 'artifact-list') {
          const list = createWorkspaceModeSurface('artifacts', origin.threadId);
          dispatchInput({
            type: 'open-surface',
            surface: { ...list, artifactListView: origin.view },
            entitlement: { kind: 'user', reason: 'return-origin' },
          });
          exitMainAreaAttention();
          return;
        }
        if (origin.kind === 'evolution-media') {
          const program = restoreEvolutionMediaOrigin(origin);
          if (!program) return;
          dispatchInput({
            type: 'open-surface',
            surface: program,
            entitlement: { kind: 'user', reason: 'return-origin' },
          });
          if (origin.expanded && isDesktop) enterMainAreaAttention(program.id);
          else exitMainAreaAttention();
          return;
        }
        if (origin.kind === 'chat-file-link') {
          exitMainAreaAttention();
          onReturnToChatMessage?.({ threadId: origin.threadId, messageId: origin.messageId });
          return;
        }
        if (origin.kind === 'meeting-transcript') {
          // C 3480: the minimal contract promises only the same-thread stopped-result round trip. A meeting origin
          // from another thread never switches that thread's panel and never silently succeeds — the person is
          // told to go back to the source conversation instead (in the current shell language, like the v2 meeting
          // journey that produced this origin).
          const chat = useChatStore.getState();
          if (origin.threadId !== chat.currentThreadId) {
            const t = resolveShellCopy(voiceMeetingCopy, readShellLanguage());
            useToastStore.getState().addToast({
              type: 'info',
              title: t.capture.otherThreadToastTitle,
              message: t.capture.otherThreadToastBody,
              duration: 6000,
            });
            return;
          }
          exitMainAreaAttention();
          chat.setRightPanelMode('transcript');
          return;
        }
        // A Settings or status card entry returns to its page; it needs no file target, so a files
        // surface opened from such an entry (a revealed directory) returns the same way.
        if (origin.kind === 'settings' || origin.kind === 'workspace-card') {
          exitMainAreaAttention();
          returnFileCard(origin, onOpenAppRoute, dispatchInput);
          return;
        }
        const target = resolveFileTarget(fileSurface);
        if (!target) return;
        exitMainAreaAttention();
        const action = workspaceFileReturnAction(origin, target.worktreeId);
        if (action.kind === 'artifact-list') return;
        if (action.kind === 'workspace-document') {
          openSurfaceFromOwner(
            createFileSurface({ worktreeId: action.worktreeId, path: action.path, scrollToLine: action.line }),
            fileSurface.id,
            'return-origin',
          );
          return;
        }
        if (action.kind === 'file-tree') {
          openSurfaceFromOwner(
            createFilesSurface(action.worktreeId, action.repoRoot ? { repoRoot: action.repoRoot } : {}),
            fileSurface.id,
            'return-origin',
          );
          return;
        }
        if (action.kind === 'workspace-home-search') {
          setHomeArtifactReturnOrigin(undefined);
          setHomeSearchQuery(action.query);
          setHomeSearchReturnOrigin(action);
          onRestoreWorkspaceSearch?.(action.query);
          setHomeOpen(true);
          return;
        }
        if (action.kind === 'chat-file-link') {
          onReturnToChatMessage?.({ threadId: action.threadId, messageId: action.messageId });
        }
      }}
      onRequestDetach={() => {
        if (
          surface.returnTargetRef ||
          surface.type === 'artifact' ||
          surface.ownerStateRef.owner === 'f309-content-review'
        ) {
          dispatch({
            type: 'close-artifact-to-return',
            artifactSurfaceId: surface.id,
            entitlement: { kind: 'user', reason: 'close-button' },
          });
          return;
        }
        dispatch({
          type: 'close-surface',
          surfaceId: surface.id,
          entitlement: { kind: 'user', reason: 'close-button' },
        });
      }}
    />
  );

  return (
    <section
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--console-panel-bg)]"
      data-testid="f307-experience-workbench"
      data-layout-owner={layout.layoutOwner}
      data-layout-hydrated={hydrated}
      data-layout-kind={projection.kind}
      data-active-surface={layout.activeSurfaceId ?? ''}
      data-surface-count={layout.surfaces.length}
      data-split-primary={layout.split?.primarySurfaceId ?? ''}
      data-split-secondary={layout.split?.secondarySurfaceId ?? ''}
      data-sidecar-surface={layout.sidecar?.id ?? ''}
      data-surface-order={layout.surfaces.map((surface) => surface.id).join(',')}
      data-pinned-surfaces={layout.pinnedSurfaceIds.join(',')}
      data-workbench-focus={homeFocused ? 'home' : 'surface'}
      data-zero-topology-contract={topologyContract}
      data-main-area-attention={mainAreaAttentionSurfaceId ?? ''}
      data-focus-surface={focusSurfaceId ?? ''}
    >
      <ListenModePlayer />
      {(!zeroTopology || isV2) && focusSurfaceId === null && (
        <F307WorkbenchTabs
          hostThreadId={threadId}
          layout={layout}
          dispatch={dispatchInput}
          toolsOpenRequest={scopedToolsReturn?.generation}
          toolsScopeKey={toolsScopeKey}
          onToolsClose={() => setToolsReturnRequest(undefined)}
          toolsContent={(close, menu) => (
            <WorkbenchToolsContent
              key={`${toolsScopeKey}:${scopedToolsReturn?.generation ?? 0}`}
              menu={menu}
              returnRequest={scopedToolsReturn}
              threadId={threadId}
              onSelectDestination={destinationAdmission.onSelectDestination}
              onSelectDevSurface={onSelectDevSurface}
              workspaceSearch={workspaceSearch}
              onClose={close}
              onOpenSettings={(entry) => {
                const href =
                  entry.destination.kind === 'route' ? entry.destination.path : defaultSettingsSectionPath(entry);
                if (!href) return;
                captureSettingsOrigin();
                onOpenAppRoute(resolveShellNavTarget(href, threadId ? `/thread/${encodeURIComponent(threadId)}` : '/'));
              }}
              recentSurfaces={selectRecentSurfaces(layout, threadId)}
              onSelectRecentSurface={selectRecentSurface}
              repository={repository}
              worktreeId={worktreeId}
              initialSearchQuery={scopedToolsReturn?.query ?? ''}
            />
          )}
          onAddSurface={() => {
            onOpenHome?.();
            exitMainAreaAttention();
            setHomeSearchQuery('');
            setHomeSearchReturnOrigin(undefined);
            setHomeArtifactReturnOrigin(undefined);
            setHomeOpen(true);
          }}
          onActivateSurface={() => {
            if (isV2) rememberWorkspaceForeground();
            setHomeOpen(false);
          }}
          homeFocused={homeFocused}
          isDesktop={isDesktop}
          artifactWorkHostAvailable={artifactWorkHostAvailable}
          fullWindowAction={
            artifactWorkHostAvailable &&
            isDesktop &&
            threadId &&
            activeWorkspaceSurface &&
            isWorkspaceFullWindowSurface(activeWorkspaceSurface, 'v2')
              ? {
                  active:
                    artifactWorkPresentation.session?.threadId === threadId &&
                    artifactWorkPresentation.session?.surfaceId === activeWorkspaceSurface.id &&
                    artifactWorkPresentation.session?.mode === 'full-window',
                  onToggle: () => toggleArtifactWorkFullWindow(threadId, activeWorkspaceSurface),
                }
              : undefined
          }
          mainAreaAttentionSurfaceId={mainAreaAttentionSurfaceId}
          onEnterMainAreaAttention={enterMainAreaAttention}
          onExitMainAreaAttention={() => {
            captureChatReadingBeforeLayoutChange();
            exitMainAreaAttention();
          }}
          mainAreaAttentionIsWide={attentionPresentation.kind === 'chat-workspace'}
        />
      )}

      {!homeFocused && focusSurfaceId === null && (
        <WorkbenchActivity layout={layout} dispatch={dispatchInput} copy={controlCopy} />
      )}

      {homeFocused && foregroundUnavailable && (
        <output className="shrink-0 px-4 py-3 text-xs text-cafe-muted">{t.unavailable}</output>
      )}
      {homeFocused && (
        <F307WorkspaceHomePage
          threadId={threadId}
          defaultCatId={defaultCatId}
          onSelectDevSurface={onSelectDevSurface}
          worktreeId={worktreeId}
          canonicalWorktreeId={canonicalWorktreeId}
          worktreeLoading={worktreeLoading}
          worktreeError={worktreeError}
          openFilePath={openFilePath}
          preview={preview}
          repository={repository}
          rootSelection={rootSelection}
          workspaceSearch={workspaceSearch}
          workspaceSearchQuery={homeSearchQuery}
          workspaceSearchReturnOrigin={homeSearchReturnOrigin}
          workspaceArtifactReturnOrigin={homeArtifactReturnOrigin}
          onSelectSurface={openHomeSurface}
          destinationAdmission={destinationAdmission}
          onOpenArtifact={openHomeArtifact}
        />
      )}
      <div
        className={`${homeFocused ? 'hidden' : 'flex'} min-h-0 flex-1 flex-col md:flex-row`}
        aria-hidden={homeFocused}
        data-testid="f307-mounted-surface-host"
      >
        {hostedSurfaces.map((surface) => {
          const sidecar = layout.sidecar?.id === surface.id;
          return (
            <F307MountedSurface
              key={surface.id}
              surface={surface}
              dispatch={dispatchInput}
              sidecar={sidecar}
              divider={!sidecar && projection.kind === 'split' && layout.split?.secondarySurfaceId === surface.id}
              visible={
                sidecar
                  ? ownerSidecarVisible(
                      visible,
                      homeFocused,
                      attentionPresentation.kind === 'overlay' ? mainAreaAttentionSurfaceId : null,
                      focusSurfaceId,
                    )
                  : visibleSurfaceIds.has(surface.id)
              }
              ownerVisible={sidecar || ownerSurfaceVisible(visible, homeFocused, visibleSurfaceIds, surface.id)}
              renderSurface={renderOwnerSurface}
              paneProps={
                sidecar
                  ? undefined
                  : {
                      focusMode: focusSurfaceId === surface.id,
                      artifactWorkFullWindow:
                        artifactWorkPresentation.session?.threadId === threadId &&
                        artifactWorkPresentation.session?.surfaceId === surface.id &&
                        artifactWorkPresentation.session?.mode === 'full-window',
                      onToggleArtifactWorkFullWindow:
                        artifactWorkHostAvailable &&
                        isDesktop &&
                        threadId &&
                        layout.activeSurfaceId === surface.id &&
                        isWorkspaceFullWindowSurface(surface, isV2 ? 'v2' : 'classic')
                          ? () => toggleArtifactWorkFullWindow(threadId, surface)
                          : undefined,
                      onEnterFocusMode: () => {
                        if (layout.activeSurfaceId !== surface.id) {
                          dispatchInput({
                            type: 'activate-surface',
                            surfaceId: surface.id,
                            entitlement: { kind: 'user', reason: 'surface-tab' },
                          });
                        }
                        setHomeOpen(false);
                        enterFocusMode(surface.id);
                      },
                      onExitFocusMode: exitFocusMode,
                    }
              }
            />
          );
        })}
      </div>

      {focusSurfaceId === null && (
        <RecentlyClosedSurfaces
          layout={layout}
          dispatch={dispatchInput}
          onRestore={() => setHomeOpen(false)}
          copy={controlCopy}
        />
      )}
    </section>
  );
}
