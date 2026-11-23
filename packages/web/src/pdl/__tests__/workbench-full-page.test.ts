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

describe('generic page: full layout contract across all PDL containers', () => {
  it('declares universal edge-to-edge flex fill for .vw-page-full across library and v2 CSS', () => {
    const pub = path.join(process.cwd(), 'public', 'pdl');
    const workbenchCss = readFileSync(path.join(pub, 'library/css/workbench.css'), 'utf8');
    const blocksCss = readFileSync(path.join(pub, 'library/css/blocks.css'), 'utf8');
    const pageCss = readFileSync(path.join(pub, 'library/css/page.css'), 'utf8');
    const v2Css = readFileSync(path.join(pub, 'themes/v2/components/v2/v2.css'), 'utf8');
    const v2bCss = readFileSync(path.join(pub, 'themes/v2/components/v2/v2b.css'), 'utf8');

    expect(workbenchCss).toContain('.split.wide .panel-body > :not(.vw-page-split, .vw-page-full,');
    expect(workbenchCss).toContain('.pdl-inpanel:has(> .vw-page-full))');
    expect(pageCss).toContain('.page:not(.vw-page-split, .vw-page-full,');

    expect(blocksCss).toContain(
      ':is(.cover-in, .panel-body, .main-col, .main, .float-body, .plugin-float > .scroll, .dialog-body):not(.layer-covered):has(> .vw-page-full.page, > :is(.pdl-inpanel, .page) > .vw-page-full.page, > .layer:not(.layer-covered) > .vw-page-full.page, > .layer:not(.layer-covered) > :is(.pdl-inpanel, .page) > .vw-page-full.page, > .layer:not(.layer-covered) > .layer:not(.layer-covered) > .vw-page-full.page, > .layer:not(.layer-covered) > .layer:not(.layer-covered) > :is(.pdl-inpanel, .page) > .vw-page-full.page) { display: flex; flex-direction: column; position: relative; padding: 0; gap: 0; overflow: hidden; }',
    );
    expect(blocksCss).toContain(
      '.vw-page-full.page { flex: 1 1 0; min-block-size: 0; block-size: 100%; inline-size: 100%; max-inline-size: none; margin: 0; padding: 0; gap: 0; display: flex; flex-direction: column; }',
    );
    expect(blocksCss).toContain(
      '.vw-page-full.page :is(.vw-widget, .frame.tall) { flex: 1 1 0; min-height: 0; height: auto; border-radius: 0; }',
    );

    expect(v2Css).toContain('.v2-shell .split.wide > .v2-workbench { position:absolute; inset:0; border-left:0; }');
    expect(v2Css).toContain(
      ':root[data-shell="v2"] .vw-page-full.page .v2-frame { flex:1 1 0; min-height:0; height:auto; width:100%; border-radius:0; }',
    );
    expect(v2Css).toContain(':root[data-shell="v2"] .layer-covered { display:block; position:absolute; inset:0; }');
    expect(v2bCss).toContain(
      '[data-shell="v2"] .v2-confirm-dialog:has(> .v2-dialog-body > .vw-page-full.page) { display:flex; flex-direction:column; padding-bottom:0; }',
    );
  });

  for (const themeId of ['default', 'v2'] as const) {
    it(`mounts a page: full view across workbench, main window, cover, float, and dialog (${themeId})`, async () => {
      const { w, evalIn } = await bootTheme(themeId);
      const frameSel = themeId === 'v2' ? 'iframe.v2-frame' : 'iframe.vw-widget';
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

      // 1. Workbench side & wide modes
      const panel = w.document.querySelector('aside.panel');
      expect(panel).not.toBeNull();
      expect(panel?.querySelector('.panel-head, [data-testid="v2-workspace-chrome"]')).not.toBeNull();
      expect(panel?.querySelector(`.panel-body > .vw-view.page.vw-page-full ${frameSel}`)).not.toBeNull();

      evalIn(`S.panelWide = true; render(true);`);
      expect(w.document.querySelector('.split.wide > aside.panel')).not.toBeNull();
      expect(
        w.document.querySelector(`.split.wide > aside.panel > .panel-body > .vw-view.page.vw-page-full ${frameSel}`),
      ).not.toBeNull();

      // 2. Main window inside cafe space (.main-col > .layer:not(.layer-covered) > .vw-page-full.page)
      evalIn(`S.panelWide = false; S.panel = null; navOpen({ f: 'node:test.wb.full', into: 'main', push: true });`);
      expect(
        w.document.querySelector(`.main-col > .layer:not(.layer-covered) > .vw-view.page.vw-page-full ${frameSel}`),
      ).not.toBeNull();
      expect(w.document.querySelector('.main-col > .layer:not(.layer-covered) > .back-head')).not.toBeNull();

      // 3. Cover overlay on shell (.cover-in > .vw-page-full.page)
      evalIn(`navBack('main'); navOpen({ f: 'node:test.wb.full', into: 'shell', push: true });`);
      expect(w.document.querySelector(`.cover-in > .vw-view.page.vw-page-full ${frameSel}`)).not.toBeNull();
      expect(w.document.querySelector('.cover-in > .back-head')).not.toBeNull();

      // 4. Floating window (.plugin-float > .scroll > .vw-page-full.page)
      evalIn(`
        navBack('shell');
        PDL_POPUPS['test.float'] = { at: 'corner', exit: ['x'], title: 'Float Full', close: 'close', closeArgs: { path: 's.popOn.testFloat' } };
        POPUPS['test.float'] = () => (S.popOn.testFloat ? floatPanel({ cls: 'plugin-float', title: 'Float Full', pop: 'test.float', body: pdlView('test.wb.full') }) : '');
        S.popOn.testFloat = true;
        render(true);
      `);
      expect(
        w.document.querySelector(`.plugin-float > .scroll > .vw-view.page.vw-page-full ${frameSel}`),
      ).not.toBeNull();

      // 5. Fill dialog (.dialog > .dialog-body > .vw-page-full.page)
      evalIn(`
        S.popOn.testFloat = false;
        PDL_POPUPS['test.dlgFill'] = { at: 'fill', exit: ['x'], focus: true, close: 'close', closeArgs: { path: 's.popOn.testDlgFill' } };
        POPUPS['test.dlgFill'] = () => (S.popOn.testDlgFill ? dialogHtml({ key: 'test.dlgFill', title: 'Fill Dialog', layout: 'fill', body: pdlView('test.wb.full') }) : '');
        S.popOn.testDlgFill = true;
        render(true);
      `);
      expect(
        w.document.querySelector(
          `.dialog:is(.dialog-fill, .v2-dialog-fill) > .dialog-body > .vw-view.page.vw-page-full ${frameSel}`,
        ),
      ).not.toBeNull();

      // 6. Theme Calculator renders translated labels (no raw i18n keys) & contrast rows without throwing
      evalIn(`
        S.popOn.testDlgFill = false;
        S.calc.open = true;
        S.calc.tab = 'colors';
        render(true);
      `);
      const calcHost = w.document.querySelector('.pop-host[data-pop="calc"]');
      expect(calcHost).not.toBeNull();
      const calcText = calcHost?.textContent ?? '';
      expect(calcText).not.toMatch(/\b(?:themeCalc|theme|control|structure|v2f)\.[a-zA-Z]/);
      expect(calcHost?.querySelectorAll('#calc-contrast > *').length).toBeGreaterThanOrEqual(8);
    });
  }
});
