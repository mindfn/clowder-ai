import type { ThreadAttentionMemberSort } from '@cat-cafe/shared';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import type { AttentionCluster, AttentionRenderItem } from './attention-clusters';

interface OpenMemberOrder {
  mode: ThreadAttentionMemberSort | 'recent';
  sourceIds: string[];
  ids: string[];
}

export interface AttentionOrderSnapshot {
  itemKeys: string[];
  openGroups: Record<string, OpenMemberOrder>;
  outsideWorkingOrder: string[];
}

export function attentionItemKey(item: AttentionRenderItem): string {
  return item.kind === 'thread' ? `thread:${item.thread.id}` : item.cluster.anchor;
}

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** One v2 rule for conversations, Group aggregates, and default Group members. */
function compareV2Activity(
  left: { pinned: boolean; activity: number },
  right: { pinned: boolean; activity: number },
): number {
  return Number(right.pinned) - Number(left.pinned) || right.activity - left.activity;
}

function orderV2ByActivity(items: readonly AttentionRenderItem[]): AttentionRenderItem[] {
  const facts = (item: AttentionRenderItem) => {
    const members = item.kind === 'thread' ? [item.thread] : item.members;
    return {
      pinned: members.some((member) => member.pinned),
      activity: Math.max(...members.map((member) => member.lastActiveAt)),
    };
  };
  return [...items].sort((a, b) => {
    const left = facts(a),
      right = facts(b);
    return compareV2Activity(left, right);
  });
}

function orderGroupMemberIds(
  members: readonly SidebarSnapshotRow[],
  mode: OpenMemberOrder['mode'],
  v2: boolean,
): string[] {
  // An explicit running-first preference changes the partition, not the recent rule inside each partition.
  // Classic retains its existing manual ties; manual remains an explicit user override in both views.
  const ordered =
    mode === 'recent' || (v2 && mode === 'running-first')
      ? [...members].sort((a, b) =>
          compareV2Activity(
            { pinned: a.pinned, activity: a.lastActiveAt },
            { pinned: b.pinned, activity: b.lastActiveAt },
          ),
        )
      : members;
  return (
    mode === 'running-first'
      ? [
          ...ordered.filter((member) => member.presence.status === 'working'),
          ...ordered.filter((member) => member.presence.status !== 'working'),
        ]
      : ordered
  ).map((member) => member.id);
}

/** Retain order metadata only; rendered facts always come from the current Sidebar snapshot. */
export function orderAttentionList(
  items: readonly AttentionRenderItem[],
  isOpen: (cluster: AttentionCluster) => boolean,
  modes: Readonly<Partial<Record<string, ThreadAttentionMemberSort>>>,
  previous?: AttentionOrderSnapshot,
  v2RecentFirst = false,
  pointerHeld = false,
): { items: AttentionRenderItem[]; snapshot: AttentionOrderSnapshot } {
  const openGroups: AttentionOrderSnapshot['openGroups'] = {};
  const source = v2RecentFirst ? orderV2ByActivity(items) : items;
  const ordered = source.map((item): AttentionRenderItem => {
    if (item.kind === 'thread') return item;
    const expanded = isOpen(item.cluster);
    if (!expanded && !v2RecentFirst) return item;
    const anchor = item.cluster.anchor;
    const mode = modes[anchor] ?? (v2RecentFirst ? 'recent' : 'manual');
    // Membership order identifies a user reorder; activity is only an input when opening.
    const sourceIds = item.members.map((member) => member.id);
    const prior = expanded ? previous?.openGroups[anchor] : undefined;
    const members = new Map(item.members.map((member) => [member.id, member]));
    const ids =
      prior && prior.mode === mode && sameSequence(prior.sourceIds, sourceIds)
        ? prior.ids
        : orderGroupMemberIds(item.members, mode, v2RecentFirst);
    if (expanded) openGroups[anchor] = { mode, sourceIds, ids };
    return {
      ...item,
      members: ids.flatMap((id) => {
        const member = members.get(id);
        return member ? [member] : [];
      }),
    };
  });

  // Reading a Group must not freeze unrelated work. Only retain its placement while
  // working-order inputs outside open Groups are unchanged. Stable IDs alone miss a
  // refined start time or a different working member of the same closed Group.
  // These signatures release the hold; canonical sorting stays upstream.
  const outsideWorkingOrder = ordered.flatMap((item) => {
    if (item.kind === 'cluster' && openGroups[item.cluster.anchor]) return [];
    const working = (item.kind === 'thread' ? [item.thread] : item.members).filter(
      (member) => member.presence.status === 'working',
    );
    if (working.length === 0) return [];
    return [
      JSON.stringify([
        attentionItemKey(item),
        working.map((member) => [member.id, member.pinned, member.presence.activeSince ?? Number.MAX_SAFE_INTEGER]),
      ]),
    ];
  });
  const modeChanged =
    v2RecentFirst &&
    Object.entries(openGroups).some(
      ([anchor, state]) => previous?.openGroups[anchor] && previous.openGroups[anchor].mode !== state.mode,
    );
  const keepPlacement =
    previous &&
    !modeChanged &&
    (pointerHeld ||
      (Object.keys(openGroups).some((anchor) => previous.openGroups[anchor]) &&
        sameSequence(previous.outsideWorkingOrder, outsideWorkingOrder)));
  const byKey = new Map(ordered.map((item) => [attentionItemKey(item), item]));
  const currentKeys = ordered.map(attentionItemKey);
  const priorKeys = new Set(previous?.itemKeys);
  const itemKeys = keepPlacement
    ? [...previous.itemKeys.filter((key) => byKey.has(key)), ...currentKeys.filter((key) => !priorKeys.has(key))]
    : currentKeys;
  return {
    items: itemKeys.flatMap((key) => {
      const item = byKey.get(key);
      return item ? [item] : [];
    }),
    snapshot: { itemKeys, openGroups, outsideWorkingOrder },
  };
}
