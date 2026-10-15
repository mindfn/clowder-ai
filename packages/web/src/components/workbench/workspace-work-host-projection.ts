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
  resolveFileTarget,
  resolveWorkspaceDestinationTarget,
} from './real-surface-adapters';
import type { WorkbenchLayoutState } from './workbench-contract';

export type MainAreaAttentionPresentation =
  | { kind: 'overlay' }
  | { kind: 'chat-workspace'; threadId: string; chatBasis: number };

interface WorkspaceWorkHostInput {
  threadId: string | null;
  viewMode: 'single' | 'split';
  isDesktop: boolean;
  statusPanelOpen: boolean;
  rightPanelMode: 'status' | 'workspace' | 'transcript';
  shellPresentation: ShellPresentation;
  currentThreadId?: string | null;
  mediaComposerSurfaceId?: string | null;
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
  const source = wideSource ? resolveWorkspaceDestinationTarget(wideSource) : null;
  const workspaceWideActive =
    !fullWindowActive &&
    ordinaryHost &&
    attention?.presentation.kind === 'chat-workspace' &&
    attention.presentation.threadId === input.threadId &&
    attention.surfaceId === activeSurface?.id &&
    source?.destinationRef === 'mode:product-schedule' &&
    source.threadId === input.threadId;
  return {
    activeSurface,
    surfaceActive,
    workspaceWideActive,
    hostEligible,
    fullWindowActive,
    narrowWorkComposerActive,
    // v2 file artwork shares the Artifact ratio; browser previews keep the Chat owner's ratio.
    splitPreferenceActive:
      hostEligible && (isWorkspaceFullWindowSurface(activeSurface, 'classic') || isWorkspaceArtworkFile(activeSurface)),
    suppressCafeSidebar: (input.shellPresentation === 'v2' && fullWindowActive) || workspaceWideActive,
  };
}
