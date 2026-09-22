import { describe, expect, it } from 'vitest';
import { getMessageTimelineCursorTime, getMessageTimelineOrderTime } from '../message-timeline';

describe('getMessageTimelineOrderTime', () => {
  it('keeps a processing response on its latest streaming activity time', () => {
    expect(
      getMessageTimelineOrderTime({
        type: 'assistant',
        catId: 'codex-sol',
        timestamp: 1_000,
        timelineOrderAt: 1_800,
        lifecycle: { kind: 'response', status: 'processing' },
      }),
    ).toBe(1_800);
  });

  it('freezes a terminal response at its completion time', () => {
    expect(
      getMessageTimelineOrderTime({
        type: 'assistant',
        catId: 'codex-sol',
        timestamp: 1_000,
        timelineOrderAt: 1_800,
        lifecycle: { kind: 'response', status: 'completed', completedAt: 2_000 },
      }),
    ).toBe(2_000);
  });

  it('lets a terminal lifecycle override a stale streaming flag', () => {
    expect(
      getMessageTimelineOrderTime({
        type: 'assistant',
        catId: 'codex-sol',
        isStreaming: true,
        timestamp: 1_000,
        timelineOrderAt: 1_800,
        lifecycle: { kind: 'response', status: 'completed', completedAt: 2_000 },
      }),
    ).toBe(2_000);
  });

  it('keeps pagination cursors on the storage score after presentation freezes at completion', () => {
    const message = {
      type: 'assistant',
      catId: 'codex-sol',
      timestamp: 1_000,
      timelineOrderAt: 1_800,
      lifecycle: { kind: 'response', status: 'completed', completedAt: 2_000 },
    };

    expect(getMessageTimelineOrderTime(message)).toBe(2_000);
    expect(getMessageTimelineCursorTime(message)).toBe(1_800);
  });

  it('keeps real-cat speech at authoring time after execution delivery', () => {
    expect(
      getMessageTimelineOrderTime({
        type: 'assistant',
        catId: 'codex-sol',
        timestamp: 1_000,
        deliveredAt: 1_500,
        timelineOrderAt: 1_000,
      }),
    ).toBe(1_000);
  });

  it('orders queued user work by delivery time', () => {
    expect(getMessageTimelineOrderTime({ type: 'user', catId: null, timestamp: 1_000, deliveredAt: 1_500 })).toBe(
      1_500,
    );
  });

  it('does not treat internal system cats as published real-cat speech', () => {
    expect(
      getMessageTimelineOrderTime({ type: 'assistant', catId: 'system', timestamp: 1_000, deliveredAt: 1_500 }),
    ).toBe(1_500);
  });

  it('keeps legacy delivered cat rows on their historical delivery score', () => {
    expect(
      getMessageTimelineOrderTime({
        type: 'assistant',
        catId: 'opus',
        timestamp: 1_000,
        deliveredAt: 1_500,
      }),
    ).toBe(1_500);
  });
});
