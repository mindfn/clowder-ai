/** Internal proof readiness; deliberately independent of callback admission and scan completion. */
export class TerminalProofRecoveryBarrier {
  private ready = false;
  isReady(): boolean {
    return this.ready;
  }
  markReady(): void {
    this.ready = true;
  }
}

/** Startup owns the only readiness transition. A failed stage leaves a fresh barrier closed. */
export async function recoverTerminalProofs<Auth, Children>(input: {
  barrier: TerminalProofRecoveryBarrier;
  reconcileAuth(): Promise<Auth>;
  reconcileChildren(): Promise<Children>;
}): Promise<{ authRecovery: Auth; childRecovery: Children }> {
  if (input.barrier.isReady()) throw new Error('Terminal proof recovery already completed');
  const authRecovery = await input.reconcileAuth();
  const childRecovery = await input.reconcileChildren();
  input.barrier.markReady();
  return { authRecovery, childRecovery };
}
