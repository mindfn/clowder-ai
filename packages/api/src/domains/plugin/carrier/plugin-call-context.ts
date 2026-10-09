import { AsyncLocalStorage } from 'node:async_hooks';

/** Host-verified caller metadata, separate from the package's business input. */
export interface PluginCallContext {
  readonly catId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly invocationId: string;
  readonly source?: {
    readonly kind: 'primary' | 'adopted_hold';
    readonly sourceMessageId: string;
    readonly holdTaskId?: string;
  };
  /** Recheck the local activation and invoking turn after asynchronous provider work. */
  assertCurrent(): Promise<void>;
}

const calls = new AsyncLocalStorage<{ instanceId: string; context: PluginCallContext }>();
export function currentPluginCallContext(instanceId: string | undefined): PluginCallContext | undefined {
  const call = calls.getStore();
  return call?.instanceId === instanceId ? call?.context : undefined;
}
export function withPluginCallContext<T>(
  instanceId: string,
  context: PluginCallContext,
  run: () => Promise<T>,
): Promise<T> {
  return calls.run({ instanceId, context }, run);
}
