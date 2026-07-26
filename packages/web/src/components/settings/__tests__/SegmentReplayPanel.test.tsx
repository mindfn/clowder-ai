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

  const baseResponse = {
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
    contentSourceKind: 'template',
    contentSourceKindGap: null,
    templateRef: 'templates/S-test.md',
    templateRefGap: null,
    templateVars: { VAR: 'value' },
    templateVarsGap: null,
    messageAnchorId: 'anchor-1',
    messageAnchorIdGap: null,
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
  };

  it('does not render when closed', async () => {
    act(() => {
      root.render(
        <SegmentReplayPanel
          segmentId="S-test"
          threadId="t"
          turnId="1"
          timestamp={5000}
          catId="opus"
          pipelineStatus="fired"
          isOpen={false}
          onClose={() => {}}
        />,
      );
    });
    await flush();

    expect(apiFetch).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('回放现场');
  });

  it('loads and renders replay content with provenance gaps when open', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => baseResponse });

    act(() => {
      root.render(
        <SegmentReplayPanel
          segmentId="S-test"
          threadId="t"
          turnId="1"
          timestamp={5000}
          catId="opus"
          pipelineStatus="fired"
          isOpen
          onClose={() => {}}
        />,
      );
    });
    await flush();

    expect(apiFetch).toHaveBeenCalledWith('/api/segment-lifeline/S-test/replay?threadId=t&turnId=1');
    expect(document.body.textContent).toContain('rendered content');
    expect(document.body.textContent).toContain('模板渲染');
    expect(document.body.textContent).toContain('templates/S-test.md');
    expect(document.body.textContent).toContain('VAR');
    expect(document.body.textContent).toContain('value');
    expect(document.body.textContent).toContain('http_rate_limit');
    expect(document.body.textContent).toContain('hello');
    expect(document.body.textContent).toContain('reply');
  });

  it('renders gap labels for legacy/unavailable fields', async () => {
    apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...baseResponse,
        version: null,
        versionGap: 'legacy-missing',
        content: null,
        contentGap: 'legacy-missing',
        contentSourceKind: null,
        contentSourceKindGap: 'legacy-missing',
        templateRef: null,
        templateRefGap: 'legacy-missing',
        templateVars: null,
        templateVarsGap: 'legacy-missing',
        messageAnchorId: null,
        messageAnchorIdGap: 'legacy-missing',
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
          isOpen
          onClose={() => {}}
        />,
      );
    });
    await flush();

    expect(document.body.textContent).toContain('旧数据缺失');
    expect(document.body.textContent).toContain('不可获取');
  });

  it('calls onClose when close button is clicked', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => baseResponse });
    const onClose = vi.fn();

    act(() => {
      root.render(
        <SegmentReplayPanel
          segmentId="S-test"
          threadId="t"
          turnId="1"
          timestamp={5000}
          catId="opus"
          pipelineStatus="fired"
          isOpen
          onClose={onClose}
        />,
      );
    });
    await flush();

    const closeBtn = document.querySelector('[data-testid="replay-close"]') as HTMLButtonElement;
    expect(closeBtn).toBeTruthy();
    act(() => closeBtn.click());
    await flush();
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when backdrop is clicked', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => baseResponse });
    const onClose = vi.fn();

    act(() => {
      root.render(
        <SegmentReplayPanel
          segmentId="S-test"
          threadId="t"
          turnId="1"
          timestamp={5000}
          catId="opus"
          pipelineStatus="fired"
          isOpen
          onClose={onClose}
        />,
      );
    });
    await flush();

    const backdrop = document.querySelector('[data-testid="replay-backdrop"]') as HTMLDivElement;
    expect(backdrop).toBeTruthy();
    act(() => backdrop.click());
    await flush();
    expect(onClose).toHaveBeenCalled();
  });
});
