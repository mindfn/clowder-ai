import type { CatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type { StoredMessage } from '../../stores/ports/MessageStore.js';
import type { AgentMessage } from '../../types.js';
import { invokeSingleCat } from '../invocation/invoke-single-cat.js';
import { accumulateTextAggregate } from '../text-aggregation.js';
import type { RouteOptions, RouteStrategyDeps } from './route-helpers.js';

const log = createModuleLogger('public-route');

/** Isolated execution precedes owner history; business replies belong to the plugin's native methods. */
export async function* routePublicInvocation(
  deps: RouteStrategyDeps,
  input: {
    userId: string;
    threadId: string;
    userMessageId: string;
    targetCats: readonly CatId[];
    options: RouteOptions;
  },
): AsyncIterable<AgentMessage> {
  const { userId, threadId, userMessageId, options } = input;
  const binding = options.publicInvocationBinding;
  const catId = input.targetCats[0];
  if (
    !binding ||
    !options.publicInvocationExecution ||
    input.targetCats.length !== 1 ||
    !catId ||
    binding.carrier.targetCatId !== catId ||
    binding.carrier.sourceMessageId !== userMessageId ||
    options.ownerAuthProvenance !== 'unknown' ||
    !options.onPromptMessagesExposed ||
    options.contentBlocks?.length ||
    options.liveCompanion ||
    options.memoryCueOpportunitySeeds?.length ||
    options.asrPersonMemoryScenes?.length
  )
    throw new Error('public_route_identity_invalid');
  const service = deps.services[catId];
  if (!service) throw new Error('public_route_service_unavailable');
  let childId: string | undefined;
  let text = '';
  let done: AgentMessage | undefined;
  let failed = false;
  const signal = options.signalForCat?.(catId) ?? options.signal;
  for await (const event of invokeSingleCat(deps.invocationDeps, {
    catId,
    userId,
    threadId,
    service,
    prompt: '',
    isLastCat: true,
    ownerAuthProvenance: 'unknown',
    publicInvocationBinding: binding,
    publicInvocationExecution: options.publicInvocationExecution,
    toolExecutionPolicy: options.toolExecutionPolicy,
    parentInvocationId: options.parentInvocationId,
    signal,
    executionCausal: { triggerMessageId: userMessageId },
    promptMessageIds: [userMessageId],
    onPromptMessagesExposed: options.onPromptMessagesExposed,
  })) {
    if (event.turnInvocationId) {
      if (childId && childId !== event.turnInvocationId) throw new Error('public_route_child_changed');
      childId = event.turnInvocationId;
    }
    if (event.type === 'text') {
      text = accumulateTextAggregate(text, event.content ?? '', event.textMode);
      continue;
    }
    if (event.type === 'error') failed = true;
    if (event.type === 'done') {
      if (done || !childId) throw new Error('public_route_done_invalid');
      done = event;
      continue;
    }
    yield event;
  }
  const child = childId ? await deps.invocationDeps.turnExecutionStore?.get(childId) : null;
  if (failed || !done || !childId || child?.status !== 'succeeded') throw new Error('public_route_child_unsuccessful');
  signal?.throwIfAborted();
  if (text.trim()) {
    if (options.beforeOutputCommit && !(await options.beforeOutputCommit(catId)))
      throw new Error('public_route_output_rejected');
    signal?.throwIfAborted();
    // A Host transcript is not a plugin reply receipt. Do not attach source-response
    // evidence: a successful public turn may legitimately produce no business reply.
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
      log.error({ error, threadId, invocationId: childId }, 'Public execution transcript was not persisted');
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
