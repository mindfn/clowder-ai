import { readFileSync } from 'node:fs';

export function cleanupOwnerResultPath(completionPath) {
  return completionPath ? `${completionPath}.owner.json` : null;
}

export function readCleanupOwnerResult(path, processGroupId) {
  if (!path) return { status: 'unclaimed' };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      value.processGroupId === processGroupId &&
      Number.isInteger(value.exitCode) &&
      value.exitCode >= 0 &&
      value.exitCode <= 255
    )
      return { status: 'complete', exitCode: value.exitCode };
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'unclaimed' };
  }
  return { status: 'unproven' };
}

function reportedCleanupExitCode({ outcome, owner, shutdownRequested }) {
  if (owner.exitCode !== 0) return owner.exitCode;
  const expectedStop =
    shutdownRequested && (['SIGTERM', 'SIGINT'].includes(outcome.signal) || [130, 143].includes(outcome.code));
  return expectedStop ? 0 : (outcome.code ?? 1);
}

export function previewCleanupExitCode({
  outcome,
  graceful,
  owner,
  descendantsRemain,
  shutdownRequested,
  requireOwnerResult,
}) {
  if (!graceful || owner.status === 'unproven') return 1;
  if (owner.status === 'complete') return reportedCleanupExitCode({ outcome, owner, shutdownRequested });
  // Managed launches require their owner's result on requested shutdown.
  // No process snapshot or wrapper exit (even zero) proves cleanup succeeded.
  if (descendantsRemain) return 1;
  if (shutdownRequested) {
    if (requireOwnerResult) return 1;
    // Bare legacy runner invocations have no completion record and retain only
    // their process-termination contract, never a resource-cleanup promise.
    const expectedSignal = ['SIGTERM', 'SIGINT'].includes(outcome.signal);
    return expectedSignal ? 0 : (outcome.code ?? 1);
  }
  // Natural command completion retains its exit status, not a cleanup promise.
  return outcome.code ?? 1;
}
