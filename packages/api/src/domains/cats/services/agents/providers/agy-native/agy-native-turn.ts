import type { CatId } from '@cat-cafe/shared';
import { isCliError, isCliTimeout } from '../../../../../../utils/cli-spawn.js';
import { sanitizeCliStderr } from '../../../../../../utils/sanitize-cli-stderr.js';
import type { AgentMessage, MessageMetadata } from '../../../types.js';
import {
  type AgyStreamJsonEvent,
  type AgyStreamJsonTurn,
  parseAgyStreamJsonLine,
  summarizeAgyStreamJsonTurn,
} from '../agy-stream-json-parser.js';
import { AgyNativeResumeMismatchError } from './agy-native-errors.js';
import type { AgyNativePermissionMode } from './agy-native-policy.js';
import { agyNativeToolIdentity, agyNativeToolResultContent } from './agy-native-tool-result.js';
import { AGY_NATIVE_MCP_TOOLS, AGY_NATIVE_PROTOCOL_TOOLS, AGY_NATIVE_TOOLS } from './agy-native-tools.js';

export interface AgyNativeObservedTurn {
  readonly sessionId: string;
  readonly turn: AgyStreamJsonTurn;
  readonly transportError: string | null;
  readonly transportExit?: { readonly code: number | null; readonly signal: string | null };
  readonly cancelledBeforeTerminal?: boolean;
}

export type AgyNativeStreamObservation =
  | { readonly kind: 'init'; readonly sessionId: string }
  | { readonly kind: 'step'; readonly event: Extract<AgyStreamJsonEvent, { kind: 'step' }> }
  | { readonly kind: 'complete'; readonly observed: AgyNativeObservedTurn };

interface ExpectedNativeInit {
  readonly sessionId?: string;
  readonly agentName: string;
  readonly spawnCwd: string;
  readonly model: string;
  readonly permissionMode?: AgyNativePermissionMode;
}

const MAX_AGY_NATIVE_STREAM_CHARS = 8 * 1024 * 1024;
const MISSING_FILE_ERROR_PREFIX =
  'declaring permissions: cortex tool view_file: convert tool call for permissions: model output error: ' +
  'invalid tool call error (invalid_args) failed to read file: stat ';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function verifiedInitSessionId(record: Record<string, unknown>, expected: ExpectedNativeInit, seen: boolean): string {
  const init = asRecord(record.init);
  if (
    seen ||
    init?.agent !== expected.agentName ||
    init.cwd !== expected.spawnCwd ||
    init.permission_mode !== (expected.permissionMode ?? 'request-review') ||
    init.model !== expected.model
  ) {
    throw new Error('AGY native init disagrees with the host-owned agent, spawn cwd, model, or permission mode');
  }
  const sessionId = typeof record.conversation_id === 'string' ? record.conversation_id : '';
  if (!sessionId) throw new Error('AGY native init omitted the conversation ID');
  if (expected.sessionId && expected.sessionId !== sessionId) {
    throw new AgyNativeResumeMismatchError(
      'AGY native init replaced the requested conversation; refusing silent history loss',
    );
  }
  if (
    init.tools !== undefined &&
    (!Array.isArray(init.tools) ||
      init.tools.some((tool) => typeof tool !== 'string' || !AGY_NATIVE_PROTOCOL_TOOLS.has(tool)))
  ) {
    throw new Error('AGY native init advertised an unqualified tool vocabulary');
  }
  return sessionId;
}

function verifiedNativeTerminal(lines: readonly string[], sessionId: string, resultCount: number): AgyStreamJsonTurn {
  if (resultCount > 1) throw new Error('AGY native one-turn process emitted multiple terminal results');
  const turn = summarizeAgyStreamJsonTurn(lines);
  if (turn.conversationId && turn.conversationId !== sessionId) {
    throw new Error('AGY native terminal conversation ID disagrees with init');
  }
  return turn;
}

/** Treat init as a claim that must match the launch plan, never as proof that L0 reached the model. */
export async function* observeAgyNativeTurn(
  stream: AsyncIterable<unknown>,
  expected: ExpectedNativeInit,
  signal?: AbortSignal,
): AsyncGenerator<AgyNativeStreamObservation> {
  const lines: string[] = [];
  let sessionId: string | null = null;
  let transportError: string | null = null;
  let transportExit: AgyNativeObservedTurn['transportExit'];
  let resultCount = 0;
  let resultSeenBeforeCancellation = false;
  let streamChars = 0;
  for await (const raw of stream) {
    if (isCliError(raw) || isCliTimeout(raw)) {
      transportExit = !transportError && isCliError(raw) ? { code: raw.exitCode, signal: raw.signal } : undefined;
      transportError = raw.message;
      continue;
    }
    const record = asRecord(raw);
    if (!record) continue;
    if (record.event === 'init') {
      sessionId = verifiedInitSessionId(record, expected, sessionId !== null);
      yield { kind: 'init', sessionId };
    }
    if (record.event === 'result') {
      resultCount++;
      if (!signal?.aborted) resultSeenBeforeCancellation = true;
    }
    const line = JSON.stringify(raw);
    streamChars += line.length;
    if (streamChars > MAX_AGY_NATIVE_STREAM_CHARS)
      throw new Error('AGY native stream exceeded the bounded output limit');
    lines.push(line);
    const event = parseAgyStreamJsonLine(line);
    if (event?.kind === 'step') {
      if (!sessionId || (event.conversationId && event.conversationId !== sessionId)) {
        throw new Error('AGY native step has no matching verified init');
      }
      yield { kind: 'step', event };
    }
  }
  if (!sessionId) throw new Error('AGY native stream ended without a verified init');
  const turn = verifiedNativeTerminal(lines, sessionId, resultCount);
  yield {
    kind: 'complete',
    observed: {
      sessionId,
      turn,
      transportError,
      ...(transportExit ? { transportExit } : {}),
      cancelledBeforeTerminal: signal?.aborted === true && !resultSeenBeforeCancellation,
    },
  };
}

/** Batch consumer for probes; the service consumes observations as they arrive. */
export async function readAgyNativeTurn(
  stream: AsyncIterable<unknown>,
  expected: ExpectedNativeInit,
  signal?: AbortSignal,
): Promise<AgyNativeObservedTurn> {
  for await (const observation of observeAgyNativeTurn(stream, expected, signal)) {
    if (observation.kind === 'complete') return observation.observed;
  }
  throw new Error('AGY native stream ended without a terminal observation');
}

function projectToolMessages(catId: CatId, metadata: MessageMetadata, turn: AgyStreamJsonTurn): AgentMessage[] {
  return turn.toolCalls.flatMap((call) => {
    const toolUseId = `${metadata.sessionId}:${call.stepIndex}`;
    const identity = agyNativeToolIdentity(call.toolName, call.parameters);
    return [
      {
        type: 'tool_use' as const,
        catId,
        toolName: identity.toolName,
        toolUseId,
        toolInput: identity.toolInput,
        toolSource: identity.toolSource,
        metadata,
        timestamp: Date.now(),
      },
      {
        type: 'tool_result' as const,
        catId,
        toolName: identity.toolName,
        toolUseId,
        content: agyNativeToolResultContent(
          call.output,
          call.errorMessage,
          call.state === 'DONE' || call.state === 'ERROR',
        ),
        toolResultStatus: call.state === 'DONE' && call.errorMessage === null ? ('ok' as const) : ('error' as const),
        metadata,
        timestamp: Date.now(),
      },
    ];
  });
}

/** A missing file is a read observation, not evidence that another tool repaired a failure. */
function isMissingFileObservation(call: AgyStreamJsonTurn['toolCalls'][number]): boolean {
  if (call.toolName !== 'view_file' || call.errorMessage === null || call.output) return false;
  const path = call.parameters.AbsolutePath ?? call.parameters.TargetFile;
  if (typeof path !== 'string' || !path.trim()) return false;
  // Keep the legacy file-not-found result and the observed 1.2.14 stat failure exact.
  // This diagnostic label never changes tool or carrier success.
  return (
    call.errorMessage === 'File not found' ||
    call.errorMessage === `${MISSING_FILE_ERROR_PREFIX}${path}: no such file or directory`
  );
}

/** Keep tool evidence, usable output and carrier outcome distinct. */
export function projectAgyNativeTurn(
  catId: CatId,
  metadata: MessageMetadata,
  observed: AgyNativeObservedTurn,
  cancelled: boolean,
  declaredNativeTools: readonly string[] = [...AGY_NATIVE_TOOLS, ...AGY_NATIVE_MCP_TOOLS],
  compactionRequested = false,
): AgentMessage[] {
  const { turn, transportError } = observed;
  const completedCompactionEvidence =
    compactionRequested &&
    typeof turn.completedCompactionStep === 'number' &&
    turn.deniedActions.length === 0 &&
    turn.unknownEvents.length === 0 &&
    !cancelled;
  // Official 1.3.5 also exits 3 after a completed /compact when result carries
  // a previous turn's error. This exception is only for the proven checkpoint,
  // never ordinary work, timeout/signal, an incomplete step or a new error step.
  const retainedCompactionExit =
    completedCompactionEvidence &&
    turn.upstreamStatus === 'ERROR' &&
    turn.sessionTurnCount > 1 &&
    observed.transportExit?.code === 3 &&
    observed.transportExit.signal === null;
  const transportFailed = Boolean(transportError) && !retainedCompactionExit;
  const completedCompaction = completedCompactionEvidence && !transportFailed;
  const retainedSessionError =
    turn.outcome === 'error' &&
    turn.upstreamStatus === 'ERROR' &&
    turn.sessionTurnCount > 1 &&
    (typeof turn.completedResponseStep === 'number' || completedCompaction) &&
    turn.unknownEvents.length === 0 &&
    !transportFailed &&
    !cancelled;
  const outcome =
    retainedSessionError || (completedCompaction && turn.outcome === 'empty' && turn.upstreamStatus === 'SUCCESS')
      ? 'ok'
      : turn.outcome;
  const readObservations = turn.toolCalls.filter(isMissingFileObservation).map((call) => ({
    stepIndex: call.stepIndex,
    toolName: call.toolName,
    outcome: 'not_found' as const,
  }));
  metadata.sessionId = observed.sessionId;
  metadata.diagnostics = {
    ...metadata.diagnostics,
    agyNative: {
      ...asRecord(metadata.diagnostics?.agyNative),
      upstreamStatus: turn.upstreamStatus,
      outcome,
      ...(retainedSessionError
        ? {
            upstreamOutcome: turn.outcome,
            retainedSessionError: sanitizeCliStderr(turn.upstreamError ?? turn.diagnosis).slice(0, 2000),
            completedResponseStep: turn.completedResponseStep,
            ...(retainedCompactionExit
              ? { retainedCompactionExit: observed.transportExit, upstreamTransportError: transportError }
              : {}),
          }
        : {}),
      deniedActions: turn.deniedActions,
      sessionUsage: turn.usage,
      unknownEvents: turn.unknownEvents,
      ...(readObservations.length ? { readObservations } : {}),
    },
  };
  if (turn.turnUsage) {
    const inputTokens = turn.turnUsage.inputTokens + turn.turnUsage.cacheReadTokens;
    metadata.usage = {
      inputTokens,
      outputTokens: turn.turnUsage.outputTokens,
      totalTokens: inputTokens + turn.turnUsage.outputTokens,
      cacheReadTokens: turn.turnUsage.cacheReadTokens,
      ...(turn.lastTurnInputTokens !== null ? { lastTurnInputTokens: turn.lastTurnInputTokens } : {}),
    };
  }
  const messages: AgentMessage[] = [
    { type: 'session_init', catId, sessionId: observed.sessionId, metadata, timestamp: Date.now() },
    ...projectToolMessages(catId, metadata, turn),
  ];
  const incompleteTools = turn.toolCalls.filter((call) => call.state !== 'DONE' && call.state !== 'ERROR');
  if (incompleteTools.length) {
    messages.push({
      type: 'system_info',
      catId,
      timestamp: Date.now(),
      semanticEvent: {
        v: 1,
        id: `${observed.sessionId}:unconfirmed-tools`,
        kind: 'warning',
        occurredAt: Date.now(),
        provenance: { provider: 'google', carrier: 'native', nativeType: 'result' },
        category: 'warning',
        severity: 'warning',
        message: `Native tool results unconfirmed at turn end: ${incompleteTools.map((call) => call.toolName).join(', ')}`,
      },
    });
  }
  const tools = new Set(declaredNativeTools);
  const unexpectedTool = turn.toolCalls.find((call) => !tools.has(call.toolName));
  if (turn.finalText) {
    messages.push({ type: 'text', catId, content: turn.finalText, metadata, timestamp: Date.now() });
  }
  // A tool failure is an observation for the model, not a failed carrier turn.
  // Completion does not certify tool success. A retained session error is
  // normalized only with matching current DONE evidence and a clean transport.
  if (outcome === 'ok' && !transportFailed && !cancelled && !unexpectedTool) {
    messages.push({ type: 'done', catId, metadata, timestamp: Date.now() });
    return messages;
  }
  const errorCode = cancelled
    ? 'AGY_CANCELLED'
    : turn.outcome === 'denied'
      ? 'AGY_PERMISSION_DENIED'
      : unexpectedTool
        ? 'AGY_UNEXPECTED_TOOL'
        : 'AGY_NATIVE_FAILED';
  messages.push({
    type: 'error',
    catId,
    errorCode,
    error: cancelled
      ? 'AGY native turn was cancelled before its terminal result'
      : unexpectedTool
        ? `AGY emitted undeclared native tool ${unexpectedTool.toolName}`
        : (transportError ?? turn.diagnosis),
    metadata,
    timestamp: Date.now(),
  });
  messages.push({ type: 'done', catId, errorCode, metadata, timestamp: Date.now() });
  return messages;
}
