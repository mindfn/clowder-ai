import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import {
  explorationFixture,
  objectRef,
  source,
} from '../../../../../api/test/capability-evolution-exploration.helper.mjs';
import { parseProgramProjection } from '../evolution-program-projection';
import { useEvolutionReading } from '../evolution-reading-state';
import { EvolutionMomentContext } from '../journey/EvolutionMomentContext';
import { programFixture } from './evolution-fixtures';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: api.fetch }));
let host: HTMLDivElement;
let root: Root;
let failDetail = false;
const title = ['先理解整件事', '再用真实输入验收'];
function catalog(path: string) {
  const url = new URL(path, 'https://cafe.invalid');
  const base = explorationFixture({ withDetail: true });
  const nodes = title.map((name, index) => ({
    kind: 'public_archive',
    nodeRef: source(`step-${index}`),
    title: name,
    summary: `这一步的经历 ${index}`,
    sourceRef: source('publication'),
    history: { period: `10月${index + 7}日`, updatedThrough: '2026-10-16' },
    changes: [{ label: '当时改变', detail: '改用原话里的例子', sourceRef: source('change') }],
    parentEdges: index
      ? [{ parentNodeRef: source('step-0'), sourceRef: source('relation'), description: '完整交付还要检查真实输入' }]
      : [],
  }));
  const experiments = nodes.map((node, index) => ({
    ...base.experiments[0],
    nodeRef: node.nodeRef,
    experimentRef: source(`run-${index}`),
    title: `打不开真实文件 ${index}`,
    metrics: [],
    conditions: {
      ...base.experiments[0]!.conditions,
      window: { ...base.experiments[0]!.conditions.window, label: `2026-10-0${index + 7}` },
    },
  }));
  const raw = url.searchParams.get('selectedExperimentRef');
  const run = experiments.find((entry) => raw && JSON.parse(raw).ownerStateRef === entry.experimentRef.ownerStateRef);
  const details = run
    ? [
        {
          status: 'resolved',
          experimentRef: run.experimentRef,
          nodeRef: run.nodeRef,
          records: [
            {
              ...base.details[0]!.records[0],
              nodeRef: run.nodeRef,
              experimentRef: run.experimentRef,
              output: [
                { label: '踩了什么坑', value: run.title },
                { label: '当时怎么应对', value: '打开用户指定的文件' },
              ],
              result: { status: 'observed', label: '后来补齐了打开路径，仍待正式加载' },
              values: {},
              sources: [
                {
                  label: '案例原文',
                  ref: source('case'),
                  href: `https://github.com/zts212653/clowder-ai/blob/${'a'.repeat(40)}/docs/example.md`,
                },
              ],
            },
          ],
        },
      ]
    : [];
  return { ...base, nodes, experiments, details };
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  useEvolutionReading.setState({ programs: {} });
  failDetail = false;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  api.fetch.mockImplementation(async (path: string) =>
    path.includes('/exploration')
      ? failDetail && path.includes('selectedExperimentRef')
        ? new Response('{}', { status: 503 })
        : Response.json(catalog(path))
      : path === '/api/workspace/worktrees'
        ? Response.json({ worktrees: [{ id: 'actual-repo-root', branch: 'main' }] })
        : new Response('{}', { status: 404 }),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
async function show() {
  const value = programFixture('observing');
  value.program.objectRef = objectRef;
  await act(async () =>
    root.render(
      <EvolutionMomentContext projection={parseProgramProjection(value)!} moment={2} explorationMode="workspace" />,
    ),
  );
  return value.program.programId;
}
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((entry) => entry.textContent?.includes(text))!;
it('reads historical cases from the first step through the next, keeps source navigation and the selected place', async () => {
  const id = await show();
  expect(host.textContent).toContain('错题谱系');
  expect(host.querySelector('[data-history-step] h3')?.textContent).toBe(title[0]);
  expect(host.textContent).toContain('踩了什么坑');
  expect(host.textContent).toContain('当时怎么应对');
  expect(host.textContent).toContain('后来怎样了');
  expect(host.textContent).not.toContain('效用门槛未冻结');
  expect(host.querySelector('[aria-label="选择本版实验"]')).toBeNull();
  await act(async () => button('下一步').click());
  expect(host.querySelector('[data-history-step] h3')?.textContent).toBe(title[1]);
  expect(host.textContent).toContain('完整交付还要检查真实输入');
  expect(useEvolutionReading.getState().programs[id]?.exploration?.comparisonExperimentRef).toBeUndefined();
  const open = vi.spyOn(useChatStore.getState(), 'setWorkspaceOpenFile');
  await act(async () => button('看原案例').click());
  expect(open.mock.calls[0]?.[0]).toBe('docs/example.md');
  expect(open.mock.calls[0]?.[2]).toBe('actual-repo-root');
  expect(useEvolutionReading.getState().programs[id]?.exploration?.selectedNodeRef?.ownerStateRef).toBe(
    'source:step-1',
  );
});
it('keeps the historical navigation and a retry visible when a selected case fails to load', async () => {
  failDetail = true;
  await show();
  expect(host.textContent).toContain('错题谱系');
  expect(host.textContent).not.toContain('后来补齐了打开路径');
  expect(button('重试')).toBeDefined();
  failDetail = false;
  await act(async () => button('重试').click());
  expect(host.textContent).toContain('后来补齐了打开路径');
});
