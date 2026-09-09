import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

import { DirPickerField } from '@/components/settings/DirPickerField';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function pickButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '修改');
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

describe('DirPickerField', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as { desktopBridge?: unknown }).desktopBridge;
    vi.clearAllMocks();
  });

  it('renders the value as plain text (not a readonly input) and hides the picker button when disabled', async () => {
    await act(async () => {
      root.render(React.createElement(DirPickerField, { value: '/data', disabled: true }));
    });
    await flushEffects();

    expect(container.querySelector('input')).toBeNull();
    const text = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === '/data');
    expect(text).toBeTruthy();
    expect(text?.getAttribute('title')).toBe('/data');
    expect(Array.from(container.querySelectorAll('button'))).toHaveLength(0);
  });

  it('shows the placeholder in muted text when no value is set', async () => {
    await act(async () => {
      root.render(React.createElement(DirPickerField, { value: '', placeholder: '~/.cat-cafe' }));
    });
    await flushEffects();

    expect(container.querySelector('input')).toBeNull();
    const text = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === '~/.cat-cafe');
    expect(text).toBeTruthy();
    expect(text?.className).toContain('text-cafe-muted');
  });

  it('uses the electron bridge in desktop mode and returns the picked path', async () => {
    const onChange = vi.fn();
    const pickDirectory = vi.fn(async () => '/Users/test/projects');
    (window as { desktopBridge?: unknown }).desktopBridge = { pickDirectory };

    await act(async () => {
      root.render(React.createElement(DirPickerField, { value: '', onChange }));
    });
    await flushEffects();

    await act(async () => {
      pickButton(container).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(pickDirectory).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith('/Users/test/projects');
  });

  it('keeps the current value when the electron dialog is cancelled', async () => {
    const onChange = vi.fn();
    const pickDirectory = vi.fn(async () => null);
    (window as { desktopBridge?: unknown }).desktopBridge = { pickDirectory };

    await act(async () => {
      root.render(React.createElement(DirPickerField, { value: '/data', onChange }));
    });
    await flushEffects();

    await act(async () => {
      pickButton(container).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(onChange).not.toHaveBeenCalled();
  });

  it('opens a browser directory browser and selects the current directory', async () => {
    const onChange = vi.fn();
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/config/dir-list?path=%2F') {
        return Promise.resolve(
          jsonResponse({
            path: '/',
            parent: '/',
            entries: [
              { name: 'Users', path: '/Users' },
              { name: 'data', path: '/data' },
            ],
          }),
        );
      }
      if (path === '/api/config/dir-list?path=%2FUsers') {
        return Promise.resolve(
          jsonResponse({
            path: '/Users',
            parent: '/',
            entries: [{ name: 'test', path: '/Users/test' }],
          }),
        );
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(DirPickerField, { value: '', onChange }));
    });
    await flushEffects();

    await act(async () => {
      pickButton(container).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/config/dir-list?path=%2F');
    expect(container.textContent).toContain('/Users/');

    // Navigate into a subdirectory, then select the current directory.
    const usersEntry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Users/');
    await act(async () => {
      usersEntry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/config/dir-list?path=%2FUsers');
    expect(container.textContent).toContain('/Users');
    expect(container.textContent).toContain('test/');

    const selectButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '选择当前目录');
    await act(async () => {
      selectButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(onChange).toHaveBeenCalledWith('/Users');
  });

  it('cancels the browser directory browser without calling onChange', async () => {
    const onChange = vi.fn();
    mockApiFetch.mockImplementation(() => Promise.resolve(jsonResponse({ path: '/', parent: '/', entries: [] })));

    await act(async () => {
      root.render(React.createElement(DirPickerField, { value: '', onChange }));
    });
    await flushEffects();

    await act(async () => {
      pickButton(container).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const cancelButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '取消');
    await act(async () => {
      cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('选择当前目录');
  });
});
