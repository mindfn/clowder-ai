import type { ShellPresentation } from '@/components/shell/shell-presentation';
import { resolveArtifactReviewTarget } from './artifact-review-surface';
import {
  type ArtifactWorkPresentationState,
  isWorkspaceArtworkFile,
  isWorkspaceFullWindowSurface,
} from './artifact-work-presentation';
import { resolvePublicationTarget } from './publication-surface';
import {
  createEntrustedReturnFromRef,
  resolveEvolutionProgramId,
  resolveFileTarget,
  resolveWorkspaceDestinationTarget,
} from './real-surface-adapters';
import type { WorkbenchLayoutState, WorkspaceSurfaceDescriptor } from './workbench-contract';

export type MainAreaAttentionPresentation =
  | { kind: 'overlay' }
  | { kind: 'chat-workspace'; threadId: string; chatBasis: number; mode?: 'split' | 'full-window' };

interface WorkspaceWorkHostInput {
  threadId: string | null;
  viewMode: 'single' | 'split';
  isDesktop: boolean;
  statusPanelOpen: boolean;
  rightPanelMode: 'status' | 'workspace' | 'transcript';
  shellPresentation: ShellPresentation;
  currentThreadId?: string | null;
  mediaComposerSurfaceId?: string | null;
  workModeRequested?: boolean;
}

function supportsChatWorkspace(surface: WorkspaceSurfaceDescriptor | null, threadId: string | null): boolean {
  if (!surface) return false;
  const destination = resolveWorkspaceDestinationTarget(surface);
  if (destination?.destinationRef === 'mode:product-schedule') return destination.threadId === threadId;
  return resolveEvolutionProgramId(surface) !== null;
}

/** Read the existing session for both shells; ownership and invalidation stay in the original controller. */
export function projectWorkspaceWorkHost(
  input: WorkspaceWorkHostInput,
  layout: WorkbenchLayoutState,
  presentation: ArtifactWorkPresentationState,
  attention?: { surfaceId: string | null; presentation: MainAreaAttentionPresentation },
) {
  const activeSurface = layout.surfaces.find((surface) => surface.id === layout.activeSurfaceId) ?? null;
  const surfaceActive = isWorkspaceFullWindowSurface(activeSurface, input.shellPresentation);
  const hostEligible =
    input.viewMode === 'single' &&
    input.isDesktop &&
    input.statusPanelOpen &&
    input.rightPanelMode === 'workspace' &&
    surfaceActive;
  const sessionMatchesHost =
    presentation.session?.threadId === input.threadId && presentation.session?.surfaceId === activeSurface?.id;
  const fullWindowActive = hostEligible && sessionMatchesHost && presentation.session?.mode === 'full-window';
  const workModeActive =
    input.shellPresentation === 'v2' &&
    ((hostEligible && sessionMatchesHost && presentation.session?.workMode === true) ||
      (input.workModeRequested === true &&
        !!input.threadId &&
        input.viewMode === 'single' &&
        input.isDesktop &&
        input.statusPanelOpen &&
        input.rightPanelMode === 'workspace'));
  const review = activeSurface && resolveArtifactReviewTarget(activeSurface);
  const publication = activeSurface && resolvePublicationTarget(activeSurface);
  const file = activeSurface && resolveFileTarget(activeSurface);
  const originThread =
    activeSurface?.navigationOrigin && 'threadId' in activeSurface.navigationOrigin
      ? activeSurface.navigationOrigin.threadId
      : null;
  const sameThread = Boolean(
    input.threadId && input.currentThreadId === input.threadId && (!originThread || originThread === input.threadId),
  );
  // Media qualification comes from the mounted content owner's real PNG source, not the descriptor's broad type.
  const readableImage =
    activeSurface?.id === input.mediaComposerSurfaceId &&
    Boolean(file || publication || (review && review.threadId === input.threadId));
  const readableDocument = Boolean(file && /\.(?:mdx?|txt)$/i.test(file.path));
  const narrowWorkComposerActive =
    input.shellPresentation === 'v2' &&
    !input.isDesktop &&
    input.viewMode === 'single' &&
    input.statusPanelOpen &&
    input.rightPanelMode === 'workspace' &&
    !layout.split &&
    sameThread &&
    (readableImage || readableDocument);
  const ordinaryHost =
    input.viewMode === 'single' && input.isDesktop && input.statusPanelOpen && input.rightPanelMode === 'workspace';
  const returnSurface = activeSurface ? createEntrustedReturnFromRef(activeSurface.returnTargetRef) : null;
  const wideSource = returnSurface ?? activeSurface;
  const chatWorkspaceEligible = supportsChatWorkspace(wideSource, input.threadId);
  const workspaceWideActive =
    !fullWindowActive &&
    ordinaryHost &&
    attention?.presentation.kind === 'chat-workspace' &&
    attention.presentation.mode !== 'full-window' &&
    attention.presentation.threadId === input.threadId &&
    attention.surfaceId === activeSurface?.id &&
    chatWorkspaceEligible;
  const workspaceAttentionFullWindowActive =
    ordinaryHost &&
    attention?.presentation.kind === 'chat-workspace' &&
    attention.presentation.mode === 'full-window' &&
    attention.presentation.threadId === input.threadId &&
    attention.surfaceId === activeSurface?.id &&
    chatWorkspaceEligible;
  return {
    activeSurface,
    surfaceActive,
    workspaceWideActive,
    workspaceAttentionFullWindowActive,
    workModeActive,
    hostEligible,
    fullWindowActive,
    narrowWorkComposerActive,
    // v2 file artwork shares the Artifact ratio; browser previews keep the Chat owner's ratio.
    splitPreferenceActive:
      workModeActive ||
      (hostEligible &&
        (isWorkspaceFullWindowSurface(activeSurface, 'classic') || isWorkspaceArtworkFile(activeSurface))),
    suppressCafeSidebar:
      (input.shellPresentation === 'v2' && fullWindowActive) ||
      workspaceWideActive ||
      workspaceAttentionFullWindowActive ||
      workModeActive,
  };
}
