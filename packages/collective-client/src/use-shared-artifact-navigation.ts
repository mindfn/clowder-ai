import { useCallback, useRef } from 'react';
import type { ChannelContent } from './ChannelContentTabs.js';
import type { SharedArtifact } from './collective-artifact-client.js';
import type { RoadmapReturn } from './collective-workspace-model.js';
import type { CollectiveArtifactState } from './use-collective-artifacts.js';

export interface SharedArtifactPlace {
  destination: 'home' | 'channel' | 'library';
  channelId: string;
  content: ChannelContent;
  query: string;
  focusEventId?: string;
  roadmapReturn?: RoadmapReturn;
}

/** Keeps only the return point; the existing workspace remains the sole navigation state owner. */
export function useSharedArtifactNavigation(options: {
  namespace: string;
  artifacts?: Pick<CollectiveArtifactState, 'open' | 'close' | 'selected'>;
  place: SharedArtifactPlace;
  onOpenSource: (channelId: string, eventId: string) => void;
  onRestore: (place: SharedArtifactPlace) => void;
}) {
  const current = useRef(options);
  current.current = options;
  const origin = useRef<{ namespace: string; place: SharedArtifactPlace }>();
  if (origin.current && origin.current.namespace !== options.namespace) origin.current = undefined;
  const discard = useCallback(() => {
    origin.current = undefined;
    current.current.artifacts?.close();
  }, []);
  const open = useCallback((artifact: SharedArtifact, ownerRevision?: number) => {
    const { namespace, place, artifacts, onOpenSource } = current.current;
    const previous = origin.current ?? { namespace, place };
    if (place.destination !== 'channel' || place.channelId !== artifact.sourceLocation.channelId)
      onOpenSource(artifact.sourceLocation.channelId, artifact.sourceEventId);
    origin.current = previous;
    artifacts?.open(artifact, ownerRevision);
  }, []);
  const close = useCallback(() => {
    const previous = origin.current;
    origin.current = undefined;
    const { namespace, artifacts, onRestore } = current.current;
    artifacts?.close();
    if (previous?.namespace === namespace) onRestore(previous.place);
  }, []);
  const returnLabel =
    origin.current?.place.destination === 'library'
      ? '返回全部作品'
      : origin.current?.place.content === 'artifacts'
        ? '返回频道作品'
        : '关闭作品';
  return { open, close, discard, returnLabel };
}
