import type { CiPollResult } from './ci-cd-contract.js';

/** A ceiling, not a working size: entries are dropped once their PR stops needing details. */
const MAX_REMEMBERED = 256;

interface Remembered {
  readonly rollup: string;
  readonly details: CiPollResult;
}

/** The batch rollup a detail read describes. A rerun creates check runs with new links. */
function rollupOf(poll: CiPollResult): string | undefined {
  if (!poll.failureDetailsPending || poll.fullRollupPending) return undefined;
  const checks = poll.checks
    .map((check) => JSON.stringify([check.name, check.bucket, check.link, check.workflow, check.description]))
    .sort();
  return JSON.stringify([poll.headSha, poll.prState, poll.aggregateBucket, poll.checkRollup, checks]);
}

/**
 * Failure details (a PR's required checks and their typed execution failures) take several
 * serialized `gh` reads. They are a function of the rollup they describe: the same HEAD with the
 * same check runs in the same states has the same details, because a failed run is finished.
 * Read again on every tick for as long as a PR stayed red, they kept the shared per-credential
 * GitHub lane busy enough to starve every other collector.
 *
 * Only a successful read that still agrees with the batch it was taken for is remembered.
 */
export class FailureDetailMemo {
  private readonly remembered = new Map<string, Remembered>();

  /** Details already read for exactly this rollup, carrying this batch's observation time. */
  recall(key: string, poll: CiPollResult): CiPollResult | undefined {
    const rollup = rollupOf(poll);
    const entry = this.remembered.get(key);
    if (rollup === undefined || entry?.rollup !== rollup) return undefined;
    const { observedAt: _readAt, ...details } = entry.details;
    return poll.observedAt === undefined ? details : { ...details, observedAt: poll.observedAt };
  }

  remember(key: string, poll: CiPollResult, details: CiPollResult): void {
    this.remembered.delete(key);
    const rollup = rollupOf(poll);
    // A read that disagrees with the batch saw newer truth; route it, but it describes no rollup.
    const agrees =
      details.headSha === poll.headSha &&
      details.prState === poll.prState &&
      details.aggregateBucket === poll.aggregateBucket;
    if (rollup === undefined || !agrees) return;
    this.remembered.set(key, { rollup, details });
    const oldest = this.remembered.keys().next().value;
    if (this.remembered.size > MAX_REMEMBERED && oldest !== undefined) this.remembered.delete(oldest);
  }

  forget(key: string): void {
    this.remembered.delete(key);
  }
}
