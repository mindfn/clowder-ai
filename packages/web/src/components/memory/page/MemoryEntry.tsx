'use client';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { MemoryHub } from '../MemoryHub';
import { MemoryPagePreview, type MemoryPageTab } from './MemoryPagePreview';

/** The existing shell preference owns presentation; the classic feed remains its original entry. */
export function MemoryEntry({ tab, from }: { tab: MemoryPageTab; from: string | null }) {
  const presentation = useShellPresentation();
  return presentation === 'v2' ? (
    <MemoryPagePreview tab={tab} shell="v2" basePath="/memory" from={from} />
  ) : (
    <MemoryHub activeTab="feed" initialReferrerThread={from} />
  );
}
