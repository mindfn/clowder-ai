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

async function bootTheme(themeId: 'default' | 'v2') {
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
  const get = vi.fn(async (name: string) => {
    if (name in staticGet) return staticGet[name];
    if (name === '/api/console-themes/packages') return { packages: await builtinThemes.list() };
    if (name.startsWith('/api/console-themes/packages/'))
      return builtinThemes.read(name.slice('/api/console-themes/packages/'.length));
    if (name.startsWith('/api/client-accounts')) return { providers: [], accounts: [], selection: { members: [] } };
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
    get,
    post: vi.fn(async () => ({})),
    file: (p: string) => `/api/file/${p}`,
    attach: vi.fn(),
    action: vi.fn(async () => ({})),
    richRender: vi.fn(),
    terminal: vi.fn(),
    navResize: { min: 200, max: () => 400, width: () => 260, preview: vi.fn(), commit: vi.fn(), reset: vi.fn() },
  } as unknown as ChatPort;

  await w.clowderChat.start(port, chatModels);
  return { w, evalIn };
}

describe('workbench generic page: full layout contract', () => {
  it('declares zero-gutter flex fill for .vw-page-full in workbench.css, blocks.css, and v2.css', () => {
    const pub = path.join(process.cwd(), 'public', 'pdl');
    const workbenchCss = readFileSync(path.join(pub, 'library/css/workbench.css'), 'utf8');
    const blocksCss = readFileSync(path.join(pub, 'library/css/blocks.css'), 'utf8');
    const v2Css = readFileSync(path.join(pub, 'themes/v2/components/v2/v2.css'), 'utf8');

    expect(workbenchCss).toContain('.panel-body:has(> .vw-page-full.page) { padding: 0; gap: 0; overflow: hidden; }');
    expect(workbenchCss).toMatch(/\.split\.wide \.panel-body > :not\([^)]*\.vw-page-full/);

    expect(blocksCss).toContain(
      ':is(.cover-in, .panel-body) > .vw-page-full.page { flex: 1; min-block-size: 0; max-inline-size: none; margin: 0; padding: 0; gap: 0; }',
    );
    expect(blocksCss).toContain(
      ':is(.cover-in, .panel-body) > .vw-page-full :is(.vw-widget, .frame.tall) { flex: 1 1 0; min-height: 0; height: auto; border-radius: 0; }',
    );

    expect(v2Css).toContain('.v2-shell .split.wide > .v2-workbench { position:absolute; inset:0; border-left:0; }');
    expect(v2Css).toContain(
      '.v2-shell :is(.cover-in, .panel-body) > .vw-page-full .v2-frame { flex:1 1 0; min-height:0; height:auto; width:100%; border-radius:0; }',
    );
  });

  for (const themeId of ['default', 'v2'] as const) {
    it(`mounts a page: full workbench tab directly under .panel-body in side and wide modes (${themeId})`, async () => {
      const { w, evalIn } = await bootTheme(themeId);
      evalIn(`
        VM.testFullTab = () => ({});
        PDL_VIEWS['test.wb.full'] = {
          vm: 'testFullTab',
          page: 'full',
          blocks: [
            { type: 'frame', key: 'wb-full', title: 'Full Tab', src: 'https://example.invalid/app', tall: true },
          ],
        };
        const origView = REGION_TABS.panel.view.bind(REGION_TABS.panel);
        REGION_TABS.panel.view = (k) => (k === 'board' ? pdlView('test.wb.full') : origView(k));
        S.panelWide = false;
        ENGINE_PARTS.openTab('panel', 'board');
        render(true);
      `);

      const panel = w.document.querySelector('aside.panel');
      expect(panel).not.toBeNull();
      expect(panel?.querySelector('.panel-head, [data-testid="v2-workspace-chrome"]')).not.toBeNull();

      const fullPage = panel?.querySelector('.panel-body > .vw-view.page.vw-page-full');
      expect(fullPage).not.toBeNull();
      const iframe = fullPage?.querySelector(themeId === 'v2' ? 'iframe.v2-frame' : 'iframe.vw-widget');
      expect(iframe).not.toBeNull();

      evalIn(`S.panelWide = true; render(true);`);
      expect(w.document.querySelector('.split.wide > aside.panel')).not.toBeNull();
      expect(
        w.document.querySelector('.split.wide > aside.panel > .panel-body > .vw-view.page.vw-page-full iframe'),
      ).not.toBeNull();
    });
  }
});
