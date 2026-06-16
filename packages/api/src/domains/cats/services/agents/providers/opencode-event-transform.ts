/**
 * opencode Event Transformer
 * opencode JSON event stream → Clowder AI AgentMessage 映射
 *
 * opencode `run --format json` NDJSON 事件格式:
 *   { type, timestamp, sessionID, part: { type, ... } }
 *
 * Event mapping:
 *   step_start  → session_init (first occurrence establishes session)
 *   text        → text (part.text)
 *   tool_use    → tool_use (part.tool, part.state.input)
 *   error       → error (error.data.message or error.name)
 *   step_finish → agent_loop + metadata.usage (telemetry-only). Lights up
 *                 invoke-single-cat's F8 token block + F24 contextHealth
 *                 path so handoff can fire BEFORE context fills.
 *   Others      → null
 */

import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage } from '../../types.js';

interface OpenCodeEvent {
  type: string;
  timestamp: number;
  sessionID: string;
  part?: {
    type: string;
    text?: string;
    tool?: string;
    callID?: string;
    /** step_finish only: terminal reason — 'stop' = final answer (terminal),
     *  'tool-calls' = LLM called tools, more steps follow (non-terminal),
     *  'length'/'content-filter' = upstream halted mid-step (terminal). */
    reason?: string;
    state?: {
      status?: string;
      input?: Record<string, unknown>;
      output?: string;
    };
    /** step_finish only: USD cost of this step from the upstream provider. */
    cost?: number;
    /** step_finish only: token counts for this step (per-API-call shape). */
    tokens?: {
      total?: number;
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: {
        read?: number;
        write?: number;
      };
    };
    [key: string]: unknown;
  };
  error?: {
    name?: string;
    data?: {
      message?: string;
      statusCode?: number;
      [key: string]: unknown;
    };
  };
}

function isOpenCodeEvent(event: unknown): event is OpenCodeEvent {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  return typeof e.type === 'string';
}

export function transformOpenCodeEvent(event: unknown, catId: CatId | string): AgentMessage | null {
  if (!isOpenCodeEvent(event)) return null;

  const ts = typeof event.timestamp === 'number' ? event.timestamp : Date.now();

  switch (event.type) {
    case 'step_start':
      return {
        type: 'session_init',
        catId: catId as CatId,
        sessionId: event.sessionID,
        timestamp: ts,
      };

    case 'text': {
      const text = event.part?.text;
      if (typeof text !== 'string' || text.length === 0) return null;
      return {
        type: 'text',
        catId: catId as CatId,
        content: text,
        timestamp: ts,
      };
    }

    case 'tool_use': {
      const msg: AgentMessage = {
        type: 'tool_use',
        catId: catId as CatId,
        toolName: event.part?.tool ?? 'unknown',
        timestamp: ts,
      };
      if (event.part?.state?.input) {
        msg.toolInput = event.part.state.input;
      }
      return msg;
    }

    case 'error': {
      const errorMsg = event.error?.data?.message ?? event.error?.name ?? 'opencode error';
      return {
        type: 'error',
        catId: catId as CatId,
        error: errorMsg,
        timestamp: ts,
      };
    }

    case 'step_finish': {
      const tokens = event.part?.tokens;
      const freshInput = typeof tokens?.input === 'number' ? tokens.input : undefined;
      const cacheRead = typeof tokens?.cache?.read === 'number' ? tokens.cache.read : undefined;
      const cacheWrite = typeof tokens?.cache?.write === 'number' ? tokens.cache.write : undefined;
      const outputTokens = typeof tokens?.output === 'number' ? tokens.output : undefined;
      const totalTokens = typeof tokens?.total === 'number' ? tokens.total : undefined;
      const costUsd = typeof event.part?.cost === 'number' ? event.part.cost : undefined;

      // opencode reports cached prompt tokens separately from fresh input; the
      // shared TokenUsage contract wants total prompt tokens for fill-ratio math.
      const totalInputTokens =
        freshInput != null || cacheRead != null || cacheWrite != null
          ? (freshInput ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
          : undefined;

      if (totalInputTokens == null && outputTokens == null && totalTokens == null) return null;

      return {
        type: 'agent_loop',
        catId: catId as CatId,
        timestamp: ts,
        metadata: {
          provider: 'opencode',
          model: '',
          usage: {
            ...(totalInputTokens != null
              ? { inputTokens: totalInputTokens, lastTurnInputTokens: totalInputTokens }
              : {}),
            ...(outputTokens != null ? { outputTokens } : {}),
            ...(totalTokens != null ? { totalTokens } : {}),
            ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
            ...(cacheWrite ? { cacheCreationTokens: cacheWrite } : {}),
            ...(costUsd != null ? { costUsd } : {}),
          },
        },
      };
    }

    default:
      return null;
  }
}
