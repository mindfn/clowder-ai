import { createModuleLogger } from '../../infrastructure/logger.js';
import { managedCommandWakeSlaBreachTotal } from '../../infrastructure/telemetry/instruments.js';
import type {
  ManagedCommandWakeEventCarrier,
  ManagedCommandWakeRecoveryDeps,
  ManagedCommandWakeRecoveryResult,
} from './managed-command-wake-lifecycle.js';
import {
  type ManagedCommandWakeProjection,
  type ParsedManagedCommandWakeTask,
  parseManagedCommandWakeTask,
} from './managed-command-wake-task-projection.js';

const log = createModuleLogger('ball-custody/managed-command-wake-recovery-policy');

export function isDispatchableManagedCommandWakeState(state: ManagedCommandWakeProjection['state']): boolean {
  return state === 'message_written' || state === 'dispatch_pending' || state === 'dispatched' || state === 'enqueued';
}

export async function recoverManagedCommandMissingDisposition(
  deps: ManagedCommandWakeRecoveryDeps,
  parsed: ParsedManagedCommandWakeTask,
  carrier: Extract<ManagedCommandWakeEventCarrier, { state: 'failed' }>,
  now: () => number,
): Promise<ManagedCommandWakeRecoveryResult> {
  const escalatedAt = now();
  const updated = deps.dynamicTaskStore.updateParamsIfCurrent(parsed.task.id, parsed.task.params, {
    ...parsed.task.params,
    holdLifecycle: {
      ...parsed.lifecycle,
      status: 'escalated',
      managedCommand: {
        ...parsed.command,
        state: 'escalated',
        dispositionEscalationReason: 'managed_hold_disposition_missing',
        dispositionEscalatedAttemptId: carrier.attemptId,
        dispositionEscalatedAt: escalatedAt,
      },
    },
  });
  if (!updated) return 'pending';
  deps.dynamicTaskStore.setEnabled(parsed.task.id, false);
  deps.taskRunner.unregister(parsed.task.id);
  log.error(
    {
      taskId: parsed.task.id,
      threadId: parsed.threadId,
      messageId: parsed.command.messageId,
      attemptId: carrier.attemptId,
    },
    'managed-command wake terminal failure requires a fresh producer admission',
  );
  return 'recovered';
}

export function recordManagedCommandWakeSlaBreach(
  deps: ManagedCommandWakeRecoveryDeps,
  parsed: ParsedManagedCommandWakeTask,
  now: () => number,
  wakeSlaMs: number,
): ParsedManagedCommandWakeTask {
  const conditionMetAt = parsed.command.conditionMetAt;
  if (
    conditionMetAt === undefined ||
    parsed.command.slaBreachObservedAt !== undefined ||
    now() - conditionMetAt < wakeSlaMs
  ) {
    return parsed;
  }
  const observedAt = now();
  const updated = deps.dynamicTaskStore.updateParamsIfCurrent(parsed.task.id, parsed.task.params, {
    ...parsed.task.params,
    holdLifecycle: {
      ...parsed.lifecycle,
      managedCommand: { ...parsed.command, slaBreachObservedAt: observedAt },
    },
  });
  if (!updated) return parsed;
  managedCommandWakeSlaBreachTotal.add(1);
  log.warn(
    {
      taskId: parsed.task.id,
      threadId: parsed.threadId,
      messageId: parsed.command.messageId,
      conditionMetAt,
      observedAt,
    },
    'managed-command completion wake exceeded SLA',
  );
  return parseManagedCommandWakeTask(deps.dynamicTaskStore.getById(parsed.task.id)) ?? parsed;
}
