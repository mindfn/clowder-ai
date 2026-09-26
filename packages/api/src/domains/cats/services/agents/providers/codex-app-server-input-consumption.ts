import type { AgentClientInputConsumption } from '../../types.js';
import { asCodexAppServerRecord } from './CodexAppServerEventMapper.js';

type Settle = (consumption: AgentClientInputConsumption) => void;

/**
 * F117 Phase M: when did a steered input enter the Codex thread?
 *
 * `turn/steer` accepting an input is a promise, not a fact: the app-server injects it at the next
 * model boundary, which can be minutes later (after a long command, or behind a compaction). The
 * injection is a `userMessage` thread item carrying the `clientUserMessageId` we sent as its
 * `clientId` (verified on codex-cli 0.156.0), so the item's arrival is the read time. A run that
 * ends before the item arrives never read the input.
 */
export class CodexAppServerInputConsumption {
  private readonly pending = new Map<string, Settle>();
  private closed = false;

  constructor(
    private readonly threadId: string,
    private readonly now: () => number = Date.now,
  ) {}

  expect(clientId: string): Promise<AgentClientInputConsumption> {
    if (this.closed) return Promise.resolve({ consumed: false });
    return new Promise((resolve) => this.pending.set(clientId, resolve));
  }

  withdraw(clientId: string): void {
    this.settle(clientId, { consumed: false });
  }

  observe(envelope: unknown): void {
    if (this.pending.size === 0) return;
    const record = asCodexAppServerRecord(envelope);
    if (record?.method !== 'item/started' && record?.method !== 'item/completed') return;
    const params = asCodexAppServerRecord(record.params);
    const item = asCodexAppServerRecord(params?.item);
    if (params?.threadId !== this.threadId || item?.type !== 'userMessage') return;
    if (typeof item.clientId === 'string') this.settle(item.clientId, { consumed: true, at: this.now() });
  }

  close(): void {
    this.closed = true;
    for (const clientId of [...this.pending.keys()]) this.settle(clientId, { consumed: false });
  }

  private settle(clientId: string, consumption: AgentClientInputConsumption): void {
    const settle = this.pending.get(clientId);
    if (!settle) return;
    this.pending.delete(clientId);
    settle(consumption);
  }
}
