import { cleanCliToolLabel, projectCliToolUseLabel } from '../cli-tool-label.js';

/** Minimum provider-neutral shape needed to project one visible tool record. */
export interface CliToolProjectionEvent {
  id: string;
  type: 'tool_use' | 'tool_result';
  label: string;
  detail?: string;
  toolUseId?: string;
  status?: string;
}

/** One call as the v2 reply record paints it. */
export interface CliToolProjectionRow {
  id: string;
  label: string;
  detail?: string;
  failed: boolean;
  settled: boolean;
}

interface PendingCliToolCall {
  row: CliToolProjectionRow | null;
  toolUseId?: string;
  settled: boolean;
}

interface CliToolProjectionState {
  rows: CliToolProjectionRow[];
  byUseKey: Map<string, PendingCliToolCall>;
  pendingCalls: PendingCliToolCall[];
}

function appendCliToolUse(state: CliToolProjectionState, event: CliToolProjectionEvent): void {
  const hidden = cleanCliToolLabel(event.label) === 'unknown';
  const row: CliToolProjectionRow | null = hidden
    ? null
    : {
        id: event.id,
        label: projectCliToolUseLabel(event.label, event.detail),
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
        failed: false,
        settled: false,
      };
  const pending: PendingCliToolCall = {
    row,
    ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
    settled: false,
  };
  state.pendingCalls.push(pending);
  if (row) state.rows.push(row);
  if (event.toolUseId) state.byUseKey.set(event.toolUseId, pending);
}

function takeNextPendingCliToolCall(state: CliToolProjectionState): PendingCliToolCall | undefined {
  while (state.pendingCalls.length > 0) {
    const pending = state.pendingCalls.shift();
    if (pending && !pending.settled) return pending;
  }
  return undefined;
}

function appendCliToolResult(state: CliToolProjectionState, event: CliToolProjectionEvent): void {
  const pending = event.toolUseId ? state.byUseKey.get(event.toolUseId) : takeNextPendingCliToolCall(state);
  if (!pending) return;
  pending.settled = true;
  if (pending.toolUseId) state.byUseKey.delete(pending.toolUseId);
  if (!pending.row) return;
  if (event.detail !== undefined) pending.row.detail = event.detail;
  pending.row.failed = event.status === 'error';
  pending.row.settled = true;
}

/**
 * Canonical keyed/FIFO pairing for the v2 reply record and its versioned quote
 * plane. Hidden calls keep their FIFO slot; keyed orphan results fail closed.
 */
export function projectCliToolEventRows(events: readonly CliToolProjectionEvent[]): CliToolProjectionRow[] {
  const state: CliToolProjectionState = { rows: [], byUseKey: new Map(), pendingCalls: [] };
  for (const event of events) {
    if (event.type === 'tool_use') appendCliToolUse(state, event);
    else appendCliToolResult(state, event);
  }
  return state.rows;
}
