import type { ShellPresentation } from '@/components/shell/shell-presentation';
import {
  type ArtifactWorkPresentationState,
  isWorkspaceArtworkFile,
  isWorkspaceFullWindowSurface,
} from './artifact-work-presentation';
import { createEntrustedReturnFromRef, resolveWorkspaceDestinationTarget } from './real-surface-adapters';
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
    // v2 file artwork shares the Artifact ratio; browser previews keep the Chat owner's ratio.
    splitPreferenceActive:
      hostEligible && (isWorkspaceFullWindowSurface(activeSurface, 'classic') || isWorkspaceArtworkFile(activeSurface)),
    suppressCafeSidebar: (input.shellPresentation === 'v2' && fullWindowActive) || workspaceWideActive,
  };
}
