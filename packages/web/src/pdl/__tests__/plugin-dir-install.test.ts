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
import { fixtureWorkbenchSource } from './owner-console';

const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom');
const PUBLIC_PDL = path.join(process.cwd(), 'public', 'pdl');

interface DirFixture {
  current: string;
  parent: string | null;
  entries: { name: string; path: string; isDirectory: boolean }[];
}

function makeDirFixtures() {
  const rootDir: DirFixture = {
    current: '/Users/dev/plugins',
    parent: '/Users/dev',
    entries: [
      { name: 'my-plugin', path: '/Users/dev/plugins/my-plugin', isDirectory: true },
      { name: 'other-plugin', path: '/Users/dev/plugins/other-plugin', isDirectory: true },
    ],
  };
  const subDir: DirFixture = {
    current: '/Users/dev/plugins/my-plugin',
    parent: '/Users/dev/plugins',
    entries: [{ name: 'dist', path: '/Users/dev/plugins/my-plugin/dist', isDirectory: true }],
  };
  return { rootDir, subDir };
}

async function bootPluginDirConsole(themeId: 'default' | 'v2') {
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

  const { rootDir, subDir } = makeDirFixtures();
  const picker = {
    browse: null as DirFixture | null,
    directories: {} as Record<string, DirFixture>,
    drives: [] as { label: string; path: string }[],
    completions: { prefix: '', entries: [] as { name: string; path: string; isDirectory: boolean }[] },
    setup: {},
  };
  const data = fixtureData();
  const ui = fixtureUi();
  const sidebar = fixtureSidebar(data);
  const pluginsList: Record<string, unknown>[] = [];
  let shouldFailInstall = true;

  const project = {
    workbench: { ...fixtureWorkbenchSource(data), projectPicker: picker },
    settings: {
      plugins: { plugins: pluginsList, catalog: { status: 'fresh', refreshedAt: 1 } },
      pluginFragments: {},
      pluginDetails: {},
    },
  };
  const syncProject = () => {
    w.clowderChat.pushProject(project);
  };

  const staticGet: Record<string, unknown> = {
    '/api/config/console-themes': { themes: { active: themeId === 'v2' ? 'pkg:v2' : 'sys:1', customs: [] } },
    '/api/config/chat-background': { threads: {} },
    '/api/config/chat-background/images': { images: [] },
    '/api/plugin-manager/plugins': { plugins: pluginsList, catalog: { status: 'fresh', refreshedAt: 1 } },
    '/api/plugin-manager/pdl': { fragments: {} },
    '/api/accounts': { providers: [], accounts: [], selection: { members: [] } },
  };

  const handleBrowse = (targetPath: string) => {
    const dir = targetPath === '/Users/dev/plugins/my-plugin' ? subDir : rootDir;
    picker.browse = dir;
    picker.directories[dir.current] = dir;
    syncProject();
    return { directory: dir };
  };

  const handleInstall = (rawBody: string) => {
    if (shouldFailInstall) throw new Error('Missing built manifest.json');
    const parsed = JSON.parse(rawBody);
    expect(parsed).toEqual({
      source: { kind: 'local-directory', path: '/Users/dev/plugins/my-plugin' },
    });
    pluginsList.push({
      pluginId: 'local.my-plugin',
      displayName: 'My Local Plugin',
      artifact: 'installed',
      intent: 'disabled',
      runtimeStatus: 'stopped',
      lifecycleRevision: 1,
      source: { kind: 'local-directory', path: '/Users/dev/plugins/my-plugin' },
      actions: { setEnabled: true, uninstall: true, update: false, repair: false },
    });
    project.settings.plugins = { plugins: [...pluginsList], catalog: { status: 'fresh', refreshedAt: 2 } };
    syncProject();
    return { pluginId: 'local.my-plugin', pluginInstanceId: 'inst-local-1' };
  };

  const action = vi.fn(async (name: string, args: Record<string, string>) => {
    if (name === 'settingsPluginsRead') {
      syncProject();
      return true;
    }
    if (name === 'projectBrowse') return handleBrowse(args.path ?? '');
    if (name === 'projectDirectory') {
      if (args.path === '/Users/dev/plugins/my-plugin') picker.directories[subDir.current] = subDir;
      syncProject();
      return true;
    }
    if (name === 'cafePathComplete') {
      picker.completions = {
        prefix: args.prefix ?? '',
        entries: [{ name: 'my-plugin', path: '/Users/dev/plugins/my-plugin', isDirectory: true }],
      };
      syncProject();
      return true;
    }
    if (name === 'settingsPluginInstall') return handleInstall(args.value ?? '{}');
    return {};
  });

  const get = vi.fn(async (name: string) => {
    if (name === '/api/console-themes/packages') return { packages: await builtinThemes.list() };
    if (name.startsWith('/api/console-themes/packages/'))
      return builtinThemes.read(name.slice('/api/console-themes/packages/'.length));
    if (name === '/api/plugin-manager/plugins') return { plugins: [...pluginsList] };
    if (name.startsWith('/api/client-accounts')) return { providers: [], accounts: [], selection: { members: [] } };
    return staticGet[name] ?? {};
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
    action,
    richRender: vi.fn(),
    terminal: vi.fn(),
    navResize: { min: 200, max: () => 400, width: () => 260, preview: vi.fn(), commit: vi.fn(), reset: vi.fn() },
  } as unknown as ChatPort;

  await w.clowderChat.start(port, chatModels);
  w.clowderChat.pushProject(project);
  return {
    w,
    evalIn,
    action,
    setFailInstall: (fail: boolean) => {
      shouldFailInstall = fail;
    },
    flush: () => new Promise((resolve) => setTimeout(resolve, 20)),
  };
}

describe('local directory plugin installation across default and v2 themes', () => {
  it('declares installDir menu entry and dlg.pluginDir in both themes with zh/en copy', () => {
    const defaultYaml = readFileSync(path.join(PUBLIC_PDL, 'themes', 'default', 'theme.yaml'), 'utf8');
    const v2Yaml = readFileSync(path.join(PUBLIC_PDL, 'themes', 'v2', 'theme.yaml'), 'utf8');
    const v2dJs = readFileSync(path.join(PUBLIC_PDL, 'themes', 'v2', 'components', 'v2', 'v2d.js'), 'utf8');

    expect(defaultYaml).toContain('act: installDir');
    expect(defaultYaml).toContain('dlg.pluginDir:');
    expect(v2Yaml).toContain('dlg.pluginDir:');
    expect(v2dJs).toContain("act:'installDir'");
  });

  for (const themeId of ['default', 'v2'] as const) {
    it(`browses directories, keeps dialog on error, and installs local-directory plugin (${themeId})`, async () => {
      const { w, evalIn, action, setFailInstall, flush } = await bootPluginDirConsole(themeId);

      evalIn("S.lang = 'zh'; go('ext'); render(true);");
      await flush();
      if (themeId === 'v2') {
        expect(w.document.querySelector('[data-plugin-action-menu] [data-act="installDir"]')?.textContent).toContain(
          '从本地目录安装',
        );
      }

      evalIn('A.installDir();');
      await flush();

      expect(action).toHaveBeenCalledWith('projectBrowse', { path: '' });
      const dlgText = w.document.querySelector('.pop-host[data-pop="dialog"]')?.textContent ?? '';
      expect(dlgText).toContain('从本地目录安装插件');
      expect(dlgText).toContain('my-plugin');

      evalIn("A.pluginDirSelect({ path: '/Users/dev/plugins/my-plugin' });");
      expect(w.document.querySelector('.pop-host[data-pop="dialog"]')?.textContent).toContain(
        '已选目录：/Users/dev/plugins/my-plugin',
      );

      // Failed install reopens dialog with backend error preserved
      const submitBtn = w.document.querySelector(
        '.pop-host[data-pop="dialog"] form button[type="submit"]',
      ) as HTMLButtonElement;
      submitBtn.click();
      await flush();
      expect(evalIn('!!S.dialog')).toBe(true);
      expect(evalIn('S.dialog.error')).toBe('Missing built manifest.json');

      // English mode renders concrete English labels without Chinese fallback
      evalIn("S.lang = 'en'; A.installDir();");
      await flush();
      evalIn("A.pluginDirSelect({ path: '/Users/dev/plugins/my-plugin' });");
      const enDlg = w.document.querySelector('.pop-host[data-pop="dialog"]')?.textContent ?? '';
      expect(enDlg).toContain('Install plugin from local directory');
      expect(enDlg).toContain('Selected directory:');
      expect(enDlg).toContain('Install');
      expect(enDlg).not.toContain('ext.installDir');
      expect(enDlg).not.toContain('安装');

      // Successful install closes dialog, persists last directory, and navigates to the new plugin
      setFailInstall(false);
      const submitBtn2 = w.document.querySelector(
        '.pop-host[data-pop="dialog"] form button[type="submit"]',
      ) as HTMLButtonElement;
      submitBtn2.click();
      await flush();
      expect(evalIn('!!S.dialog')).toBe(false);
      expect(evalIn('S.route')).toBe('extItem');
      expect(evalIn('S.param')).toBe('local.my-plugin');
      expect(w.localStorage.getItem('clowder.plugin-install.last-directory')).toBe('/Users/dev/plugins/my-plugin');
    });
  }

  it('ignores out-of-order browse responses, preserves typing while browsing, and drops stale errors', async () => {
    const { w, evalIn, action, flush } = await bootPluginDirConsole('default');

    type BrowseResult = { directory: DirFixture };
    const pending = new Map<string, { resolve: (v: BrowseResult) => void; reject: (e: Error) => void }>();
    const submittedPaths: string[] = [];

    action.mockImplementation(async (name: string, args: Record<string, string>) => {
      if (name === 'projectBrowse') {
        const key = args.path ?? '';
        if (key === '') {
          return {
            directory: {
              current: '/plugins',
              parent: '/',
              entries: [
                { name: 'old', path: '/plugins/old', isDirectory: true },
                { name: 'new', path: '/plugins/new', isDirectory: true },
              ],
            },
          };
        }
        return new Promise<BrowseResult>((resolve, reject) => {
          pending.set(key, { resolve, reject });
        });
      }
      if (name === 'cafePathComplete') return true;
      if (name === 'settingsPluginInstall') {
        submittedPaths.push(JSON.parse(args.value ?? '{}').source.path);
        return { pluginId: 'local.race-ok', pluginInstanceId: 'inst-race-1' };
      }
      return {};
    });

    evalIn("S.lang = 'zh'; go('ext'); render(true); A.installDir();");
    await flush();

    // 1. Out-of-order browse: start /plugins/old, then /plugins/new; resolve new first, old second
    evalIn("A.pluginDirGo({ v: '/plugins/old' }); A.pluginDirGo({ v: '/plugins/new' });");
    pending.get('/plugins/new')?.resolve({
      directory: { current: '/plugins/new', parent: '/plugins', entries: [] },
    });
    await flush();
    pending.get('/plugins/old')?.resolve({
      directory: { current: '/plugins/old', parent: '/plugins', entries: [] },
    });
    await flush();
    expect(evalIn('VM.pluginDir().selected')).toBe('/plugins/new');
    expect(evalIn('VM.pluginDir().root')).toBe('/plugins/new');

    // Submit sends /plugins/new, not /plugins/old
    (w.document.querySelector('.pop-host[data-pop="dialog"] form button[type="submit"]') as HTMLButtonElement).click();
    await flush();
    expect(submittedPaths).toEqual(['/plugins/new']);

    // 2. Typing while browse is in flight: stale resolve and stale reject must not clobber typed input or show error
    evalIn('A.installDir();');
    await flush();
    evalIn("A.pluginDirGo({ v: '/plugins/slow-ok' });");
    const pathInput = w.document.getElementById('pd-path') as HTMLInputElement;
    pathInput.value = '/plugins/typed';
    pathInput.dispatchEvent(new w.Event('input', { bubbles: true }));
    pending.get('/plugins/slow-ok')?.resolve({
      directory: { current: '/plugins/slow-ok', parent: '/plugins', entries: [] },
    });
    await flush();
    expect(evalIn('VM.pluginDir().root')).toBe('/plugins/typed');
    expect(evalIn('VM.pluginDir().selected')).toBe('');

    evalIn("A.pluginDirGo({ v: '/plugins/slow-err' });");
    const pathInput2 = w.document.getElementById('pd-path') as HTMLInputElement;
    pathInput2.value = '/plugins/typed-after-err';
    pathInput2.dispatchEvent(new w.Event('input', { bubbles: true }));
    pending.get('/plugins/slow-err')?.reject(new Error('stale folder error'));
    await flush();
    expect(evalIn('VM.pluginDir().root')).toBe('/plugins/typed-after-err');
    expect(w.document.querySelector('.pop-host[data-pop="dialog"]')?.textContent).not.toContain('stale folder error');

    (w.document.querySelector('.pop-host[data-pop="dialog"] form button[type="submit"]') as HTMLButtonElement).click();
    await flush();
    expect(submittedPaths).toEqual(['/plugins/new', '/plugins/typed-after-err']);

    // 3. Close & reopen dialog while older browse is in flight: late error/response must not affect reopened dialog
    evalIn('A.installDir();');
    await flush();
    evalIn("A.pluginDirGo({ v: '/plugins/from-closed-err' });");
    evalIn('S.dialog = null; A.installDir();');
    await flush();
    pending.get('/plugins/from-closed-err')?.reject(new Error('closed dialog error'));
    await flush();
    expect(evalIn('VM.pluginDir().root')).toBe('/plugins/typed-after-err');
    expect(w.document.querySelector('.pop-host[data-pop="dialog"]')?.textContent).not.toContain('closed dialog error');
  });
});
