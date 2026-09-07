import type { QueueReceiptTargetState } from '@cat-cafe/shared';

export interface SteerParticipantActivity {
  catId: string;
  lastMessageAt: number;
  lastResponseHealthy?: boolean;
}

export interface SteerThreadCatProjection {
  participantActivity: SteerParticipantActivity[];
  /** Exact read-only result from the same head-time resolver used by Queue drain. */
  fallbackTargetCatId: string | null;
}

export interface SteerSourceTargetState {
  targetCatId: string;
  state: QueueReceiptTargetState;
  /** True only while this exact scalar ledger row remains queued. */
  actionable: boolean;
}

const QUEUE_TARGET_STATES = new Set<QueueReceiptTargetState>([
  'queued',
  'notified',
  'awakened',
  'seen',
  'failed',
  'interrupted',
  'cancelled',
  'steering',
  'withdrawn',
  'handled',
]);

export function parseSteerThreadCatProjection(body: unknown): SteerThreadCatProjection {
  if (!body || typeof body !== 'object') return { participantActivity: [], fallbackTargetCatId: null };
  const value = body as Record<string, unknown>;
  const participants = Array.isArray(value.participants) ? value.participants : [];
  return {
    participantActivity: participants.flatMap((participant: unknown) => {
      if (!participant || typeof participant !== 'object') return [];
      const candidate = participant as Record<string, unknown>;
      if (typeof candidate.catId !== 'string' || typeof candidate.lastMessageAt !== 'number') return [];
      return [
        {
          catId: candidate.catId,
          lastMessageAt: candidate.lastMessageAt,
          ...(typeof candidate.lastResponseHealthy === 'boolean'
            ? { lastResponseHealthy: candidate.lastResponseHealthy }
            : {}),
        },
      ];
    }),
    fallbackTargetCatId: typeof value.fallbackTargetCatId === 'string' ? value.fallbackTargetCatId : null,
  };
}

export function parseSteerSourceTargetStates(body: unknown): SteerSourceTargetState[] {
  if (!body || typeof body !== 'object') return [];
  const targets = (body as Record<string, unknown>).targets;
  if (!Array.isArray(targets)) return [];
  return targets.flatMap((target: unknown) => {
    if (!target || typeof target !== 'object') return [];
    const candidate = target as Record<string, unknown>;
    if (
      typeof candidate.targetCatId !== 'string' ||
      typeof candidate.state !== 'string' ||
      !QUEUE_TARGET_STATES.has(candidate.state as QueueReceiptTargetState) ||
      typeof candidate.actionable !== 'boolean'
    ) {
      return [];
    }
    return [
      {
        targetCatId: candidate.targetCatId,
        state: candidate.state as QueueReceiptTargetState,
        actionable: candidate.actionable,
      },
    ];
  });
}
