import type { ThreadAttentionMemberSort } from '@cat-cafe/shared';
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShellPresentation } from '../shell/shell-presentation';
import {
  type AttentionCluster,
  type AttentionListRow,
  type AttentionRenderItem,
  flattenAttentionRows,
} from './attention-clusters';
import { type AttentionOrderSnapshot, orderAttentionList } from './attention-list-order';

/** Shared by flat, project and virtual lists; virtualization cannot unmount the reading session. */
export function useAttentionListOrder(
  lists: Readonly<Record<string, AttentionRenderItem[]>>,
  isOpen: (cluster: AttentionCluster) => boolean,
  modes: Readonly<Record<string, ThreadAttentionMemberSort>>,
  scope: string,
  query: string,
  arranging: boolean,
  readingSurface?: RefObject<HTMLElement>,
): Record<string, AttentionListRow[]> {
  const v2RecentFirst = useShellPresentation() === 'v2' && !arranging;
  const [pointerHeld, setPointerHeld] = useState(false);
  useEffect(() => {
    const surface = readingSurface?.current;
    if (!surface || !v2RecentFirst) {
      setPointerHeld(false);
      return;
    }
    const enter = () => setPointerHeld(true);
    const leave = () => {
      setPointerHeld(false);
    };
    if (surface.matches(':hover')) enter();
    surface.addEventListener('pointerenter', enter);
    surface.addEventListener('pointerleave', leave);
    return () => {
      surface.removeEventListener('pointerenter', enter);
      surface.removeEventListener('pointerleave', leave);
    };
  }, [readingSurface, v2RecentFirst]);
  const committed = useRef<{
    scope: string;
    v2RecentFirst: boolean;
    snapshots: Record<string, AttentionOrderSnapshot>;
  }>();
  const { snapshots, rows } = useMemo(() => {
    // v2 refreshes while the pointer is outside; the reading snapshot protects current click targets inside.
    const previous =
      committed.current?.scope === scope &&
      committed.current.v2RecentFirst === v2RecentFirst &&
      (!readingSurface || !v2RecentFirst || pointerHeld)
        ? committed.current.snapshots
        : {};
    const snapshots: Record<string, AttentionOrderSnapshot> = {};
    const rows: Record<string, AttentionListRow[]> = {};
    for (const [key, items] of Object.entries(lists)) {
      const result = orderAttentionList(
        items,
        isOpen,
        arranging ? {} : modes,
        arranging ? undefined : previous[key],
        v2RecentFirst,
        v2RecentFirst && pointerHeld,
      );
      snapshots[key] = result.snapshot;
      rows[key] = flattenAttentionRows(result.items, isOpen, query);
    }
    return { snapshots, rows };
  }, [lists, isOpen, modes, scope, query, arranging, v2RecentFirst, pointerHeld, readingSurface]);
  // An abandoned concurrent render must not become a remembered user-visible order.
  useLayoutEffect(() => {
    committed.current = { scope, v2RecentFirst, snapshots };
  }, [scope, snapshots, v2RecentFirst]);
  return rows;
}
