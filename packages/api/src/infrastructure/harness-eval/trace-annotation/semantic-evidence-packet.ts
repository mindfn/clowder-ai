import type { ObservedSegment, TraceEpisode, TraceToolCall } from '@cat-cafe/shared';
import type { SemanticEpisodeContext } from './SemanticSweepService.js';

export const SEMANTIC_EVIDENCE_PROJECTION_VERSION = 2 as const;
export const MAX_SEMANTIC_TOOL_CALLS = 24;
export const MAX_SEMANTIC_RESULT_DETAIL_CHARS = 320;
export const MAX_SEMANTIC_CONTEXT_MESSAGES = 4;
export const MAX_SEMANTIC_CONTEXT_MESSAGE_CHARS = 480;
export const MAX_SEMANTIC_TERMINAL_TEXT_CHARS = 1_500;

export interface SemanticObservedSegment {
  segmentId: string;
  stage: ObservedSegment['stage'];
  status: ObservedSegment['status'];
  contentHash: string | null;
  charCount: number;
  tokenEstimate: number;
  version?: number;
  pipelineStatus?: string;
  reasonCode?: string;
  reason?: string;
  disabledBy?: string;
  contentSourceKind?: ObservedSegment['contentSourceKind'];
  templateRef?: string | null;
}

export interface SemanticTraceToolCall extends Omit<TraceToolCall, 'resultDetail'> {
  resultDetail?: string;
}

export interface SemanticEpisodeEvidencePacket {
  invocationId: string;
  traceTurnId: string;
  threadId: string;
  catId: string;
  terminalAt: number;
  terminalKind: string;
  toolCallCount: number;
  toolCallsOmitted: number;
  toolCalls: SemanticTraceToolCall[];
  segments: SemanticObservedSegment[];
  inputText: string | null;
  outputText: string | null;
  contextMessages: Array<{ messageId: string; catId: string | null; content: string }>;
}

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n…[truncated]`;
}

function projectSegment(segment: ObservedSegment): SemanticObservedSegment {
  return {
    segmentId: segment.segmentId,
    stage: segment.stage,
    status: segment.status,
    contentHash: segment.contentHash,
    charCount: segment.charCount,
    tokenEstimate: segment.tokenEstimate,
    ...(segment.version !== undefined ? { version: segment.version } : {}),
    ...(segment.pipelineStatus !== undefined ? { pipelineStatus: segment.pipelineStatus } : {}),
    ...(segment.reasonCode !== undefined ? { reasonCode: segment.reasonCode } : {}),
    ...(segment.reason !== undefined ? { reason: bounded(segment.reason, 240) } : {}),
    ...(segment.disabledBy !== undefined ? { disabledBy: segment.disabledBy } : {}),
    ...(segment.contentSourceKind !== undefined ? { contentSourceKind: segment.contentSourceKind } : {}),
    ...(segment.templateRef !== undefined
      ? { templateRef: segment.templateRef === null ? null : bounded(segment.templateRef, 240) }
      : {}),
  };
}

function selectToolCalls(toolCalls: readonly TraceToolCall[]): readonly TraceToolCall[] {
  if (toolCalls.length <= MAX_SEMANTIC_TOOL_CALLS) return toolCalls;
  const edge = MAX_SEMANTIC_TOOL_CALLS / 2;
  return [...toolCalls.slice(0, edge), ...toolCalls.slice(-edge)];
}

function projectToolCall(toolCall: TraceToolCall): SemanticTraceToolCall {
  return {
    toolName: toolCall.toolName,
    ...(toolCall.callId ? { callId: toolCall.callId } : {}),
    outcome: toolCall.outcome,
    ...(toolCall.resultDetail
      ? { resultDetail: bounded(toolCall.resultDetail, MAX_SEMANTIC_RESULT_DETAIL_CHARS) }
      : {}),
  };
}

/**
 * Project canonical TraceEpisode evidence into a deterministic prompt-sized view.
 * Raw episodes and replay snapshots remain untouched; this is only the eval-cat
 * transport shape. First+last tool calls preserve setup and terminal behavior.
 */
export function projectSemanticEpisodeEvidence(context: SemanticEpisodeContext): SemanticEpisodeEvidencePacket {
  const { episode } = context;
  const selectedToolCalls = selectToolCalls(episode.terminal.toolCalls);
  return {
    invocationId: episode.terminal.invocationId,
    traceTurnId: episode.terminal.traceTurnId,
    threadId: episode.terminal.threadId,
    catId: episode.terminal.catId,
    terminalAt: episode.terminal.terminalAt,
    terminalKind: episode.terminal.terminalKind,
    toolCallCount: episode.terminal.toolCalls.length,
    toolCallsOmitted: episode.terminal.toolCalls.length - selectedToolCalls.length,
    toolCalls: selectedToolCalls.map(projectToolCall),
    segments: episode.summary.segments.map(projectSegment),
    inputText: context.inputText === null ? null : bounded(context.inputText, MAX_SEMANTIC_TERMINAL_TEXT_CHARS),
    outputText: context.outputText === null ? null : bounded(context.outputText, MAX_SEMANTIC_TERMINAL_TEXT_CHARS),
    contextMessages: (context.contextMessages ?? []).slice(-MAX_SEMANTIC_CONTEXT_MESSAGES).map((message) => ({
      messageId: message.messageId,
      catId: message.catId,
      content: bounded(message.content, MAX_SEMANTIC_CONTEXT_MESSAGE_CHARS),
    })),
  };
}

export function projectSemanticEpisodeEvidenceForVersion(
  context: SemanticEpisodeContext,
  version: number | undefined,
): SemanticEpisodeEvidencePacket | LegacySemanticEpisodeEvidencePacket {
  if (version === SEMANTIC_EVIDENCE_PROJECTION_VERSION) return projectSemanticEpisodeEvidence(context);
  return projectLegacyPacket(context);
}

export interface LegacySemanticEpisodeEvidencePacket {
  invocationId: string;
  traceTurnId: string;
  threadId: string;
  catId: string;
  terminalAt: number;
  terminalKind: string;
  toolCalls: TraceEpisode['terminal']['toolCalls'];
  segments: TraceEpisode['summary']['segments'];
  inputText: string | null;
  outputText: string | null;
  contextMessages: Array<{ messageId: string; catId: string | null; content: string }>;
}

function projectLegacyPacket(context: SemanticEpisodeContext): LegacySemanticEpisodeEvidencePacket {
  const { episode } = context;
  return {
    invocationId: episode.terminal.invocationId,
    traceTurnId: episode.terminal.traceTurnId,
    threadId: episode.terminal.threadId,
    catId: episode.terminal.catId,
    terminalAt: episode.terminal.terminalAt,
    terminalKind: episode.terminal.terminalKind,
    toolCalls: episode.terminal.toolCalls,
    segments: episode.summary.segments,
    inputText: context.inputText,
    outputText: context.outputText,
    contextMessages: context.contextMessages ?? [],
  };
}
