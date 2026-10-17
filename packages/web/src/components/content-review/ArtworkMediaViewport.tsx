'use client';

import { createContext, type ReactNode, type RefObject, useContext, useEffect, useRef } from 'react';

type Position = { seconds: number; paused: boolean };
const Context = createContext<Map<string, Position> | null>(null);

/** Thread-local viewport continuity only. A position is neither a media grant nor presented-frame evidence. */
export function ArtworkMediaViewportProvider({ children }: { children: ReactNode }) {
  const positions = useRef(new Map<string, Position>());
  return <Context.Provider value={positions.current}>{children}</Context.Provider>;
}

export function useArtworkVideoPosition(
  videoRef: RefObject<HTMLVideoElement>,
  identity: string | undefined,
  src: string | null,
  seekTo: (seconds: number) => void,
) {
  const positions = useContext(Context);
  useEffect(() => {
    const video = videoRef.current;
    if (!positions || !identity || !src || !video) return;
    const saved = positions.get(identity);
    let restored = false;
    const restore = () => {
      if (restored || video.readyState < 1) return;
      restored = true;
      if (!saved) return;
      // The original seek owner revokes stale frame readiness; the new player must present its own frame.
      seekTo(saved.seconds);
      if (!saved.paused) void video.play().catch(() => {});
    };
    const remember = () => {
      if (video.readyState >= 1 && Number.isFinite(video.currentTime))
        positions.set(identity, { seconds: video.currentTime, paused: video.paused });
    };
    video.addEventListener('loadedmetadata', restore);
    for (const event of ['timeupdate', 'seeked', 'play', 'pause']) video.addEventListener(event, remember);
    restore();
    return () => {
      remember();
      video.removeEventListener('loadedmetadata', restore);
      for (const event of ['timeupdate', 'seeked', 'play', 'pause']) video.removeEventListener(event, remember);
    };
  }, [positions, identity, src, videoRef, seekTo]);
}
