import { describe, expect, it } from 'vitest';
import { formatSessionSealRequested, isSystemInfoProtocolPayload } from '../system-info-visible';

describe('isSystemInfoProtocolPayload', () => {
  it('recognizes typed protocol envelopes (#1343 fail-closed)', () => {
    expect(isSystemInfoProtocolPayload({ type: 'session_policy_execution', invocationId: 'inv_abc' })).toBe(true);
    expect(isSystemInfoProtocolPayload({ type: 'context_health', catId: 'opus' })).toBe(true);
    expect(isSystemInfoProtocolPayload({ type: 'task_progress' })).toBe(true);
  });

  it('rejects non-protocol payloads', () => {
    expect(isSystemInfoProtocolPayload('plain text')).toBe(false);
    expect(isSystemInfoProtocolPayload(null)).toBe(false);
    expect(isSystemInfoProtocolPayload([{ type: 'array_item' }])).toBe(false);
    expect(isSystemInfoProtocolPayload({ noTypeField: true })).toBe(false);
  });
});

describe('formatSessionSealRequested', () => {
  it('describes runtime replacement as an in-turn recovery instead of a context seal', () => {
    expect(
      formatSessionSealRequested(
        {
          type: 'session_seal_requested',
          catId: 'codex-sol',
          sessionSeq: 2,
          reason: 'cli_session_replaced',
          continuityDiagnostics: {
            source: 'runtime_replacement',
            boundary: 'runtime_replacement',
          },
        },
        () => '缅因猫 Sol',
      ),
    ).toEqual({
      content: '缅因猫 Sol 的会话 #2 已自动接力；新会话已在本轮继续运行',
      variant: 'info',
    });
  });

  it('keeps context percentage copy for a real threshold seal', () => {
    expect(
      formatSessionSealRequested(
        {
          type: 'session_seal_requested',
          catId: 'codex-sol',
          sessionSeq: 3,
          reason: 'context_threshold',
          healthSnapshot: { fillRatio: 0.82 },
        },
        () => '缅因猫 Sol',
      ),
    ).toEqual({
      content: '缅因猫 Sol 的会话 #3 已封存（上下文 82%），下次调用将自动创建新会话',
      variant: 'info',
    });
  });
});
