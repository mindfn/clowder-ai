import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type { StoredMessage } from '../../stores/ports/MessageStore.js';
import type { AgentMessage } from '../../types.js';
import { type InvocationParams, invokeSingleCat } from '../invocation/invoke-single-cat.js';
import { accumulateTextAggregate } from '../text-aggregation.js';
import type { RouteOptions, RouteStrategyDeps } from './route-helpers.js';

const log = createModuleLogger('plugin-route');

/** Shared terminal/output handling, after a lane has validated and built its isolated child input. */
export async function* routeIsolatedPluginChild(
  deps: RouteStrategyDeps,
  params: InvocationParams,
  options: Pick<RouteOptions, 'beforeOutputCommit' | 'persistenceContext' | 'parentInvocationId'>,
  lane: 'public' | 'task',
): AsyncIterable<AgentMessage> {
  const { userId, threadId, catId } = params;
  let childId: string | undefined;
  let text = '';
  let done: AgentMessage | undefined;
  let failed = false;
  const signal = params.signal;
  for await (const event of invokeSingleCat(deps.invocationDeps, params)) {
    if (event.turnInvocationId) {
      if (childId && childId !== event.turnInvocationId) throw new Error(`${lane}_route_child_changed`);
      childId = event.turnInvocationId;
    }
    if (event.type === 'text') {
      text = accumulateTextAggregate(text, event.content ?? '', event.textMode);
      continue;
    }
    if (event.type === 'error') failed = true;
    if (event.type === 'done') {
      if (done || !childId) throw new Error(`${lane}_route_done_invalid`);
      done = event;
      continue;
    }
    yield event;
  }
  const child = childId ? await deps.invocationDeps.turnExecutionStore?.get(childId) : null;
  if (failed || !done || !childId || child?.status !== 'succeeded') throw new Error(`${lane}_route_child_unsuccessful`);
  signal?.throwIfAborted();
  if (text.trim()) {
    if (options.beforeOutputCommit && !(await options.beforeOutputCommit(catId)))
      throw new Error(`${lane}_route_output_rejected`);
    signal?.throwIfAborted();
    // A Host transcript is not a plugin reply receipt. Do not attach source-response
    // evidence: a successful plugin turn may legitimately produce no business reply.
    let message: StoredMessage | undefined;
    try {
      message = await deps.messageStore.append({
        userId,
        threadId,
        catId,
        content: text,
        timestamp: Date.now(),
        mentions: [],
        origin: 'stream',
        extra: { stream: { invocationId: options.parentInvocationId ?? childId, turnInvocationId: childId } },
      });
    } catch (error) {
      // Never publish an unpersisted transcript or reinterpret a completed native
      // execution as retryable just because its optional Host transcript failed.
      log.error({ error, threadId, invocationId: childId, lane }, 'Plugin execution transcript was not persisted');
    }
    if (message) {
      options.persistenceContext?.persistedOutputMessageIds?.push(message.id);
      yield {
        type: 'text',
        catId,
        content: message.content,
        textMode: 'replace',
        timestamp: message.timestamp,
        turnInvocationId: childId,
      };
    }
  }
  yield done;
}
