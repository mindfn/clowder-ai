/**
 * F194 → F117 KD-23: Invocation liveness read model.
 *
 * Answers "which members are processing for (threadId, userId)?" without reading any timestamp.
 * A member is processing when its InvocationRecord is running and someone verifiably runs its turn:
 *
 * - this process's InvocationTracker holds the member's slot for the record's execution; or
 * - the CLI owner snapshot lists a live owner (its supervisor process still exists) for the
 *   record's execution and the member.
 *
 * A running TurnExecution child alone proves nothing: when the owner snapshot is incomplete the
 * startup settlement keeps the previous process's running children, and a child whose owner died
 * stays running until something settles it. So a running child only stands in for its owner when
 * the snapshot cannot tell, because the caller has none or it is incomplete. The member is then
 * listed as processing, degraded: the user still sees it and can stop it (F117 KD-10: running and
 * not running are the only states, and Stop settles an execution it cannot verify, AC-E7). Once a
 * complete snapshot shows no owner the child no longer counts, and the active-execution read-repair
 * ends the record.
 *
 * QueueProcessor turns a record running only after the tracker takes its slots, so a turn that only
 * holds a processing reservation is still queued and is not listed here. A slot whose execution has
 * no running record yet (the few awaits between the tracker taking the slot and the record turning
 * running) is listed as processing.
 *
 * The response R is checked by the caller (live-invocation-projection): a member whose R is already
 * terminal is not processing. Nothing here classifies zombies: the F118 owner reaper, the KD-21
 * startup settlement and the active-execution read-repair end turns, and none of them reads drafts.
 */

import type { CatId, TurnExecutionRecord } from '@cat-cafe/shared';
import type { InvocationRecord } from '../../stores/ports/InvocationRecordStore.js';
import type { ActiveSlotInfo } from './InvocationTracker.js';

export type LivenessSource =
  /** The record is running and this process's tracker holds the member's slot for it. */
  | 'record+tracker'
  /** The record is running and the owner snapshot lists a live CLI owner for the member. */
  | 'record+owner'
  /** The record is running, the member has a running child, and no complete snapshot can tell whether its owner lives. */
  | 'parent+child-execution'
  /** The tracker holds the slot and the record has not turned running yet. */
  | 'tracker-only';

export type LivenessReason =
  | 'tracker_present'
  | 'cli_owner_alive'
  | 'child_running_owner_unverified'
  | 'tracker_active_missing_record';

export interface LiveInvocation {
  catId: CatId;
  /** Parent execution owner used for lifecycle/control-plane correlation (the InvocationRecord id). */
  executionId: string;
  /** The member's child turn when known (tracker activeRun, owner or durable child), else the execution. */
  invocationId: string;
  /**
   * When the member's turn started: the tracker's bound activeRun, else when the tracker took the slot;
   * for an owner or a durable child, when it started. A multi-cat chain takes each slot at its start, so
   * the bound turn is what keeps a later member's timer from counting the whole chain (F194 Phase Z4).
   */
  startedAt: number;
  /** The exact response R the tracker's activeRun names, when the member already has one. */
  responseMessageId?: string;
  source: LivenessSource;
  /** Evidence that does not verify an owner: a tracker slot without its running record, or a running child the snapshot cannot vouch for. */
  degraded: boolean;
  reason: LivenessReason;
}

export interface LivenessReadResult {
  active: LiveInvocation[];
}

/** A live CLI owner from the owner snapshot (cli-process-ownership's LiveCliExecutionOwner). */
export interface LiveOwnerRef {
  readonly executionId: string;
  readonly invocationId: string;
  readonly threadId: string;
  readonly catId: string;
  readonly userId: string;
  readonly startedAt: number;
}

/** The CLI owner snapshot a caller took; `complete: false` means it could not be read in full. */
export interface OwnerSnapshot {
  readonly complete: boolean;
  readonly owners: readonly LiveOwnerRef[];
}

export interface LivenessReadDeps {
  /** Enumerate running InvocationRecords for (threadId, userId). */
  listRunningRecords: (threadId: string, userId: string) => Promise<InvocationRecord[]> | InvocationRecord[];
  /** InvocationTracker.getActiveSlots(threadId) */
  getActiveSlots: (threadId: string) => ActiveSlotInfo[];
  /** InvocationTracker.getUserId(threadId, catId) — guards against cross-user tracker collisions */
  getTrackerUserId: (threadId: string, catId: string) => string | null;
  /** InvocationTracker.getExecutionId(threadId, catId) — the execution that holds the slot */
  getTrackerExecutionId: (threadId: string, catId: string) => string | undefined;
  /** Durable child executions of a parent. When the configured store fails, the error propagates to
   *  the caller's fail-open path: "unknown" must not read as "no running child". */
  listTurnExecutionsByParent?: (parentInvocationId: string) => Promise<TurnExecutionRecord[]> | TurnExecutionRecord[];
  /**
   * The CLI owner snapshot the caller already took. A listed owner proves its member processing.
   * When the snapshot is complete, a running child without a slot or an owner proves nothing; when
   * it is absent or incomplete, a running child stands in for the owner it cannot verify.
   */
  ownerSnapshot?: OwnerSnapshot;
}

type RunningChildExecution = TurnExecutionRecord & { status: 'running' };

function isScopedRunningChild(
  child: TurnExecutionRecord,
  parent: InvocationRecord,
  threadId: string,
  userId: string,
): child is RunningChildExecution {
  return (
    child.status === 'running' &&
    child.parentInvocationId === parent.id &&
    child.threadId === threadId &&
    child.userId === userId &&
    typeof child.invocationId === 'string' &&
    child.invocationId.length > 0 &&
    typeof child.catId === 'string' &&
    child.catId.length > 0 &&
    Number.isFinite(child.startedAt) &&
    child.startedAt >= 0
  );
}

interface HeldSlot {
  readonly slot: ActiveSlotInfo;
  readonly executionId: string;
}

function liveFromSlot(held: HeldSlot, source: 'record+tracker' | 'tracker-only'): LiveInvocation {
  const { slot, executionId } = held;
  return {
    catId: slot.catId as CatId,
    executionId,
    invocationId: slot.activeRun?.invocationId ?? executionId,
    startedAt: slot.activeRun?.startedAt ?? slot.startedAt,
    ...(slot.activeRun ? { responseMessageId: slot.activeRun.responseMessageId } : {}),
    source,
    degraded: source === 'tracker-only',
    reason: source === 'record+tracker' ? 'tracker_present' : 'tracker_active_missing_record',
  };
}

/** The newest live owner per member of this execution that no tracker slot already proves. */
function liveFromOwners(
  record: InvocationRecord,
  provenCats: ReadonlySet<string>,
  threadId: string,
  userId: string,
  owners: readonly LiveOwnerRef[],
): LiveInvocation[] {
  const newestByCat = new Map<string, LiveOwnerRef>();
  for (const owner of owners) {
    if (owner.executionId !== record.id || owner.threadId !== threadId || owner.userId !== userId) continue;
    if (!owner.catId || provenCats.has(owner.catId)) continue;
    const existing = newestByCat.get(owner.catId);
    if (!existing || owner.startedAt > existing.startedAt) newestByCat.set(owner.catId, owner);
  }
  return Array.from(newestByCat.values(), (owner) => ({
    catId: owner.catId as CatId,
    executionId: record.id,
    invocationId: owner.invocationId,
    startedAt: owner.startedAt,
    source: 'record+owner' as const,
    degraded: false,
    reason: 'cli_owner_alive' as const,
  }));
}

/** The newest running child per member that neither a tracker slot nor a live owner already proves. */
async function liveFromUnverifiedChildren(
  record: InvocationRecord,
  provenCats: ReadonlySet<string>,
  threadId: string,
  userId: string,
  listTurnExecutionsByParent: NonNullable<LivenessReadDeps['listTurnExecutionsByParent']>,
): Promise<LiveInvocation[]> {
  const newestByCat = new Map<string, RunningChildExecution>();
  for (const child of await Promise.resolve(listTurnExecutionsByParent(record.id))) {
    if (!isScopedRunningChild(child, record, threadId, userId) || provenCats.has(child.catId)) continue;
    const existing = newestByCat.get(child.catId);
    if (!existing || child.startedAt > existing.startedAt) newestByCat.set(child.catId, child);
  }
  return Array.from(newestByCat.values(), (child) => ({
    catId: child.catId as CatId,
    executionId: record.id,
    invocationId: child.invocationId,
    startedAt: child.startedAt,
    source: 'parent+child-execution' as const,
    degraded: true,
    reason: 'child_running_owner_unverified' as const,
  }));
}

export async function getThreadLiveInvocations(
  threadId: string,
  userId: string,
  deps: LivenessReadDeps,
): Promise<LivenessReadResult> {
  const records = (await Promise.resolve(deps.listRunningRecords(threadId, userId))).filter(
    (record) => record.status === 'running' && record.threadId === threadId && record.userId === userId,
  );
  const heldSlots: HeldSlot[] = deps.getActiveSlots(threadId).flatMap((slot) => {
    if (deps.getTrackerUserId(threadId, slot.catId) !== userId) return [];
    const executionId = deps.getTrackerExecutionId(threadId, slot.catId);
    return executionId ? [{ slot, executionId }] : [];
  });
  const owners = deps.ownerSnapshot?.owners ?? [];
  const ownerUnverifiable = deps.ownerSnapshot?.complete !== true;

  const active: LiveInvocation[] = [];
  const runningRecordIds = new Set(records.map((record) => record.id));
  for (const record of records) {
    const held = heldSlots.filter((entry) => entry.executionId === record.id);
    active.push(...held.map((entry) => liveFromSlot(entry, 'record+tracker')));
    const proven = new Set<string>(held.map((entry) => entry.slot.catId));
    const byOwner = liveFromOwners(record, proven, threadId, userId, owners);
    active.push(...byOwner);
    if (ownerUnverifiable && deps.listTurnExecutionsByParent) {
      for (const live of byOwner) proven.add(live.catId);
      active.push(
        ...(await liveFromUnverifiedChildren(record, proven, threadId, userId, deps.listTurnExecutionsByParent)),
      );
    }
  }
  for (const entry of heldSlots) {
    if (!runningRecordIds.has(entry.executionId)) active.push(liveFromSlot(entry, 'tracker-only'));
  }
  return { active };
}
