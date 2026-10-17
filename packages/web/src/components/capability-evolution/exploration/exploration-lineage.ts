import { type EvolutionExplorationNodeV1, refIdentity } from '@cat-cafe/shared';

export const LINEAGE_NODE_SIZE = { width: 176, height: 112 };

export interface ExplorationLineageRegion {
  key: 'owner' | 'registered' | 'parentless' | 'cortex';
  label: string;
  nodeKeys: string[];
  left: number;
  top: number;
  width: number;
  height: number;
}

export function lineageDetailLevel(zoom: number) {
  return zoom < 0.6 ? 'points' : zoom < 1.15 ? 'compact' : 'detail';
}

/** Topological, stable source order. Neither outcomes nor selection move a version into a better place. */
export function layoutExplorationLineage(
  nodes: EvolutionExplorationNodeV1[],
  collapsed: string[],
  direction: 'map' | 'vertical' = 'map',
) {
  const byKey = new Map(nodes.map((node) => [refIdentity(node.nodeRef), node]));
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  const hidden = new Set<string>();
  const folded = new Set(collapsed);
  const level = (key: string): number => {
    if (levels.has(key)) return levels.get(key) ?? 0;
    if (visiting.has(key)) return 0;
    visiting.add(key);
    const parents = byKey.get(key)?.parentEdges.map((edge) => refIdentity(edge.parentNodeRef)) ?? [];
    const depth = parents.length ? Math.max(...parents.map(level)) + 1 : 0;
    if (parents.some((parent) => folded.has(parent) || hidden.has(parent))) hidden.add(key);
    visiting.delete(key);
    levels.set(key, depth);
    return depth;
  };
  for (const key of byKey.keys()) level(key);
  const visible = nodes.filter((node) => !hidden.has(refIdentity(node.nodeRef)));
  const generationSizes = new Map<number, number>();
  for (const node of visible) {
    const depth = levels.get(refIdentity(node.nodeRef)) ?? 0;
    generationSizes.set(depth, (generationSizes.get(depth) ?? 0) + 1);
  }
  const breadth = Math.max(1, ...generationSizes.values());
  const depthCount = Math.max(1, ...generationSizes.keys());
  // Wide generations need room between layers; grades and the selected node never influence geometry.
  const layerGap = breadth >= 8 ? Math.max(208, (breadth * 144 * 3) / depthCount) : 208;
  const rows = new Map<number, number>();
  const placed = visible.map((node) => {
    const key = refIdentity(node.nodeRef);
    const depth = levels.get(key) ?? 0;
    const row = rows.get(depth) ?? 0;
    rows.set(depth, row + 1);
    const position = ((row + 0.5) * breadth) / (generationSizes.get(depth) ?? 1) - 0.5;
    return {
      node,
      key,
      x: 24 + (direction === 'vertical' ? position * 208 : depth * layerGap),
      y: 24 + (direction === 'vertical' ? depth : position) * 144,
    };
  });
  return {
    nodes: placed,
    width: Math.max(240, ...placed.map((node) => node.x + LINEAGE_NODE_SIZE.width + 24)),
    height: Math.max(160, ...placed.map((node) => node.y + LINEAGE_NODE_SIZE.height + 24)),
    hiddenCount: hidden.size,
  };
}

const CORTEX_ARCHIVE_PREFIX = 'cortex-archive-container:';

/**
 * The v2 overview keeps source classes inside the canvas instead of asking an
 * external legend to explain one visually continuous column. Date/order never
 * changes the grouping: only owner kind and recorded parent-edge structure do.
 */
export function layoutExplorationLineageV2(
  nodes: EvolutionExplorationNodeV1[],
  collapsed: string[],
  direction: 'map' | 'vertical' = 'map',
) {
  const referencedParents = new Set(
    nodes.flatMap((node) => node.parentEdges.map((edge) => refIdentity(edge.parentNodeRef))),
  );
  const groups = [
    {
      key: 'owner' as const,
      label: '本项目版本',
      matches: (node: EvolutionExplorationNodeV1) => node.kind === 'owner_version',
    },
    {
      key: 'registered' as const,
      label: '公开归档 · 已登记派生',
      matches: (node: EvolutionExplorationNodeV1) =>
        node.kind === 'public_archive' &&
        !node.nodeRef.ownerStateRef.startsWith(CORTEX_ARCHIVE_PREFIX) &&
        (node.parentEdges.length > 0 || referencedParents.has(refIdentity(node.nodeRef))),
    },
    {
      key: 'parentless' as const,
      label: '公开归档 · 父版未登记',
      matches: (node: EvolutionExplorationNodeV1) =>
        node.kind === 'public_archive' &&
        !node.nodeRef.ownerStateRef.startsWith(CORTEX_ARCHIVE_PREFIX) &&
        node.parentEdges.length === 0 &&
        !referencedParents.has(refIdentity(node.nodeRef)),
    },
    {
      key: 'cortex' as const,
      label: 'Cortex · 比赛归档',
      matches: (node: EvolutionExplorationNodeV1) => node.nodeRef.ownerStateRef.startsWith(CORTEX_ARCHIVE_PREFIX),
    },
  ];
  const positioned: ReturnType<typeof layoutExplorationLineage>['nodes'] = [];
  const regions: ExplorationLineageRegion[] = [];
  let hiddenCount = 0;
  let cursorY = 16;
  let width = 240;

  for (const group of groups) {
    const members = nodes.filter(group.matches);
    if (!members.length) continue;
    const local = layoutExplorationLineage(members, collapsed, direction);
    hiddenCount += local.hiddenCount;
    const top = cursorY;
    const contentOffsetY = top + 36;
    const nodeKeys = local.nodes.map((entry) => entry.key);
    positioned.push(...local.nodes.map((entry) => ({ ...entry, y: entry.y + contentOffsetY })));
    const regionWidth = local.width + 184;
    const regionHeight = local.height + 52;
    regions.push({
      key: group.key,
      label: group.label,
      nodeKeys,
      left: 8,
      top,
      width: regionWidth,
      height: regionHeight,
    });
    width = Math.max(width, regionWidth + 16);
    cursorY += regionHeight + 28;
  }

  return {
    nodes: positioned,
    regions,
    width,
    height: Math.max(160, cursorY - 12),
    hiddenCount,
  };
}

export interface LineageRoutePoint {
  x: number;
  y: number;
}

/** Sparse v2 labels live to the right of fixed-size points, so edges leave and
 * enter on the left and use a lower lane instead of visually cutting a name. */
export function sparseLineageEdgeRoute(
  parent: Pick<LineageRoutePoint, 'x' | 'y'>,
  child: Pick<LineageRoutePoint, 'x' | 'y'>,
  zoom: number,
): LineageRoutePoint[] {
  const safeZoom = Math.max(0.001, zoom);
  const parentCenter = { x: parent.x + LINEAGE_NODE_SIZE.width / 2, y: parent.y + LINEAGE_NODE_SIZE.height / 2 };
  const childCenter = { x: child.x + LINEAGE_NODE_SIZE.width / 2, y: child.y + LINEAGE_NODE_SIZE.height / 2 };
  const portOffset = 12 / safeZoom;
  const laneY = Math.max(parentCenter.y, childCenter.y) + 26 / safeZoom;
  return [
    parentCenter,
    { x: parentCenter.x - portOffset, y: parentCenter.y },
    { x: parentCenter.x - portOffset, y: laneY },
    { x: childCenter.x - portOffset, y: laneY },
    { x: childCenter.x - portOffset, y: childCenter.y },
    childCenter,
  ];
}
