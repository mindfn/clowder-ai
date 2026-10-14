import type { AgentMessage, AgentServiceOptions } from '../../types.js';
import { type ScopedSessionInput, ScopedSessionOwner } from './collective-scoped-session-owner.js';

/** Real provider lifecycle, without borrowing ordinary home context or resume custody. */
export async function* recordCollectiveScopedSession(
  input: ScopedSessionInput & {
    readonly stream: (
      beforeProviderLaunch: NonNullable<AgentServiceOptions['beforeProviderLaunch']>,
    ) => AsyncIterable<AgentMessage>;
  },
): AsyncIterable<AgentMessage> {
  const owner = await ScopedSessionOwner.open(input);
  let terminal: AgentMessage | undefined;
  let failed = false;
  let caught = false;
  try {
    await owner.append({
      type: 'system_info',
      catId: input.catId,
      timestamp: input.startedAt,
      content: JSON.stringify({
        type: 'invocation_created',
        invocationId: input.scope.invocationId,
        startedAt: input.startedAt,
        executionScope: input.scope.executionScope,
      }),
    });
    const started = owner.metrics('session_started');
    await owner.append(started);
    yield started;
    for await (const message of input.stream(owner.beforeProviderLaunch)) {
      await owner.recordProviderMessage(message);
      if (message.type === 'error') failed = true;
      if (message.type === 'done') {
        terminal = message;
        continue;
      }
      yield message;
      if (message.type === 'session_init' && message.sessionId) {
        const bound = owner.metrics('session_started');
        await owner.append(bound);
        yield bound;
      }
    }
    if (!terminal) throw new Error('collective_session_provider_terminal_missing');
    yield await owner.complete(failed);
    yield terminal;
  } catch (cause) {
    caught = true;
    await owner.fail(cause);
    throw cause;
  } finally {
    await owner.close(caught, Boolean(terminal));
  }
}
