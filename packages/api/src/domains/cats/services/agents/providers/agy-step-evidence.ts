import type { AgyProtocolAnomaly, AgyStreamJsonEvent } from './agy-stream-json-parser.js';

const STEP_TYPES = new Set(['user_input', 'system_message', 'agent_response', 'tool', 'checkpoint', 'error_message']);

/** Validate each observation before any sparse update or subset projection can erase it. */
export function agyStepEvidenceAnomalies(
  event: Extract<AgyStreamJsonEvent, { kind: 'step' }>,
  previousType: string | undefined,
  previousToolName: string | undefined,
): AgyProtocolAnomaly[] {
  const anomalies: AgyProtocolAnomaly[] = [];
  const invalid = (kind: AgyProtocolAnomaly['kind'], detail: string): void => {
    anomalies.push({ kind, detail: `step ${event.stepIndex}: ${detail}` });
  };
  if (!Number.isSafeInteger(event.stepIndex) || event.stepIndex < 0) {
    invalid('invalid_step_identity', 'missing or invalid index');
  }
  if (!event.conversationId.trim()) invalid('invalid_step_identity', 'missing conversation ID');
  if (!STEP_TYPES.has(event.stepType))
    invalid('unknown_step_type', `unrecognized type ${JSON.stringify(event.stepType)}`);
  if (event.stepType === 'tool' && !event.toolName?.trim()) invalid('invalid_tool_identity', 'missing tool name');
  if (previousType !== undefined && previousType !== event.stepType) {
    invalid('invalid_step_identity', 'type changed during an existing step');
  }
  if (previousToolName !== undefined && previousToolName !== event.toolName) {
    invalid('invalid_tool_identity', 'tool name changed during an existing step');
  }
  return anomalies;
}
