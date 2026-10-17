'use client';

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { inheritContentSurfaceOrigin } from '@/components/workbench/resolve-content-surface';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { ArtworkMediaViewportProvider } from './ArtworkMediaViewport';

export type FloatingArtwork = {
  url: string;
  title: string;
  alt: string;
  mediaType: 'image' | 'video';
  caption?: string;
  reason?: string;
  surface: WorkspaceSurfaceDescriptor | null;
  openWorkspace?: () => Promise<boolean>;
};
type Scope = {
  threadId: string;
  work: FloatingArtwork | null;
  open: (work: FloatingArtwork) => void;
  close: () => void;
  resolve: (surface: WorkspaceSurfaceDescriptor) => void;
  composerSlot: HTMLDivElement | null;
  setComposerSlot: (element: HTMLDivElement | null) => void;
  toolsSlot: HTMLDivElement | null;
  setToolsSlot: (element: HTMLDivElement | null) => void;
};
const Context = createContext<Scope | null>(null);
// These are presentation slots, never a second conversation, owner or draft store.
export function ArtworkLightboxProvider({ threadId, children }: { threadId: string; children: ReactNode }) {
  const [{ work, generation }, setPresentation] = useState<{ work: FloatingArtwork | null; generation: number }>({
    work: null,
    generation: 0,
  });
  const [composerSlot, setComposerSlot] = useState<HTMLDivElement | null>(null);
  const [toolsSlot, setToolsSlot] = useState<HTMLDivElement | null>(null);
  const open = useCallback(
    (work: FloatingArtwork) => setPresentation((current) => ({ work, generation: current.generation + 1 })),
    [],
  );
  const close = useCallback(
    () => setPresentation((current) => ({ work: null, generation: current.generation + 1 })),
    [],
  );
  const sourceSurfaceId = work?.surface?.id;
  const resolve = useCallback(
    (surface: WorkspaceSurfaceDescriptor) =>
      setPresentation((current) =>
        current.generation !== generation || !current.work?.surface || current.work.surface.id !== sourceSurfaceId
          ? current
          : {
              ...current,
              work: { ...current.work, surface: inheritContentSurfaceOrigin(current.work.surface, surface) },
            },
      ),
    [generation, sourceSurfaceId],
  );
  const value = useMemo(
    () => ({ threadId, work, open, close, resolve, composerSlot, setComposerSlot, toolsSlot, setToolsSlot }),
    [threadId, work, open, close, resolve, composerSlot, toolsSlot],
  );
  return (
    <ArtworkMediaViewportProvider>
      <Context.Provider value={value}>{children}</Context.Provider>
    </ArtworkMediaViewportProvider>
  );
}
export function useArtworkLightboxScope() {
  return useContext(Context);
}

const Presentation = createContext(false);
export function FloatingArtworkPresentation({ children }: { children: ReactNode }) {
  return <Presentation.Provider value>{children}</Presentation.Provider>;
}
export function useFloatingArtworkPresentation() {
  return useContext(Presentation);
}
