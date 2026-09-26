import type { AgentClientInputConsumption } from '../../types.js';

/**
 * The SDK version whose untyped `command_lifecycle` frame was verified live
 * (packages/api/scripts/f117-sdk-read-evidence-contract.mjs). A contract test pins it, so an SDK
 * upgrade that drops the frame fails loudly instead of quietly delaying every "read" to the result.
 */
export const COMMAND_LIFECYCLE_VERIFIED_SDK_VERSION = '0.3.280';

type Settle = (consumption: AgentClientInputConsumption) => void;

function isTopLevel(event: Record<string, unknown>): boolean {
  return event.parent_tool_use_id === null || event.parent_tool_use_id === undefined;
}

/** A frame the model produced for our main thread; a subagent's or an API error's frame proves nothing. */
function isModelOutputFrame(event: Record<string, unknown>): boolean {
  if (!isTopLevel(event)) return false;
  if (event.type === 'assistant') return event.error === undefined;
  if (event.type !== 'stream_event') return false;
  const streamed = event.event as { type?: unknown } | undefined;
  return streamed?.type !== 'ping';
}

function echoedInputIds(event: Record<string, unknown>): string[] {
  const ids: string[] = [];
  if (Array.isArray(event.user_message_uuids)) {
    for (const id of event.user_message_uuids) if (typeof id === 'string') ids.push(id);
  }
  if (typeof event.user_message_uuid === 'string') ids.push(event.user_message_uuid);
  return ids;
}

/**
 * F117 Phase M: when did the model read an input pushed into a running SDK query?
 *
 * SDK 0.3.280 folds a queued input into the running turn at the next tool boundary, or runs it as a
 * later internal turn. Two kinds of provider evidence exist:
 * - The engine's untyped `command_lifecycle` frame. `started` means the next API call carries the
 *   input, not that the model saw it — that call can still abort before it produces anything. So the
 *   input is read at the first top-level model frame after `started`: one frame late, never early.
 * - The documented echo of the input's client uuid in `user_message_uuid(s)`, on the first frames of
 *   a turn the input starts, or for an input folded into a typed-prompt turn only on its result. An
 *   API-error frame or error result is no proof, so it is not counted.
 * Acceptance, the engine's own `queued` state, or a query that closes first is never consumption.
 */
export class ClaudeSdkInputConsumption {
  private readonly pending = new Map<string, Settle>();
  private readonly started = new Set<string>();
  private closed = false;

  constructor(private readonly now: () => number = Date.now) {}

  /** Register before the input can reach the engine; settles once, never rejects. */
  expect(uuid: string): Promise<AgentClientInputConsumption> {
    if (this.closed) return Promise.resolve({ consumed: false });
    return new Promise((resolve) => this.pending.set(uuid, resolve));
  }

  /** An input that never reached the engine was not read. */
  withdraw(uuid: string): void {
    this.settle(uuid, { consumed: false });
  }

  observe(event: Record<string, unknown>): void {
    if (this.pending.size === 0) return;
    if (event.type === 'command_lifecycle') {
      const id = event.command_uuid;
      if (typeof id !== 'string' || !this.pending.has(id)) return;
      if (event.state === 'started') this.started.add(id);
      else if (event.state === 'cancelled') this.settle(id, { consumed: false });
      return;
    }
    const echoCounts = event.type === 'result' ? event.is_error !== true : isModelOutputFrame(event);
    if (!echoCounts) return;
    const at = this.now();
    for (const id of echoedInputIds(event)) this.settle(id, { consumed: true, at });
    if (event.type !== 'result') for (const id of [...this.started]) this.settle(id, { consumed: true, at });
  }

  /** The query is over: whatever was not read by now never will be in this run. */
  close(): void {
    this.closed = true;
    for (const uuid of [...this.pending.keys()]) this.settle(uuid, { consumed: false });
  }

  private settle(uuid: string, consumption: AgentClientInputConsumption): void {
    const settle = this.pending.get(uuid);
    if (!settle) return;
    this.pending.delete(uuid);
    this.started.delete(uuid);
    settle(consumption);
  }
}
