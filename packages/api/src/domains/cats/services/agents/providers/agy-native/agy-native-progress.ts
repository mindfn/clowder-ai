import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage, MessageMetadata } from '../../../types.js';
import type { AgyStreamJsonEvent } from '../agy-stream-json-parser.js';
import { agyNativeToolIdentity, agyNativeToolResultContent } from './agy-native-tool-result.js';

/** Incremental presentation only. Terminal authority stays with the completed turn. */
export class AgyNativeProgress {
  private readonly started = new Set<string>();
  private readonly finished = new Set<string>();
  private readonly parameters = new Map<number, Record<string, unknown>>();
  private readonly checkpoints = new Set<number>();
  private text = '';

  constructor(
    private readonly catId: CatId,
    private readonly metadata: MessageMetadata,
  ) {}

  step(event: Extract<AgyStreamJsonEvent, { kind: 'step' }>): AgentMessage[] {
    const messages: AgentMessage[] = [];
    if (
      event.stepType === 'checkpoint' &&
      event.state === 'DONE' &&
      event.conversationId === this.metadata.sessionId &&
      event.stepIndex >= 0 &&
      !this.checkpoints.has(event.stepIndex)
    ) {
      this.checkpoints.add(event.stepIndex);
      messages.push({
        type: 'status',
        catId: this.catId,
        content: 'thinking',
        metadata: this.metadata,
        timestamp: Date.now(),
        contextCompaction: {
          eventSource: 'agy_native_checkpoint',
          event: {
            eventId: `agy-native:${event.conversationId}:checkpoint:${event.stepIndex}`,
            runtimeSessionId: event.conversationId,
            evidenceRef: `agy_native_checkpoint:${event.conversationId}:${event.stepIndex}`,
          },
        },
      });
    }
    if (event.textDelta) {
      this.text += event.textDelta;
      messages.push({
        type: 'text',
        catId: this.catId,
        content: event.textDelta,
        metadata: this.metadata,
        timestamp: Date.now(),
      });
    }
    if (event.stepType !== 'tool' || !event.toolName) return messages;
    if (event.toolParameters) this.parameters.set(event.stepIndex, event.toolParameters);
    const identity = agyNativeToolIdentity(event.toolName, this.parameters.get(event.stepIndex) ?? {});
    if (event.toolName === 'call_mcp_tool' && identity.toolName === 'call_mcp_tool' && event.state === 'ACTIVE') {
      return messages;
    }
    const common = {
      catId: this.catId,
      toolName: identity.toolName,
      toolUseId: `${this.metadata.sessionId}:${event.stepIndex}`,
      toolSource: identity.toolSource,
      metadata: this.metadata,
      timestamp: Date.now(),
    };
    if (!this.started.has(common.toolUseId)) {
      this.started.add(common.toolUseId);
      messages.push({ ...common, type: 'tool_use', toolInput: identity.toolInput });
    }
    if (!this.finished.has(common.toolUseId) && (event.state === 'DONE' || event.state === 'ERROR')) {
      this.finished.add(common.toolUseId);
      messages.push({
        ...common,
        type: 'tool_result',
        content: agyNativeToolResultContent(event.toolOutput, event.toolErrorMessage),
        toolResultStatus: event.state === 'DONE' && !event.toolErrorMessage ? 'ok' : 'error',
      });
    }
    return messages;
  }

  final(messages: readonly AgentMessage[]): AgentMessage[] {
    return messages.flatMap((message) => {
      if (message.type === 'session_init' || message.type === 'tool_use') return [];
      if (message.type === 'tool_result') {
        const id = message.toolUseId;
        if (!id || !this.started.has(id) || this.finished.has(id)) return [];
        this.finished.add(id);
        return [message];
      }
      if (message.type !== 'text' || !this.text) return [message];
      // result.response is a snapshot, not another delta. A corrected snapshot
      // replaces partial output; a matching snapshot must never duplicate it.
      return message.content === this.text ? [] : [{ ...message, textMode: 'replace' as const }];
    });
  }
}
