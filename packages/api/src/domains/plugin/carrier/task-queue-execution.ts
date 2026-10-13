import { isDeepStrictEqual } from 'node:util';
import type { InvocationRegistry } from '../../cats/services/agents/invocation/InvocationRegistry.js';
import { pluginTaskCurrentnessInput } from '../../cats/services/agents/invocation/plugin-task-invocation-binding.js';
import type { PublicInvocationExecution } from '../../cats/services/agents/invocation/public-invocation-execution.js';
import type { PluginRuntimeCarrierRouter } from './runtime-carrier.js';

/** A stored record locates the child; only verifyLatest plus the Host Task reader authorizes it. */
export function createTaskQueueExecution(
  registry: Pick<InvocationRegistry, 'getRecord' | 'verifyLatest'>,
  runtime: () => Pick<PluginRuntimeCarrierRouter, 'prepareTaskInvocationExecution'>,
): PublicInvocationExecution {
  return Object.freeze({
    async prepare(input: Parameters<PublicInvocationExecution['prepare']>[0]) {
      const { invocationId, sourceMessageId, signal } = input;
      signal.throwIfAborted();
      const record = await registry.getRecord(invocationId);
      if (!record) throw new Error('task_queue_auth_missing');
      const principal = pluginTaskCurrentnessInput(record);
      if (principal.invocationId !== invocationId || principal.pluginTaskBinding.triggerMessageId !== sourceMessageId)
        throw new Error('task_queue_auth_mismatch');
      const token = record.callbackToken;
      const lifetime = new AbortController();
      const assertCurrent = async () => {
        try {
          signal.throwIfAborted();
          lifetime.signal.throwIfAborted();
          const current = await registry.verifyLatest(invocationId, token);
          if (!current.ok || !isDeepStrictEqual(pluginTaskCurrentnessInput(current.record), principal))
            throw new Error('task_queue_auth_expired');
          signal.throwIfAborted();
          lifetime.signal.throwIfAborted();
        } catch (error) {
          lifetime.abort(error);
          throw error;
        }
      };
      await assertCurrent();
      return runtime().prepareTaskInvocationExecution(principal, { signal, assertCurrent });
    },
  });
}
