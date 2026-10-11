import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/components/useConfirm', () => ({ useConfirm: () => vi.fn(), useOptionalConfirm: () => vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { PluginManagerLiveContent } from '../plugin-manager/PluginManagerLiveContent';

const fetch = vi.mocked(apiFetch);
const packagePath = '/workspace/plugins/local-example';
const installEndpoint = '/api/plugin-manager/plugins/install';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const listing = (current: string) => ({
  current,
  homePath: '/workspace/plugins',
  parent: '/workspace',
  name: 'plugins',
  entries: current === packagePath ? [] : [{ name: 'local-example', path: packagePath, isDirectory: true }],
});
let container: HTMLDivElement;
let root: Root;
let installResponse: () => Promise<Response>;
let directoryResponse: () => Promise<Response>;

function button(label: string) {
  const found = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.trim() === label);
  expect(found, `Missing directory installation control: ${label}`).toBeDefined();
  return found as HTMLButtonElement;
}
const click = async (label: string) => act(async () => button(label).click());
const writes = () => fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
async function open(presentation: 'v1' | 'v2' = 'v1') {
  await act(async () => root.render(<PluginManagerLiveContent presentation={presentation} />));
  await click('从本地目录安装');
  await click('local-example');
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  fetch.mockReset();
  installResponse = async () => json({ pluginId: 'local-example' }, 201);
  directoryResponse = async () => json(listing(packagePath));
  fetch.mockImplementation(async (url, init) => {
    if (url === '/api/plugin-manager/plugins') return json({ plugins: [], catalog: { status: 'fresh' } });
    if (url === '/api/projects/browse') return json(listing('/workspace/plugins'));
    if (url === `/api/projects/browse?path=${encodeURIComponent(packagePath)}`) return directoryResponse();
    if (url === installEndpoint && init?.method === 'POST') return installResponse();
    throw new Error(`Unexpected request: ${url}`);
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([
  'v1',
  'v2',
] as const)('installs the selected directory through the real Manager seam and refreshes %s', async (presentation) => {
  await open(presentation);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(packagePath);
  expect(document.querySelector('[title="新建文件夹"]')).toBeNull();
  await click('安装插件');
  expect(writes()).toHaveLength(1);
  expect(writes()[0]).toEqual([
    installEndpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'local-directory', path: packagePath } }),
    },
  ]);
  expect(fetch.mock.calls.filter(([url]) => url === '/api/plugin-manager/plugins').length).toBeGreaterThan(1);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('keeps an admission refusal visible with the selected directory and never auto-enables', async () => {
  installResponse = async () => json({ error: '插件目录缺少可运行入口' }, 422);
  await open();
  await click('安装插件');
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('插件目录缺少可运行入口');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(packagePath);
  expect(button('安装插件').disabled).toBe(false);
  expect(writes()).toHaveLength(1);
  await click('取消');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(writes()).toHaveLength(1);
});

it('does not submit the previous directory during navigation or after denied browsing', async () => {
  let resolve!: (response: Response) => void;
  directoryResponse = () =>
    new Promise((done) => {
      resolve = done;
    });
  await open();
  expect(button('安装插件').disabled).toBe(true);
  await click('安装插件');
  expect(writes()).toHaveLength(0);
  await act(async () => resolve(json({ error: 'Access denied' }, 403)));
  expect(button('安装插件').disabled).toBe(true);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Access denied');
  await click('取消');
  expect(writes()).toHaveLength(0);
});

it('admits one install at a time and keeps the dialog until its result arrives', async () => {
  let resolve!: (response: Response) => void;
  installResponse = () =>
    new Promise((done) => {
      resolve = done;
    });
  await open();
  const install = button('安装插件');
  await act(async () => {
    install.click();
    install.click();
  });
  expect(writes()).toHaveLength(1);
  expect(button('取消').disabled).toBe(true);
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => resolve(json({ pluginId: 'local-example' }, 201)));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('ignores an older browse response after the path input changes', async () => {
  let resolve!: (response: Response) => void;
  directoryResponse = () =>
    new Promise((done) => {
      resolve = done;
    });
  await open();
  const input = document.querySelector<HTMLInputElement>('[placeholder="Enter path..."]');
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '/workspace/another-plugin');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => resolve(json(listing(packagePath))));
  expect(input?.value).toBe('/workspace/another-plugin');
  expect(button('安装插件').disabled).toBe(true);
  expect(writes()).toHaveLength(0);
});
