import type { CatId } from '@cat-cafe/shared';
import { messageFrom } from '../../stores/message-from.js';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import { canViewMessage, isTimelinePublished } from '../../stores/visibility.js';

export interface CallerDispatchObservationPointer {
  readonly ownerId: string;
  readonly threadId: string;
  readonly callerCatId: string;
  readonly sourceMessageId: string;
  readonly targetId: string;
  readonly revision: number;
  readonly presentedRevision: number;
  readonly firstAddedBy: 'initial' | 'steer' | 'unknown';
  readonly selectionChange: 'added' | 'removed';
  readonly selectionChangedBy: 'initial' | 'steer' | 'queue_withdrawal' | 'unknown';
}

export interface CallerDispatchObservationInclusion {
  readonly key: string;
  /** Revision frozen before the asynchronous History read that produced this prompt line. */
  readonly includedRevision: number;
  readonly fingerprint: string;
  readonly terminal: boolean;
}

export interface CallerDispatchObservationProjection {
  readonly prompt: string;
  /** Only facts actually retained in the final prompt may be acknowledged on success. */
  readonly included: readonly CallerDispatchObservationInclusion[];
  readonly truncated: boolean;
}

export interface CallerDispatchProcessStartProjection {
  readonly prompt: string;
}

interface CallerDispatchProcessStartState {
  processGenerationId: string;
  noticeAcknowledged: boolean;
}

type CallerDispatchObservationScope = Pick<CallerDispatchObservationPointer, 'ownerId' | 'threadId' | 'callerCatId'>;

interface ObservationLine {
  line: string;
  terminal: boolean;
  fingerprint: string;
}

interface ProjectedObservation extends ObservationLine {
  key: string;
  includedRevision: number;
}

interface CallerDispatchObservationEntry extends CallerDispatchObservationPointer {
  presentedFingerprint?: string;
  observedFingerprint?: string;
  actualFingerprint?: string;
}

interface MessageReadResult {
  message: StoredMessage | null;
  failed: boolean;
}

const DEFAULT_MAX_PROMPT_CHARS = 6_000;
const MAX_BODY_CHARS = 1_200;

function slotKey(pointer: CallerDispatchObservationScope): string {
  return JSON.stringify([pointer.ownerId, pointer.threadId, pointer.callerCatId]);
}

export function callerDispatchObservationKey(
  pointer: Pick<
    CallerDispatchObservationPointer,
    'ownerId' | 'threadId' | 'callerCatId' | 'sourceMessageId' | 'targetId'
  >,
): string {
  return JSON.stringify([
    pointer.ownerId,
    pointer.threadId,
    pointer.callerCatId,
    pointer.sourceMessageId,
    pointer.targetId,
  ]);
}

function compactBody(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= MAX_BODY_CHARS) return compact;
  return `${compact.slice(0, MAX_BODY_CHARS - 1)}…`;
}

function sourceOwnsPointer(source: StoredMessage, pointer: CallerDispatchObservationPointer): boolean {
  const from = messageFrom(source);
  return (
    source.id === pointer.sourceMessageId &&
    source.userId === pointer.ownerId &&
    source.threadId === pointer.threadId &&
    !source.deletedAt &&
    !source._tombstone &&
    isTimelinePublished(source) &&
    from.kind === 'agent' &&
    from.catId === pointer.callerCatId
  );
}

function canceledSourceOwnsWithdrawnPointer(source: StoredMessage, pointer: CallerDispatchObservationPointer): boolean {
  const from = messageFrom(source);
  return (
    pointer.selectionChange === 'removed' &&
    source.deliveryStatus === 'canceled' &&
    source.id === pointer.sourceMessageId &&
    source.userId === pointer.ownerId &&
    source.threadId === pointer.threadId &&
    !source.deletedAt &&
    !source._tombstone &&
    from.kind === 'agent' &&
    from.catId === pointer.callerCatId
  );
}

function isReadableObservationResponse(response: StoredMessage, pointer: CallerDispatchObservationPointer): boolean {
  return (
    response.threadId === pointer.threadId &&
    !response.deletedAt &&
    !response._tombstone &&
    response.origin !== 'briefing' &&
    isTimelinePublished(response) &&
    canViewMessage(response, { type: 'cat', catId: pointer.callerCatId as CatId })
  );
}

function unknownLine(pointer: CallerDispatchObservationPointer, reason: string): ObservationLine {
  return {
    line: `- ${pointer.sourceMessageId} → ${pointer.targetId}: unknown（${reason}，保留待观察）`,
    terminal: false,
    fingerprint: `unknown:${reason}`,
  };
}

function unadmittedObservationLine(pointer: CallerDispatchObservationPointer): ObservationLine {
  if (pointer.selectionChange === 'removed') {
    const withdrawalReason =
      pointer.selectionChangedBy === 'steer'
        ? 'withdrawn by committed Steer'
        : pointer.selectionChangedBy === 'queue_withdrawal'
          ? 'withdrawn by committed Queue cancellation'
          : 'withdrawn by committed Queue mutation';
    return {
      line: `- ${pointer.sourceMessageId} → ${pointer.targetId}: not_delivered(${withdrawalReason})`,
      terminal: true,
      fingerprint: `selection:removed:${pointer.selectionChangedBy}:${pointer.revision}`,
    };
  }
  return {
    line: `- ${pointer.sourceMessageId} → ${pointer.targetId}: pending; selectedBy=${pointer.firstAddedBy}`,
    terminal: false,
    fingerprint: `selection:added:${pointer.selectionChangedBy}:${pointer.revision}`,
  };
}

async function readMessage(
  messageStore: Pick<IMessageStore, 'getById'>,
  messageId: string,
): Promise<MessageReadResult> {
  try {
    return { message: await messageStore.getById(messageId), failed: false };
  } catch {
    return { message: null, failed: true };
  }
}

function terminalObservationLine(
  response: StoredMessage,
  pointer: CallerDispatchObservationPointer,
): ObservationLine | null {
  if (
    response.lifecycle?.kind === 'response' &&
    response.userId === pointer.ownerId &&
    response.lifecycle.targetId === pointer.targetId &&
    response.lifecycle.inputMessageIds.includes(pointer.sourceMessageId)
  ) {
    if (response.lifecycle.status === 'processing') {
      return unknownLine(pointer, 'settled ref 指向 processing response');
    }
    return {
      line: `- ${pointer.sourceMessageId} → ${pointer.targetId}: ${response.lifecycle.status}; response=${response.id}; body=${compactBody(response.content) || '(empty)'}`,
      terminal: true,
      fingerprint: `response:${response.id}:${response.lifecycle.status}`,
    };
  }
  if (
    response.lifecycle?.kind !== 'delivery_failure' ||
    response.lifecycle.inputMessageId !== pointer.sourceMessageId ||
    !response.lifecycle.requestedTargets.includes(pointer.targetId)
  ) {
    return null;
  }
  return {
    line: `- ${pointer.sourceMessageId} → ${pointer.targetId}: delivery_failure(${response.lifecycle.reason}); response=${response.id}; body=${compactBody(response.content) || '(empty)'}`,
    terminal: true,
    fingerprint: `delivery_failure:${response.id}:${response.lifecycle.reason}`,
  };
}

async function readObservationLine(
  messageStore: Pick<IMessageStore, 'getById'>,
  pointer: CallerDispatchObservationPointer,
): Promise<ObservationLine> {
  const sourceRead = await readMessage(messageStore, pointer.sourceMessageId);
  if (sourceRead.failed) return unknownLine(pointer, 'History 读取失败');
  const source = sourceRead.message;
  if (!source) return unknownLine(pointer, 'source/scope 不可验证');
  const sourceReadable = sourceOwnsPointer(source, pointer) || canceledSourceOwnsWithdrawnPointer(source, pointer);
  if (!sourceReadable) {
    return unknownLine(pointer, 'source/scope 不可验证');
  }
  if (source.lifecycle?.kind !== 'input' && source.lifecycle?.kind !== 'response') {
    return unknownLine(pointer, 'source lifecycle 不匹配');
  }
  const refs = (source.lifecycle.dispatchRefs ?? []).filter((ref) => ref.targetId === pointer.targetId);
  if (refs.length === 0) return unadmittedObservationLine(pointer);
  if (refs.length !== 1) return unknownLine(pointer, 'exact dispatchRef 不唯一');
  const ref = refs[0];
  if (!ref) return unknownLine(pointer, 'exact dispatchRef 缺失');
  if (ref.phase === 'dispatched') {
    return {
      line: `- ${pointer.sourceMessageId} → ${pointer.targetId}: executing`,
      terminal: false,
      fingerprint: `dispatch:${ref.phase}:${ref.statusMessageId}`,
    };
  }

  const responseRead = await readMessage(messageStore, ref.statusMessageId);
  if (responseRead.failed) return unknownLine(pointer, 'terminal response 读取失败');
  const response = responseRead.message;
  if (!response || !isReadableObservationResponse(response, pointer)) {
    return unknownLine(pointer, 'terminal response 不可验证');
  }
  return terminalObservationLine(response, pointer) ?? unknownLine(pointer, 'response lifecycle 不匹配');
}

/**
 * Process-local index only. Canonical phase/outcome always comes from History.
 * Re-registering the same exact source×target is intentionally idempotent.
 */
export class CallerDispatchObservationRegistry {
  private readonly bySlot = new Map<string, Map<string, CallerDispatchObservationEntry>>();
  private readonly processStartBySlot = new Map<string, CallerDispatchProcessStartState>();
  private nextRevision = 0;

  private allocateRevision(): number {
    this.nextRevision += 1;
    return this.nextRevision;
  }

  private registerSelection(
    pointer: Omit<
      CallerDispatchObservationPointer,
      'revision' | 'presentedRevision' | 'firstAddedBy' | 'selectionChange' | 'selectionChangedBy'
    >,
    change: 'added' | 'removed',
    changedBy: 'initial' | 'steer' | 'queue_withdrawal' | 'unknown',
  ): string {
    const sk = slotKey(pointer);
    const entries = this.bySlot.get(sk) ?? new Map<string, CallerDispatchObservationEntry>();
    const key = callerDispatchObservationKey(pointer);
    const current = entries.get(key);
    if (current?.selectionChange === change && current.selectionChangedBy === changedBy) return key;
    entries.set(key, {
      ...pointer,
      revision: this.allocateRevision(),
      presentedRevision: current?.presentedRevision ?? 0,
      firstAddedBy:
        current?.firstAddedBy ??
        (change === 'added' && (changedBy === 'initial' || changedBy === 'steer') ? changedBy : 'unknown'),
      selectionChange: change,
      selectionChangedBy: changedBy,
      ...(current?.presentedFingerprint ? { presentedFingerprint: current.presentedFingerprint } : {}),
      ...(current?.observedFingerprint ? { observedFingerprint: current.observedFingerprint } : {}),
      ...(current?.actualFingerprint ? { actualFingerprint: current.actualFingerprint } : {}),
    });
    this.bySlot.set(sk, entries);
    return key;
  }

  private registerActualRef(
    pointer: Omit<CallerDispatchObservationPointer, 'revision' | 'presentedRevision'>,
    actualFingerprint: string,
  ): string {
    const sk = slotKey(pointer);
    const entries = this.bySlot.get(sk) ?? new Map<string, CallerDispatchObservationEntry>();
    const key = callerDispatchObservationKey(pointer);
    const current = entries.get(key);
    if (current?.actualFingerprint === actualFingerprint) return key;

    entries.set(key, {
      ...pointer,
      revision: this.allocateRevision(),
      presentedRevision: current?.presentedRevision ?? 0,
      firstAddedBy: current?.firstAddedBy ?? pointer.firstAddedBy,
      selectionChange: current?.selectionChange ?? pointer.selectionChange,
      selectionChangedBy: current?.selectionChangedBy ?? pointer.selectionChangedBy,
      actualFingerprint,
      ...(current?.presentedFingerprint ? { presentedFingerprint: current.presentedFingerprint } : {}),
      ...(current?.observedFingerprint ? { observedFingerprint: current.observedFingerprint } : {}),
    });
    this.bySlot.set(sk, entries);
    return key;
  }

  registerInitialSource(source: StoredMessage, targetIds: readonly string[]): string[] {
    const from = messageFrom(source);
    if (from.kind !== 'agent') return [];
    return [...new Set(targetIds)].map((targetId) =>
      this.registerSelection(
        {
          ownerId: source.userId,
          threadId: source.threadId,
          callerCatId: from.catId,
          sourceMessageId: source.id,
          targetId,
        },
        'added',
        'initial',
      ),
    );
  }

  registerSteerChanges(
    source: StoredMessage,
    changes: { readonly addedTargetIds: readonly string[]; readonly removedTargetIds: readonly string[] },
  ): string[] {
    const from = messageFrom(source);
    if (from.kind !== 'agent') return [];
    return this.registerSteerChangesByIdentity(
      {
        ownerId: source.userId,
        threadId: source.threadId,
        callerCatId: from.catId,
        sourceMessageId: source.id,
      },
      changes,
    );
  }

  registerSteerChangesByIdentity(
    source: {
      readonly ownerId: string;
      readonly threadId: string;
      readonly callerCatId: string;
      readonly sourceMessageId: string;
    },
    changes: { readonly addedTargetIds: readonly string[]; readonly removedTargetIds: readonly string[] },
  ): string[] {
    const registered: string[] = [];
    for (const targetId of new Set(changes.addedTargetIds)) {
      registered.push(
        this.registerSelection(
          {
            ownerId: source.ownerId,
            threadId: source.threadId,
            callerCatId: source.callerCatId,
            sourceMessageId: source.sourceMessageId,
            targetId,
          },
          'added',
          'steer',
        ),
      );
    }
    for (const targetId of new Set(changes.removedTargetIds)) {
      registered.push(
        this.registerSelection(
          {
            ownerId: source.ownerId,
            threadId: source.threadId,
            callerCatId: source.callerCatId,
            sourceMessageId: source.sourceMessageId,
            targetId,
          },
          'removed',
          'steer',
        ),
      );
    }
    return registered;
  }

  registerQueueWithdrawalByIdentity(source: {
    readonly ownerId: string;
    readonly threadId: string;
    readonly callerCatId: string;
    readonly sourceMessageId: string;
    readonly targetIds: readonly string[];
  }): string[] {
    return [...new Set(source.targetIds)].map((targetId) =>
      this.registerSelection(
        {
          ownerId: source.ownerId,
          threadId: source.threadId,
          callerCatId: source.callerCatId,
          sourceMessageId: source.sourceMessageId,
          targetId,
        },
        'removed',
        'queue_withdrawal',
      ),
    );
  }

  registerPersistedSource(source: StoredMessage, targetIds?: readonly string[]): string[] {
    const from = messageFrom(source);
    if (from.kind !== 'agent') return [];
    if (source.lifecycle?.kind !== 'input' && source.lifecycle?.kind !== 'response') return [];
    const allowedTargets = targetIds ? new Set(targetIds) : undefined;
    return (source.lifecycle.dispatchRefs ?? [])
      .filter((ref) => !allowedTargets || allowedTargets.has(ref.targetId))
      .map((ref) =>
        this.registerActualRef(
          {
            ownerId: source.userId,
            threadId: source.threadId,
            callerCatId: from.catId,
            sourceMessageId: source.id,
            targetId: ref.targetId,
            firstAddedBy: 'unknown',
            selectionChange: 'added',
            selectionChangedBy: 'unknown',
          },
          `${ref.phase}:${ref.statusMessageId}`,
        ),
      );
  }

  list(scope: CallerDispatchObservationScope): readonly CallerDispatchObservationPointer[] {
    return [...(this.bySlot.get(slotKey(scope))?.values() ?? [])];
  }

  acknowledge(included: readonly CallerDispatchObservationInclusion[]): void {
    for (const observation of included) {
      for (const [sk, entries] of this.bySlot) {
        const current = entries.get(observation.key);
        if (!current || current.revision !== observation.includedRevision) continue;
        if (observation.terminal) {
          entries.delete(observation.key);
          if (entries.size === 0) this.bySlot.delete(sk);
          break;
        }
        entries.set(observation.key, {
          ...current,
          presentedRevision: observation.includedRevision,
          presentedFingerprint: observation.fingerprint,
        });
        break;
      }
    }
  }

  projectProcessStartNotice(
    scope: CallerDispatchObservationScope,
    processGenerationId: string,
  ): CallerDispatchProcessStartProjection {
    const sk = slotKey(scope);
    let state = this.processStartBySlot.get(sk);
    if (!state || state.processGenerationId !== processGenerationId) {
      state = { processGenerationId, noticeAcknowledged: false };
      this.processStartBySlot.set(sk, state);
    }
    if (state.noticeAcknowledged) return { prompt: '' };

    return {
      prompt: [
        '[A2A Observation Scope]',
        `process_start processGeneration=${processGenerationId}`,
        '当前进程内的 outbound dispatch observation 仅覆盖本 API 进程登记的 dispatch。',
        '此前进程的 dispatch 结果仍保留在 canonical History；需要时按需读取 History，不能据此推断旧结果。',
        '本说明不会创建任务、唤醒成员或清理当前进程内的 observation。',
        '[/A2A Observation Scope]',
      ].join('\n'),
    };
  }

  acknowledgeProcessStartNotice(scope: CallerDispatchObservationScope, processGenerationId: string): void {
    const state = this.processStartBySlot.get(slotKey(scope));
    if (state?.processGenerationId === processGenerationId) state.noticeAcknowledged = true;
  }

  private async refreshPointer(
    messageStore: Pick<IMessageStore, 'getById'>,
    pointer: CallerDispatchObservationPointer,
  ): Promise<ProjectedObservation | null> {
    const key = callerDispatchObservationKey(pointer);
    const includedRevision = pointer.revision;
    const observation = await readObservationLine(messageStore, pointer);
    const entries = this.bySlot.get(slotKey(pointer));
    let current = entries?.get(key);
    // A committed Steer/update won the race while History was being read.
    // Do not relabel the stale line with the newer revision; retain it for the next turn.
    if (!current || current.revision !== includedRevision) return null;

    if (current.observedFingerprint !== observation.fingerprint) {
      const projectedRevision =
        current.presentedRevision >= current.revision ? this.allocateRevision() : current.revision;
      current = {
        ...current,
        revision: projectedRevision,
        observedFingerprint: observation.fingerprint,
      };
      entries?.set(key, current);
    }
    const alreadyPresented =
      current.presentedRevision === current.revision && current.presentedFingerprint === observation.fingerprint;
    if (alreadyPresented) return null;
    return { ...observation, key, includedRevision: current.revision };
  }

  async project(
    messageStore: Pick<IMessageStore, 'getById'>,
    scope: CallerDispatchObservationScope,
    maxPromptChars = DEFAULT_MAX_PROMPT_CHARS,
  ): Promise<CallerDispatchObservationProjection> {
    const pointers = this.list(scope);
    if (pointers.length === 0) return { prompt: '', included: [], truncated: false };

    const header = [
      '[Outbound Dispatch Status]',
      '以下状态来自你先前提交的 source×target delivery lifecycle；不是新任务，也不会自动唤醒你。',
    ];
    const observations: ProjectedObservation[] = [];
    for (const pointer of pointers) {
      const observation = await this.refreshPointer(messageStore, pointer);
      if (observation) observations.push(observation);
    }
    observations.sort((left, right) => Number(right.terminal) - Number(left.terminal));

    const lines: string[] = [];
    const included: CallerDispatchObservationInclusion[] = [];
    let truncated = false;

    for (const { key, line, terminal, fingerprint, includedRevision } of observations) {
      const candidate = [...header, ...lines, line, '[/Outbound Dispatch Status]'].join('\n');
      if (candidate.length > maxPromptChars) {
        truncated = true;
        continue;
      }
      lines.push(line);
      included.push({ key, includedRevision, fingerprint, terminal });
    }

    if (lines.length === 0) return { prompt: '', included: [], truncated };
    if (truncated) {
      const notice = '- 其余待观察项因本 turn 输入预算保留到后续自然 invocation。';
      const withNotice = [...header, ...lines, notice, '[/Outbound Dispatch Status]'].join('\n');
      if (withNotice.length <= maxPromptChars) lines.push(notice);
    }
    return {
      prompt: [...header, ...lines, '[/Outbound Dispatch Status]'].join('\n'),
      included,
      truncated,
    };
  }
}
