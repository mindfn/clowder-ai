import { ChatVoiceFeatureControls } from '@/components/ChatVoiceFeatureControls';
import { WorkspaceNowSurface } from '@/components/workspace/WorkspaceNowSurface';
import { createAgentRunSurface } from './real-surface-adapters';
import { VideoProjectList } from './video-project/VideoProjectList';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

/** Catalogue entries reuse the existing running-work, voice and film owners. */
export function WorkspaceAuxiliaryOwnerSurface({
  destination,
  threadId,
  defaultCatId,
  onOpenSurface,
}: {
  destination: 'host:now' | 'host:voice' | 'host:films';
  threadId: string | null;
  defaultCatId: string;
  onOpenSurface: (surface: WorkspaceSurfaceDescriptor) => void;
}) {
  if (destination === 'host:voice')
    return <ChatVoiceFeatureControls threadId={threadId ?? undefined} defaultCatId={defaultCatId} />;
  if (destination === 'host:films') return <VideoProjectList onOpen={onOpenSurface} />;
  return (
    <WorkspaceNowSurface
      onSelectExecution={(execution) => {
        const surface = createAgentRunSurface({ execution });
        if (surface) onOpenSurface(surface);
      }}
    />
  );
}
