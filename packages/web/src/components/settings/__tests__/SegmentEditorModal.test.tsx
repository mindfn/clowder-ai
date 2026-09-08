// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SegmentEditorModal } from '../SegmentEditorModal';

const apiFetch = vi.fn();

vi.mock('../../../utils/api-client', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const content = {
  content: 'effective v1 {{VALUE}}',
  baseContent: 'manifest {{VALUE}}',
  vars: ['VALUE'],
  variableDefs: [{ name: 'VALUE', description: '动态值', placeholder: 'example' }],
  enablementMatrix: {
    runtimeOverride: {
      actions: {
        createVersion: { allowed: true, reason: null, reasonCode: null },
      },
    },
  },
};

const lifeline = {
  activeVersion: 2,
  chain: [
    { version: 1, origin: 'manifest' },
    { version: 2, origin: 'user-create' },
    { version: 3, origin: 'user-create' },
  ],
};

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

function mockLoad(evalStatus: 'idle' | 'requested' = 'idle') {
  apiFetch.mockResolvedValueOnce(jsonResponse(content));
  apiFetch.mockResolvedValueOnce(jsonResponse(lifeline));
  apiFetch.mockResolvedValueOnce(jsonResponse({ objectives: [{ currentCycle: { evalStatus } }] }));
  apiFetch.mockResolvedValueOnce(jsonResponse({ content: 'active v2 {{VALUE}}' }));
}

describe('SegmentEditorModal version lifecycle editor', () => {
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

  async function renderEditor(evalStatus: 'idle' | 'requested' = 'idle') {
    mockLoad(evalStatus);
    act(() => {
      root.render(<SegmentEditorModal segmentId="S13" segmentName="MCP 工具文档" onClose={() => {}} />);
    });
    await flush();
  }

  function typeInto(textarea: HTMLTextAreaElement, value: string) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    descriptor?.set?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('defaults to the active version and keeps variable metadata visible', async () => {
    await renderEditor();
    const select = document.querySelector('#segment-editor-version') as HTMLSelectElement;
    expect(select.value).toBe('2');
    expect(select.textContent).toContain('v2（当前版本）');
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('active v2 {{VALUE}}');
    expect(document.body.textContent).toContain('动态值');
  });

  it('loads the manifest baseline without activating it', async () => {
    await renderEditor();
    const select = document.querySelector('#segment-editor-version') as HTMLSelectElement;
    act(() => {
      select.value = '1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('effective v1 {{VALUE}}');
    expect(apiFetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  it('creates one applied branch with explicit base and active-version precondition', async () => {
    await renderEditor();
    const select = document.querySelector('#segment-editor-version') as HTMLSelectElement;
    act(() => {
      select.value = '1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    act(() => {
      typeInto(textarea, 'edited from v1 {{VALUE}}');
    });
    await flush();
    act(() => (document.querySelector('[data-testid="segment-editor-save"]') as HTMLButtonElement).click());
    expect(document.body.textContent).toContain('当前版本 v2 → v4（基于 v1）');

    apiFetch.mockResolvedValueOnce(jsonResponse({ transition: { fromVersion: 2, toVersion: 4, baseVersion: 1 } }));
    mockLoad();
    const confirm = [...document.querySelectorAll('button')].find((button) => button.textContent === '确认产生并应用');
    await act(async () => confirm?.click());
    await flush();

    const post = apiFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(post?.[0]).toBe('/api/prompt-hooks/S13/versions');
    expect(JSON.parse((post?.[1] as RequestInit).body as string)).toMatchObject({
      content: 'edited from v1 {{VALUE}}',
      baseVersion: 1,
      expectedActiveVersion: 2,
    });
  });

  it('disables editing once evaluation has started', async () => {
    await renderEditor('requested');
    expect((document.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);
    expect(document.body.textContent).toContain('当前正在评估，完成后可编辑并产生新版本');
  });
});
