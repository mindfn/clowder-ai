/** Host-only mechanism. Production needs an independently established writer topology. */
export class ProcessLocalProofAdmissionSection {
  private tail: Promise<unknown> = Promise.resolve();
  private epoch = 0;

  revision(): number {
    return this.epoch;
  }

  invalidate<T>(mutation: () => Promise<T>): Promise<T> {
    // Invalidate pending observations immediately; let an already admitted write finish.
    this.epoch += 1;
    return this.serialize(mutation);
  }

  admit<T>(revision: number, valid: () => Promise<boolean>, mutation: () => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      if (!(await valid()) || revision !== this.epoch) throw new ProofAdmissionUnavailable();
      // Linearization point. No await between this check and entering mutation.
      // Never turn a completed write into a retrospective zero-write rejection.
      return mutation();
    });
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class ProofAdmissionUnavailable extends Error {
  constructor() {
    super('Review coverage admission is unavailable');
  }
}

/** Opaque, carrier-owned closures. Never sent to or constructed by package code. */
export interface HostProofActivation {
  isCurrent(): boolean;
  invoke(method: string, params: unknown): Promise<unknown>;
}
