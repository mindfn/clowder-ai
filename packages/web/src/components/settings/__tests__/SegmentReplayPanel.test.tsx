// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SegmentReplayPanel } from '../SegmentReplayPanel';

const apiFetch = vi.fn();

vi.mock('../../../utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

describe('SegmentReplayPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    apiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function flush() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('loads and renders replay content with provenance gaps', async () => {
    apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        segmentId: 'S-test',
        threadId: 't',
        turnId: '1',
        timestamp: 5000,
        catId: 'opus',
        stage: 'session-init',
        pipelineStatus: 'fired',
        version: 1,
        versionGap: null,
        content: 'rendered content',
        contentGap: null,
        templateRef: 'templates/S-test.md',
        templateRefGap: null,
        templateVars: { VAR: 'value' },
        templateVarsGap: null,
        guardEvents: [
          {
            eventId: 'g1',
            kind: 'http_rate_limit',
            guardId: 'grd',
            catId: 'opus',
            timestamp: 5100,
            attribution: 'window-correlated',
          },
        ],
        guardEventsGap: null,
        surroundingMessages: [
          { messageId: 'm1', role: 'user', catId: null, contentPreview: 'hello', timestamp: 4900 },
          { messageId: 'm2', role: 'assistant', catId: 'opus', contentPreview: 'reply', timestamp: 4950 },
        ],
        surroundingMessagesGap: null,
      }),
    });

    act(() => {
      root.render(
        <SegmentReplayPanel
          segmentId="S-test"
          threadId="t"
          turnId="1"
          timestamp={5000}
          catId="opus"
          pipelineStatus="fired"
        />,
      );
    });
    await flush();

    expect(apiFetch).toHaveBeenCalledWith('/api/segment-lifeline/S-test/replay?threadId=t&turnId=1');
    expect(container.textContent).toContain('rendered content');
    expect(container.textContent).toContain('templates/S-test.md');
    expect(container.textContent).toContain('VAR');
    expect(container.textContent).toContain('value');
    expect(container.textContent).toContain('http_rate_limit');
    expect(container.textContent).toContain('hello');
    expect(container.textContent).toContain('reply');
  });

  it('renders gap labels for legacy/unavailable fields', async () => {
    apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        segmentId: 'S-test',
        threadId: 't',
        turnId: '1',
        timestamp: 5000,
        catId: 'opus',
        stage: 'session-init',
        pipelineStatus: 'fired',
        version: null,
        versionGap: 'legacy-missing',
        content: null,
        contentGap: 'legacy-missing',
        templateRef: null,
        templateRefGap: 'legacy-missing',
        templateVars: null,
        templateVarsGap: 'legacy-missing',
        guardEvents: [],
        guardEventsGap: 'unavailable',
        surroundingMessages: null,
        surroundingMessagesGap: 'unavailable',
      }),
    });

    act(() => {
      root.render(
        <SegmentReplayPanel
          segmentId="S-test"
          threadId="t"
          turnId="1"
          timestamp={5000}
          catId="opus"
          pipelineStatus="fired"
        />,
      );
    });
    await flush();

    expect(container.textContent).toContain('旧数据缺失');
    expect(container.textContent).toContain('不可获取');
  });
});
