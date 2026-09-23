import type { ITurnExecutionStore, TurnExecutionRecord } from '../../stores/ports/TurnExecutionStore.js';

interface TurnExecutionStartupReconcilerDeps {
  store: ITurnExecutionStore;
  now?: () => number;
  /** F117 KD-21: ends each interrupted turn's response R with the body its draft streamed. */
  settleInterruptedResponse?: (turn: TurnExecutionRecord) => Promise<unknown>;
}

export interface TurnExecutionStartupReconcileResult {
  interruptedCount: number;
  invocationIds: string[];
  /** Interrupted turns whose response R did not settle; their drafts are kept. */
  responseSettlementFailures: Array<{ invocationId: string; error: string }>;
  reconciledAt: number;
}

interface ListenBeforeTurnExecutionRecoveryDeps<T> {
  listen: () => Promise<T>;
  recover: () => Promise<unknown>;
  onRecoveryError: (error: unknown) => void;
}

/**
 * A durable restart terminal may only be written after this process proves it
 * owns both the Redis namespace and the HTTP listener. Recovery is best-effort
 * once listening succeeds; a recovery failure must not tear down a healthy API.
 */
export async function listenBeforeTurnExecutionRecovery<T>(deps: ListenBeforeTurnExecutionRecoveryDeps<T>): Promise<T> {
  const address = await deps.listen();
  try {
    await deps.recover();
  } catch (error) {
    deps.onRecoveryError(error);
  }
  return address;
}

export class TurnExecutionStartupReconciler {
  private readonly store: ITurnExecutionStore;
  private readonly now: () => number;
  private readonly settleInterruptedResponse: TurnExecutionStartupReconcilerDeps['settleInterruptedResponse'];

  constructor(deps: TurnExecutionStartupReconcilerDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.settleInterruptedResponse = deps.settleInterruptedResponse;
  }

  async reconcile(input: {
    processStartedAt: number;
    protectedInvocationIds?: readonly string[];
  }): Promise<TurnExecutionStartupReconcileResult> {
    if (!Number.isFinite(input.processStartedAt) || input.processStartedAt < 0) {
      throw new Error('processStartedAt must be a finite non-negative number');
    }
    const reconciledAt = this.now();
    // A persisted child stamped in the same millisecond as process start still
    // belongs to the previous process. The store takes an exclusive cutoff; +1
    // includes that exact millisecond without changing its reusable contract.
    const exclusiveCutoffStartedAt = input.processStartedAt + 1;
    const interrupted = await this.store.interruptRunningBefore(exclusiveCutoffStartedAt, {
      endedAt: reconciledAt,
      terminalReason: 'process_restart',
      ...(input.protectedInvocationIds?.length
        ? { excludedInvocationIds: [...new Set(input.protectedInvocationIds)] }
        : {}),
    });
    // One response that cannot settle must neither strand the others nor fail startup recovery.
    const responseSettlementFailures: TurnExecutionStartupReconcileResult['responseSettlementFailures'] = [];
    for (const turn of this.settleInterruptedResponse ? interrupted : []) {
      try {
        await this.settleInterruptedResponse?.(turn);
      } catch (error) {
        responseSettlementFailures.push({ invocationId: turn.invocationId, error: String(error) });
      }
    }
    return {
      interruptedCount: interrupted.length,
      invocationIds: interrupted.map((record) => record.invocationId),
      responseSettlementFailures,
      reconciledAt,
    };
  }
}
