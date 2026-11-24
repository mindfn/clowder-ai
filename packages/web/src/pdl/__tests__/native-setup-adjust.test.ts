// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { chatModels } from '../chat-models';
import { scriptSources } from '../runtime';
import type { ChatPort } from '../types';
import { builtinThemes, defaultThemePdl } from './builtin-theme';
import { fixtureData, fixtureInput, fixtureSidebar, fixtureUi } from './chat-fixture';

const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom');

function makePartnerFixtures() {
  const form = (name: string) => ({
    displayName: name,
    defaultModel: '',
    cliEffort: '',
    cliConfigArgs: [],
    accountRef: '',
    catId: name.toLowerCase(),
  });
  const rt = (id: string, label: string, installed: boolean, extra: Record<string, unknown> = {}) => ({
    id,
    label,
    installed,
    models: [],
    efforts: [],
    ...extra,
  });
  return [
    {
      id: 'ready-row',
      runtime: rt('ready', 'Ready CLI', true),
      form: form('ReadyCat'),
      selected: true,
      selectable: true,
    },
    {
      id: 'created-row',
      runtime: rt('agy', 'AGY Native', true),
      form: form('AgyCat'),
      existingId: 'cat-agy',
      selected: false,
      selectable: false,
    },
    {
      id: 'conflict-installed',
      runtime: rt('codex', 'Codex', true),
      form: form('CodexCat'),
      identityConflict: true,
      selected: false,
      selectable: true,
    },
    {
      id: 'conflict-uninstalled',
      runtime: rt('pi', 'Pi', false),
      form: form('PiCat'),
      identityConflict: true,
      selected: false,
      selectable: false,
    },
    {
      id: 'account-required',
      runtime: rt('agy2', 'AGY Account', true, { agyCarrier: 'native' }),
      form: form('AgyNeedAcc'),
      accountRequired: true,
      agyAccounts: [],
      selected: false,
      selectable: false,
    },
  ];
}

async function bootNativeSetup(themeId: 'default' | 'v2') {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'https://pdl.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  const w = dom.window;
  const ctx = dom.getInternalVMContext();
  const evalIn = (code: string) => runInContext(code, ctx);
  await new Promise<void>((resolve) => w.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  w.document.timeline = { currentTime: 0 };
  w.requestAnimationFrame = ((fn: FrameRequestCallback) =>
    setTimeout(() => fn(Date.now()), 0) as unknown as number) as typeof w.requestAnimationFrame;
  w.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof w.cancelAnimationFrame;
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.CSS = { escape: (s: string) => s, supports: () => true };
  w.HTMLElement.prototype.getAnimations = () => [];
  w.HTMLElement.prototype.showPopover = () => {};
  w.HTMLElement.prototype.hidePopover = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  w.IntersectionObserver = w.ResizeObserver;
  w.document.getAnimations = () => [];
  w.document.fonts = { ready: Promise.resolve() };
  w.document.documentElement.style.setProperty('--hold-toast', defaultThemePdl().tokens.base['--hold-toast']);
  const origAppend = w.document.head.appendChild.bind(w.document.head);
  w.document.head.appendChild = ((node: Node) => {
    const tag = (node as Element).tagName;
    if (tag === 'STYLE') return node;
    const out = origAppend(node);
    if (tag === 'SCRIPT' && node.textContent) runInContext(node.textContent, ctx);
    return out;
  }) as typeof w.document.head.appendChild;
  for (const source of scriptSources) {
    runInContext(readFileSync(path.join(process.cwd(), 'public', source), 'utf8'), ctx, { filename: source });
  }

  const data = fixtureData();
  const ui = fixtureUi();
  const sidebar = fixtureSidebar(data);
  const staticGet: Record<string, unknown> = {
    '/api/config/console-themes': { themes: { active: themeId === 'v2' ? 'pkg:v2' : 'sys:1', customs: [] } },
    '/api/config/chat-background': { threads: {} },
    '/api/config/chat-background/images': { images: [] },
    '/api/plugin-manager/plugins': { plugins: [] },
    '/api/plugin-manager/pdl': { fragments: {} },
    '/api/accounts': { providers: [], accounts: [], selection: { members: [] } },
  };
  const action = vi.fn(async (name: string): Promise<unknown> => {
    if (name === 'membersRead')
      return { accounts: [], templates: [], runtimes: [], clients: [], strategies: [], libraries: [] };
    if (name === 'memberRuntimeModels') return { status: 'live', models: [], effortOptions: [] };
    if (name === 'nativeCreate') return { id: 'cat-created-1' };
    return {};
  });
  const port = {
    get threadId() {
      return data.threadId;
    },
    exportReady: Promise.resolve(),
    state: ui,
    needed: vi.fn(),
    get sidebarData() {
      return sidebar;
    },
    get data() {
      return fixtureInput(data);
    },
    get: vi.fn(async (name: string) => {
      if (name === '/api/console-themes/packages') return { packages: await builtinThemes.list() };
      if (name.startsWith('/api/console-themes/packages/'))
        return builtinThemes.read(name.slice('/api/console-themes/packages/'.length));
      if (name.startsWith('/api/client-accounts')) return { providers: [], accounts: [], selection: { members: [] } };
      return staticGet[name] ?? {};
    }),
    post: vi.fn(async () => ({})),
    file: (p: string) => `/api/file/${p}`,
    attach: vi.fn(),
    action,
    richRender: vi.fn(),
    terminal: vi.fn(),
    navResize: { min: 200, max: () => 400, width: () => 260, preview: vi.fn(), commit: vi.fn(), reset: vi.fn() },
  } as unknown as ChatPort;

  await w.clowderChat.start(port, chatModels);
  return { w, evalIn, action };
}

describe('nativeSetup adjust button visibility and state priority', () => {
  for (const themeId of ['default', 'v2'] as const) {
    it(`shows adjust only on adjustable rows, collapses after create, and skips conflict auto-expand (${themeId})`, async () => {
      const { w, evalIn, action } = await bootNativeSetup(themeId);
      const partners = makePartnerFixtures();

      evalIn(
        `S.lang = 'zh'; S.popOn.nativeSetup = true; S.nativeSetup = { busy: false, submitError: '', failedPartner: null, partners: ${JSON.stringify(partners)} }; render(true);`,
      );

      const states = evalIn(
        'Object.fromEntries(VM.nativeSetup().items.map((x) => [x.id, { state: x.state, adjustable: x.adjustable }]))',
      );
      expect(states).toEqual({
        'ready-row': { state: 'ready', adjustable: true },
        'created-row': { state: 'created', adjustable: false },
        'conflict-installed': { state: 'conflict', adjustable: false },
        'conflict-uninstalled': { state: 'unavailable', adjustable: false },
        'account-required': { state: 'accountRequired', adjustable: true },
      });

      const adjustIds = Array.from(w.document.querySelectorAll('[data-act="nativeAdjust"]')).map(
        (el) => (el as HTMLElement).dataset.id,
      );
      expect(adjustIds).toEqual(['ready-row', 'account-required']);

      // Clicking/invoking nativeAdjust on conflict or created rows is a no-op
      evalIn("A.nativeAdjust({ id: 'conflict-installed' }); A.nativeAdjust({ id: 'created-row' });");
      expect(evalIn("VM.nativeSetup().items.find((x) => x.id === 'conflict-installed').adjusting")).toBe(false);
      expect(evalIn("VM.nativeSetup().items.find((x) => x.id === 'created-row').adjusting")).toBe(false);

      // Expand ready row, then run real nativeCreate -> row collapses and parameter inputs disappear
      evalIn("A.nativeAdjust({ id: 'ready-row' });");
      expect(evalIn("VM.nativeSetup().items.find((x) => x.id === 'ready-row').adjusting")).toBe(true);
      expect(w.document.getElementById('probe-ready-row-model')).not.toBeNull();

      await evalIn('A.nativeCreate()');
      expect(evalIn("VM.nativeSetup().items.find((x) => x.id === 'ready-row').adjustable")).toBe(false);
      expect(evalIn("VM.nativeSetup().items.find((x) => x.id === 'ready-row').adjusting")).toBe(false);
      expect(w.document.getElementById('probe-ready-row-model')).toBeNull();

      // Even if a stale adjusting flag exists on a non-adjustable partner, VM keeps adjusting false
      evalIn("S.nativeSetup.partners.find((p) => p.id === 'conflict-installed').adjusting = true; render(true);");
      expect(evalIn("VM.nativeSetup().items.find((x) => x.id === 'conflict-installed').adjusting")).toBe(false);
      expect(w.document.getElementById('probe-conflict-installed-model')).toBeNull();

      // Real nativeDetect auto-expand: expands ready AGY row with empty model, but does NOT expand conflict AGY row
      const detectedPartners = [
        {
          id: 'agy-ready',
          runtime: {
            id: 'agy-native',
            label: 'AGY Native',
            installed: true,
            agyCarrier: 'native',
            models: [],
            efforts: [],
          },
          form: {
            displayName: 'AgyFresh',
            defaultModel: '',
            cliEffort: '',
            cliConfigArgs: [],
            accountRef: 'acc-1',
            catId: 'agy-fresh',
          },
          agyAccounts: [{ id: 'acc-1', name: 'Main', kind: 'builtin' }],
          selected: true,
          selectable: true,
        },
        {
          id: 'agy-conflict',
          runtime: {
            id: 'agy-native-2',
            label: 'AGY Conflict',
            installed: true,
            agyCarrier: 'native',
            models: [],
            efforts: [],
          },
          form: {
            displayName: 'AgyDup',
            defaultModel: '',
            cliEffort: '',
            cliConfigArgs: [],
            accountRef: 'acc-1',
            catId: 'agy-dup',
          },
          agyAccounts: [{ id: 'acc-1', name: 'Main', kind: 'builtin' }],
          identityConflict: true,
          selected: false,
          selectable: true,
        },
      ];
      action.mockImplementation(async (name: string) => {
        if (name === 'membersRead')
          return { accounts: [], templates: [], runtimes: [], clients: [], strategies: [], libraries: [] };
        if (name === 'memberRuntimeModels') return { status: 'live', models: [], effortOptions: [] };
        if (name === 'nativeDetect') return detectedPartners;
        return {};
      });
      await evalIn('A.nativeDetect({ refresh: true })');
      expect(evalIn("VM.nativeSetup().items.find((x) => x.id === 'agy-ready').adjusting")).toBe(true);
      expect(w.document.getElementById('probe-agy-ready-model')).not.toBeNull();
      expect(evalIn("VM.nativeSetup().items.find((x) => x.id === 'agy-conflict').adjustable")).toBe(false);
      expect(evalIn("VM.nativeSetup().items.find((x) => x.id === 'agy-conflict').adjusting")).toBe(false);
      expect(w.document.getElementById('probe-agy-conflict-model')).toBeNull();
    });
  }
});
