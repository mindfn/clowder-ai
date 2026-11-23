import loadOrder from '../../public/pdl/load-order.json';
import { chatModels } from './chat-models';
import { frameRequest } from './frame-bridge';
import { installConsolePerf } from './perf';
import type { ChatPort } from './types';

const { scripts, styles } = loadOrder;
// The script and style URLs are the same in every build, so they carry the build: a document of a new
// build never gets an older worker's cached copy of them.
const build = process.env.NEXT_PUBLIC_CAT_CAFE_BUILD_REVISION;
const ofBuild = (url: string) => (build ? `${url}?v=${encodeURIComponent(build)}` : url);

export const scriptSources = [
  ...scripts.map((path) => `/pdl/${path}`),
  '/pdl-app/api.js',
  '/pdl-app/appearance.js',
  '/pdl-app/plugin-config.js',
  '/pdl-app/plugins.js',
  '/pdl-app/starry.js',
  '/pdl-app/workbench-data.js',
  '/pdl-app/planning-data.js',
  '/pdl-app/work-details.js',
  '/pdl-app/content-data.js',
  '/pdl-app/project.js',
  '/pdl-app/project-owners.js',
  '/pdl-app/owner-projections.js',
  '/pdl-app/members.js',
  '/pdl-app/watcher.js',
  '/pdl-app/matters.js',
  '/pdl-app/home.js',
  '/pdl-app/sidebar.js',
  '/pdl-app/inbox.js',
  '/pdl-app/accounts.js',
  '/pdl-app/profiles.js',
  '/pdl-app/capabilities.js',
  '/pdl-app/rules.js',
  '/pdl-app/thread-settings.js',
  '/pdl-app/notifications.js',
  '/pdl-app/setup.js',
  '/pdl-app/chat-owners.js',
  '/pdl-app/placement.js',
  '/pdl-app/chat.js',
];

let startup: Promise<void> | undefined;

export function mountChat(port: ChatPort): Promise<void> {
  startup ??= startChat(port);
  return startup;
}

async function startChat(port: ChatPort): Promise<void> {
  const perf = installConsolePerf();
  const bootT0 = performance.now();
  window.clowderFrameRequest = frameRequest;
  if (document.readyState === 'loading')
    await new Promise<void>((resolve) =>
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }),
    );
  for (const path of styles) {
    const t0 = performance.now();
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = ofBuild(`/pdl/${path}`);
    await new Promise<void>((resolve, reject) => {
      link.onload = () => resolve();
      link.onerror = () => reject(new Error(`Failed to load ${path}`));
      document.head.append(link);
    });
    perf.recordBootAsset('style', path, performance.now() - t0);
  }
  for (const path of scriptSources) {
    const t0 = performance.now();
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = ofBuild(path);
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${path}`));
      document.body.append(script);
    });
    perf.recordBootAsset('script', path, performance.now() - t0);
  }
  perf.instrumentClowderChat(window.clowderChat);
  const startT0 = performance.now();
  await window.clowderChat.start(perf.instrumentPort(port), perf.instrumentChatModels(chatModels));
  perf.recordBootStart(performance.now() - startT0);
  perf.finishBoot(performance.now() - bootT0);
}
