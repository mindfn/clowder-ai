'use client';

import type { RefObject } from 'react';
import { useTextSelectionAction } from '@/hooks/useTextSelectionAction';
import type { FloatingSelectionPosition } from './selection-action-position';
import { useSelectionAtVersion } from './useSelectionAtVersion';

export interface MarkdownSelectionAction {
  text: string;
  position: FloatingSelectionPosition;
  selectionStart?: number;
  selectionEnd?: number;
  /** The version of the file the selection was made in; absent where the version was not known. */
  version?: string | null;
}

/** `version` is the version of the file on screen: each selection takes the one current when it was made. */
export function useMarkdownSelectionAction(
  containerRef: RefObject<HTMLDivElement>,
  active: boolean,
  resetKey: string | null,
  version: string | null = null,
): MarkdownSelectionAction | null {
  return useSelectionAtVersion(useTextSelectionAction(containerRef, active, resetKey, 'container'), version);
}
