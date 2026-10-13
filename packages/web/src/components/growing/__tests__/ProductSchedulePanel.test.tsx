import type { EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';

const mocks = vi.hoisted(() => ({
  ownerReads: [] as EntrustedWorkOwnerReadV1[],
  loading: false,
  error: false,
  refetch: vi.fn(),
  projection: vi.fn(),
  resizeReading: null as (() => void) | null,
}));

vi.mock('@/hooks/useEntrustedWorkProjection', () => ({
  useEntrustedWorkProjection: (projection: string) => {
    mocks.projection(projection);
    return {
      ...mocks,
      ownerReads: mocks.ownerReads.filter((work) => Boolean(work.completion) === (projection === 'completed')),
    };
  },
}));

import { type PreparedArtifactCoordinate, ProductSchedulePanel, scheduleItemRef } from '../ProductSchedulePanel';
import { workCalendarDates } from '../work-calendar';

vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));

const now = Date.UTC(2026, 7, 31, 12);

function ownerRead(input: {
  id: string;
  titleRef: string;
  timeRole: 'business_deadline' | 'review_by';
  time: number;
  actionable?: boolean;
}): EntrustedWorkOwnerReadV1 {
  const subjectRef = `task:work:${input.id}`;
  const ownerRef = `task:item:${input.id}`;
  const producerRef = `approval:${input.id}`;
  return {
    envelope: {
      subjectRef,
      ownerRef,
      admissionReceiptRef: `task:receipt:${input.id}:3`,
      sourceRefs: [input.titleRef],
      revision: 3,
      freshness: { state: 'current', observedRevision: 3 },
      visibility: { ownerUserId: 'owner-1', human: true, cat: true },
    },
    brief: {
      outcome: {
        state: 'known',
        value: `Prepare ${input.id} outcome`,
        ownerRef,
        revision: 3,
      },
      current: { state: 'doing', ownerRef, revision: 3 },
      verifiedMilestone: input.actionable
        ? { kind: 'needs_judgment', evidenceRef: producerRef, revision: 5 }
        : {
            kind: 'artifact_ready',
            evidenceRef: `artifact:ppt:${input.id}#complete:7`,
            revision: '7',
          },
      nextOwner: input.actionable
        ? {
            kind: 'human',
            ownerRef: 'user:owner-1',
            evidence: [{ producerId: 'f246.approval', ownerRef: producerRef, revision: 5 }],
          }
        : { kind: 'cat', ownerRef: 'cat:codex-sol', evidenceRef: ownerRef, revision: 3 },
      needsMe: input.actionable
        ? { state: 'needed', evidence: [{ producerId: 'f246.approval', ownerRef: producerRef, revision: 5 }] }
        : { state: 'not_needed', evidenceRef: ownerRef, revision: 3 },
    },
    preparedArtifact: {
      artifactRef: `artifact:ppt:${input.id}`,
      artifactRevision: '7',
      completenessRef: `artifact:ppt:${input.id}#complete:7`,
      previewRef: `artifact:ppt:${input.id}#preview:7`,
      openInWorkspaceRef: `workspace:artifact:ppt:${input.id}:7`,
    },
    timeRefs: [
      {
        role: input.timeRole,
        subjectRef,
        ownerRef: `task:item:${input.id}`,
        revision: 3,
        value: input.time,
      },
    ],
    attentionReceipts: input.actionable
      ? [
          {
            eligible: true,
            producer: {
              producerId: 'f246.approval',
              ownerRef: producerRef,
              subjectRef: producerRef,
              revision: 5,
            },
            taskRef: { subjectRef, observedRevision: 3 },
            kind: 'judgment',
            reasonCode: 'direction_choice',
            recommendation: 'Use the evidence-first direction',
            salience: 'normal',
            action: { actionRef: `${producerRef}#decide`, expectedProducerRevision: 5 },
            reEvaluateActionRef: `${producerRef}#reevaluate`,
          },
        ]
      : [],
  };
}

describe('F310 ProductSchedulePanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  it('puts only actual starts and business deadlines on the calendar, without inventing admission dates', () => {
    const work = ownerRead({ id: 'real-dates', titleRef: 'message:source', timeRole: 'business_deadline', time: now });
    work.work = {
      title: '真实日期',
      ownerCatId: 'codex61-sol',
      threadId: 'thread-source',
      admittedAt: now - 86400000,
      ownerNote: '原托付',
    };
    const date = work.timeRefs[0];
    work.timeRefs = [
      { ...date, role: 'planned_start' },
      { ...date, role: 'review_by' },
      { ...date, role: 'estimated_completion' },
      { ...date, role: 'execution_trigger' },
      { ...date, role: 'actual_start' },
      date,
    ];
    const original = structuredClone(work);
    expect(workCalendarDates(work)).toEqual([{ ...date, role: 'actual_start' }, date]);
    expect(work).toEqual(original);
    work.timeRefs = [];
    expect(workCalendarDates(work)).toEqual([]);
  });

  it('starts in week view even when the actual panel reports a wide viewport', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: (entries: { contentRect: { width: number } }[]) => void) {}
        observe() {
          this.callback([{ contentRect: { width: 900 } }]);
        }
        disconnect() {}
      },
    );
    try {
      mocks.ownerReads = [];
      await act(async () => root.render(<ProductSchedulePanel now={() => now} />));
      expect(container.querySelector('[aria-label="工作日历"]')?.getAttribute('data-view')).toBe('week');
      expect(container.querySelector('[aria-label="本周安排"]')).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retains the chosen month and day while visiting the wide list and returning', async () => {
    await act(async () => root.render(<ProductSchedulePanel now={() => now} />));
    const click = async (label: string) =>
      act(async () =>
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === label)
          ?.click(),
      );
    await click('月');
    const day = container.querySelector<HTMLButtonElement>('[data-calendar-date]');
    await act(async () => day?.click());
    const selectedDay = day?.getAttribute('data-calendar-date');
    await click('展开成宽列表');
    await click('返回列表');
    expect(container.querySelector('[aria-label="工作日历"]')?.getAttribute('data-view')).toBe('month');
    expect(container.querySelector(`[data-calendar-date="${selectedDay}"]`)?.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps undated work blocked first, overdue collapsed and only the last seven days of actual completions visible', async () => {
    const undated = (id: string, state: 'todo' | 'doing' | 'blocked') => {
      const work = ownerRead({ id, titleRef: `message:${id}`, timeRole: 'review_by', time: now });
      work.brief.current.state = state;
      return work;
    };
    const overdue = ownerRead({
      id: 'overdue',
      titleRef: 'message:overdue',
      timeRole: 'business_deadline',
      time: now - 86400000,
    });
    const finished = (id: string, recordedAt?: number) => {
      const work = undated(id, 'doing');
      work.brief.current.state = 'done';
      work.completion = {
        ...(recordedAt === undefined ? {} : { recordedAt }),
        evidenceRefs: [`message:${id}:accepted`],
      };
      return work;
    };
    mocks.ownerReads = [
      undated('doing', 'doing'),
      undated('todo', 'todo'),
      overdue,
      undated('blocked', 'blocked'),
      finished('recent', now - 86400000),
      finished('old', now - 8 * 86400000),
      finished('unknown-time'),
    ];
    await act(async () => root.render(<ProductSchedulePanel now={() => now} />));
    const undatedList = container.querySelector('[data-testid="schedule-unscheduled"]');
    expect(
      Array.from(undatedList?.querySelectorAll('[data-subject-ref]') ?? []).map((el) =>
        el.getAttribute('data-subject-ref'),
      ),
    ).toEqual(['task:work:blocked', 'task:work:doing', 'task:work:todo']);
    const overdueList = container.querySelector<HTMLDetailsElement>('[data-testid="schedule-overdue"]');
    expect(overdueList).not.toBeNull();
    expect(overdueList?.open).toBe(false);
    expect(overdueList?.querySelector('summary')?.textContent).toContain('1 件已过截止时间');
    const completed = container.querySelector('[data-testid="schedule-recent-completed"]');
    expect(completed?.textContent).toContain('recent');
    expect(completed?.textContent).not.toContain('old');
    expect(completed?.textContent).not.toContain('unknown-time');
    expect(mocks.projection).toHaveBeenCalledWith('schedule');
    expect(mocks.projection).toHaveBeenCalledWith('completed');
  });

  it('keeps an admission goal in details when no owner progress has been recorded', async () => {
    const work = ownerRead({ id: 'legacy-work', titleRef: 'message:source', timeRole: 'review_by', time: now });
    work.work = {
      title: '原来的开发责任',
      ownerCatId: 'codex-sol',
      threadId: 'thread-original',
      admittedAt: now,
      ownerNote: '原始托付说明',
    };
    mocks.ownerReads = [work];
    await act(async () => root.render(<ProductSchedulePanel now={() => now} />));
    const item = container.querySelector('[data-testid="product-schedule-item"]');
    expect(item?.querySelector('[data-testid="work-owner-note"]')?.textContent).toContain('没有进展记录');
    expect(item?.querySelector('[data-testid="entrusted-work-brief"]')?.textContent).toContain(
      'Prepare legacy-work outcome',
    );
    expect(item?.querySelector('details')?.textContent).toContain('原始托付说明');
  });

  it('keeps owner facts and original-thread return outside details, with week/month views', async () => {
    const work = ownerRead({ id: 'native-work', titleRef: 'message:source', timeRole: 'review_by', time: now });
    work.timeRefs = [];
    work.work = {
      title: '工作日历与可见交付',
      ownerCatId: 'codex-sol',
      threadId: 'thread-original',
      admittedAt: now - 86_400_000,
      ownerNote: '等待已登记的审阅结果',
      progress: {
        summary: '页面已完成，正在复核',
        nextStep: '处理审阅结论',
        blockerReason: '等待已登记的审阅结果',
        sourceRef: 'message:progress',
      },
    };
    work.brief.current.state = 'blocked';
    mocks.ownerReads = [work];
    await act(async () => root.render(<ProductSchedulePanel now={() => now} />));
    const item = container.querySelector('[data-testid="product-schedule-item"]');
    expect(item?.querySelector('h3')?.textContent).toBe('工作日历与可见交付');
    expect(item?.querySelector('[data-testid="work-owner"]')?.closest('details')?.hasAttribute('open')).toBe(true);
    expect(item?.querySelector('[data-testid="work-owner"]')?.textContent).toContain('codex-sol');
    const origin = item?.querySelector('a[href="/thread/thread-original"]');
    expect(origin).not.toBeNull();
    expect(origin?.closest('details')?.hasAttribute('open')).toBe(true);
    expect(item?.querySelector('[data-testid="work-owner-note"]')?.textContent).toContain('等待已登记的审阅结果');
    expect(item?.querySelector('[data-testid="work-owner-note"]')?.textContent).toContain('处理审阅结论');
    expect(item?.textContent).toContain('接单日期');
    expect(item?.textContent).toContain('截止未定');
    expect(container.querySelector('[aria-label="本周安排"]')).not.toBeNull();
    const month = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '月');
    expect(month).toBeDefined();
    await act(async () => month?.click());
    const day = container.querySelector<HTMLButtonElement>('[data-calendar-date]');
    expect(day).not.toBeNull();
    await act(async () => day?.click());
    expect(container.querySelector('[data-subject-ref="task:work:native-work"]')).not.toBeNull();
  });

  it('keeps an accepted undated development visible without manufacturing a due date', async () => {
    const work = ownerRead({
      id: 'calendar-development',
      titleRef: 'message:calendar',
      timeRole: 'review_by',
      time: now,
    });
    work.timeRefs = [];
    work.preparedArtifact = undefined;
    work.brief.current.state = 'blocked';
    mocks.ownerReads = [work];
    await act(async () => {
      root.render(<ProductSchedulePanel now={() => now} />);
    });
    const item = container.querySelector('[data-subject-ref="task:work:calendar-development"]');
    expect(item).not.toBeNull();
    expect(item?.textContent).toContain('截止未定');
    expect(item?.textContent).toContain('受阻');
    expect(item?.textContent).not.toContain('安静进行中');
    expect(container.querySelector('[aria-label="工作日历"]')).not.toBeNull();
    expect(work.timeRefs).toEqual([]);
  });

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          mocks.resizeReading = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    mocks.ownerReads = [];
    mocks.loading = false;
    mocks.error = false;
    mocks.refetch.mockReset();
    mocks.projection.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    writeShellLanguage('zh');
    container.remove();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows quiet and actionable admitted work in business-time order from typed owner reads', async () => {
    mocks.ownerReads = [
      ownerRead({ id: 'quiet', titleRef: 'message:quiet-ppt', timeRole: 'business_deadline', time: now + 86_400_000 }),
      ownerRead({
        id: 'actionable',
        titleRef: 'message:actionable-ppt',
        timeRole: 'review_by',
        time: now + 3_600_000,
        actionable: true,
      }),
    ];

    await act(async () => {
      root.render(<ProductSchedulePanel now={() => now} />);
    });

    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '展开成宽列表')
        ?.click(),
    );

    const rows = container.querySelectorAll('[data-testid="product-schedule-item"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute('data-owner-ref')).toBe('task:item:actionable');
    expect(rows[0]?.textContent).toContain('请你审阅');
    expect(rows[0]?.textContent).toContain('等你判断');
    expect(rows[0]?.textContent).toContain('Prepare actionable outcome');
    expect(rows[0]?.textContent).toContain('已到需要你判断的节点');
    expect(rows[0]?.textContent).toContain('You');
    expect(rows[0]?.textContent).toContain('现在需要你');
    // Technical coordinates stay in the innermost details, not in the brief's Artifact field.
    expect(rows[0]?.textContent).not.toContain('Artifact r7');
    expect(rows[0]?.querySelector('[data-testid="entrusted-work-brief-artifact"]')?.textContent).toBe('准备好的作品');
    expect(rows[0]?.querySelector('[data-testid="entrusted-work-brief"] details')?.textContent).toContain(
      'artifact:ppt:actionable',
    );
    expect(rows[1]?.getAttribute('data-owner-ref')).toBe('task:item:quiet');
    expect(rows[1]?.textContent).toContain('截止');
    expect(rows[1]?.textContent).toContain('codex-sol');
    expect(rows[1]?.textContent).toContain('现在不需要你');
    expect(rows[1]?.querySelector('[data-testid="entrusted-work-brief-artifact"]')?.textContent).toBe('准备好的作品');
    expect(rows[1]?.querySelector('[data-testid="entrusted-work-brief"] details')?.textContent).toContain(
      'artifact:ppt:quiet',
    );
    expect(container.textContent).not.toContain('Unadmitted conversation candidate');
  });

  for (const [elapsed, expected, english] of [
    [3600000, '超过截止时间，未满 1 天', 'Less than 1 day past the deadline'],
    [3.5 * 86400000, '超过截止时间 3 天', '3 days past the deadline'],
  ] as const) {
    it(`reports ${elapsed}ms past the real deadline without rounding up`, async () => {
      const work = ownerRead({
        id: 'elapsed',
        titleRef: 'message:deadline',
        timeRole: 'business_deadline',
        time: now - elapsed,
      });
      mocks.ownerReads = [work];
      await act(async () =>
        root.render(<ProductSchedulePanel now={() => now} selectedItemRef={scheduleItemRef(work)} />),
      );
      expect(container.querySelector('[data-testid="product-schedule-item"]')?.textContent).toContain(expected);
      await act(async () => writeShellLanguage('en'));
      expect(container.querySelector('[data-testid="product-schedule-item"]')?.textContent).toContain(english);
      expect(container.querySelector('[data-testid="product-schedule-item"]')?.getAttribute('data-selected')).toBe(
        'true',
      );
    });
  }

  it('discards the local reading point when the original artifact read fails without leaving', async () => {
    const work = ownerRead({ id: 'failed', titleRef: 'message:failed', timeRole: 'review_by', time: now });
    work.timeRefs = [];
    mocks.ownerReads = [work];
    const itemRef = scheduleItemRef(work);
    const open = vi.fn<(artifact: PreparedArtifactCoordinate, itemRef: string, title?: string) => void>();
    const render = (artifactsLoading: boolean) =>
      root.render(
        <ProductSchedulePanel
          now={() => now}
          selectedItemRef={itemRef}
          artifactsLoading={artifactsLoading}
          onOpenArtifact={open}
        />,
      );
    open.mockImplementation(() => render(true));
    await act(async () => render(false));
    const port = container.querySelector<HTMLDivElement>('[data-testid="schedule-unscheduled"]');
    if (!port) throw new Error('expected the original list');
    let width = 928;
    Object.defineProperty(port, 'clientWidth', { get: () => width });
    port.scrollTop = 4051;
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="product-schedule-open-artifact"]')?.click(),
    );
    width = 247;
    mocks.resizeReading?.();
    width = 928;
    mocks.resizeReading?.();
    await act(async () => render(false));
    port.scrollTop = 2000;
    width = 247;
    mocks.resizeReading?.();
    width = 928;
    mocks.resizeReading?.();
    expect(port.scrollTop).toBe(2000);
  });

  for (const transition of ['failed different artifact', 'scope', 'owner refresh'] as const) {
    it(`does not reveal the previous selection again after ${transition}`, async () => {
      const previous = ownerRead({ id: 'previous', titleRef: 'message:previous', timeRole: 'review_by', time: now });
      const current = ownerRead({ id: 'current', titleRef: 'message:current', timeRole: 'review_by', time: now });
      previous.timeRefs = [];
      current.timeRefs = [];
      mocks.ownerReads = [previous, current];
      const reveal = vi.fn();
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: reveal });
      const open = vi.fn<(artifact: PreparedArtifactCoordinate, itemRef: string, title?: string) => void>();
      const render = (artifactsLoading = false) =>
        root.render(
          <ProductSchedulePanel
            now={() => now}
            selectedItemRef={scheduleItemRef(previous)}
            artifactsLoading={artifactsLoading}
            onOpenArtifact={open}
          />,
        );
      open.mockImplementation(() => render(true));
      try {
        await act(async () => render());
        expect(reveal).toHaveBeenCalledOnce();
        reveal.mockClear();
        if (transition === 'failed different artifact') {
          await act(async () =>
            container
              .querySelector<HTMLButtonElement>(
                '[data-subject-ref="task:work:current"] [data-testid="product-schedule-open-artifact"]',
              )
              ?.click(),
          );
          expect(open).toHaveBeenCalledOnce();
          await act(async () => render(false));
        } else if (transition === 'scope') {
          await act(async () =>
            Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
              .find((button) => button.textContent === '已完成')
              ?.click(),
          );
          await act(async () =>
            Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
              .find((button) => button.textContent === '当前工作')
              ?.click(),
          );
        } else {
          mocks.loading = true;
          await act(async () => render());
          mocks.loading = false;
          await act(async () => render());
        }
        expect(reveal).not.toHaveBeenCalled();
      } finally {
        if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
        else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
      }
    });
  }

  for (const language of ['zh', 'en'] as const) {
    it(`labels an empty calendar day honestly while retaining all 22 undated works in ${language}`, async () => {
      await act(async () => writeShellLanguage(language));
      mocks.ownerReads = Array.from({ length: 22 }, (_, index) => {
        const work = ownerRead({
          id: `undated-${index}`,
          titleRef: 'message:source',
          timeRole: 'review_by',
          time: now,
        });
        work.timeRefs = [];
        return work;
      });
      await act(async () => root.render(<ProductSchedulePanel now={() => now} />));
      await act(async () => container.querySelector<HTMLButtonElement>('[data-calendar-date]')?.click());
      expect(container.querySelector('[data-testid="schedule-unscheduled"]')?.querySelectorAll('article')).toHaveLength(
        22,
      );
      const heading = container.querySelector('[data-testid="schedule-worklist"] h3');
      expect(heading?.textContent).toContain(language === 'en' ? 'and unscheduled work' : '和未排期工作');
      expect(heading?.textContent).toContain('22');
    });
  }

  it('reveals an external completion when its original owner read first becomes ready', async () => {
    const work = ownerRead({ id: 'external-done', titleRef: 'message:done', timeRole: 'review_by', time: now });
    work.brief.current.state = 'done';
    work.completion = { recordedAt: now - 1000, evidenceRefs: ['message:accepted'] };
    mocks.ownerReads = [work];
    mocks.loading = true;
    const reveal = vi.fn();
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: reveal });
    const render = () => root.render(<ProductSchedulePanel now={() => now} selectedItemRef={scheduleItemRef(work)} />);
    try {
      await act(async () => render());
      expect(reveal).not.toHaveBeenCalled();
      mocks.loading = false;
      await act(async () => render());
      expect(reveal).toHaveBeenCalledOnce();
      expect(container.querySelector('[data-view="week"]')).toBeNull();
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('returns a locally opened recent completion to the same active calendar and recent list', async () => {
    const work = ownerRead({
      id: 'recent-return',
      titleRef: 'message:recent-return',
      timeRole: 'review_by',
      time: now,
    });
    work.timeRefs = [];
    work.brief.current.state = 'done';
    work.completion = { recordedAt: now - 1000, evidenceRefs: ['message:accepted'] };
    mocks.ownerReads = [work];
    const open = vi.fn<(artifact: PreparedArtifactCoordinate, itemRef: string, title?: string) => void>();
    open.mockImplementation((_artifact, itemRef) =>
      root.render(<ProductSchedulePanel now={() => now} selectedItemRef={itemRef} onOpenArtifact={open} />),
    );
    await act(async () => root.render(<ProductSchedulePanel now={() => now} onOpenArtifact={open} />));
    const recent = container.querySelector<HTMLElement>('[data-testid="schedule-recent-completed"]');
    if (!recent) throw new Error('expected the original recent completions');
    let width = 928;
    Object.defineProperty(recent, 'clientWidth', { get: () => width });
    recent.scrollTop = 123;
    await act(async () =>
      recent.querySelector<HTMLButtonElement>('[data-testid="product-schedule-open-artifact"]')?.click(),
    );
    container.setAttribute('role', 'complementary');
    width = 247;
    recent.scrollTop = 0;
    mocks.resizeReading?.();
    container.removeAttribute('role');
    width = 928;
    mocks.resizeReading?.();
    expect(container.querySelector('[data-testid="schedule-recent-completed"]')).toBe(recent);
    expect(container.querySelector('[data-view="week"]')).not.toBeNull();
    expect(recent.scrollTop).toBe(123);
  });

  it('restores local list reading once and respects later user scrolling', async () => {
    const work = ownerRead({ id: 'reading', titleRef: 'message:reading', timeRole: 'review_by', time: now });
    work.timeRefs = [];
    mocks.ownerReads = [work];
    const open = vi.fn<(artifact: PreparedArtifactCoordinate, itemRef: string, title?: string) => void>();
    open.mockImplementation((_artifact, itemRef) => {
      root.render(<ProductSchedulePanel now={() => now} selectedItemRef={itemRef} onOpenArtifact={open} />);
    });
    await act(async () => root.render(<ProductSchedulePanel now={() => now} onOpenArtifact={open} />));
    const port = container.querySelector<HTMLDivElement>('[data-testid="schedule-unscheduled"]');
    if (!port) throw new Error('expected the original Schedule list');
    let width = 928;
    Object.defineProperty(port, 'clientWidth', { get: () => width });
    port.scrollTop = 4051;
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="product-schedule-open-artifact"]')?.click(),
    );
    container.setAttribute('role', 'complementary');
    width = 247;
    port.scrollTop = 0;
    mocks.resizeReading?.();
    container.removeAttribute('role');
    width = 928;
    mocks.resizeReading?.();
    expect(port.scrollTop).toBe(4051);
    port.scrollTop = 2000;
    container.setAttribute('role', 'complementary');
    width = 247;
    mocks.resizeReading?.();
    container.removeAttribute('role');
    width = 928;
    mocks.resizeReading?.();
    expect(port.scrollTop).toBe(2000);
  });

  it('keeps a locally opened result at its reading point but reveals an external return target', async () => {
    const local = ownerRead({ id: 'local', titleRef: 'message:local', timeRole: 'review_by', time: now });
    const external = ownerRead({ id: 'external', titleRef: 'message:external', timeRole: 'review_by', time: now });
    local.timeRefs = [];
    external.timeRefs = [];
    mocks.ownerReads = [local, external];
    const reveal = vi.fn();
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: reveal });
    const open = vi.fn<(artifact: PreparedArtifactCoordinate, itemRef: string, title?: string) => void>();
    open.mockImplementation((_artifact, itemRef) => {
      root.render(<ProductSchedulePanel now={() => now} selectedItemRef={itemRef} onOpenArtifact={open} />);
    });
    try {
      await act(async () => root.render(<ProductSchedulePanel now={() => now} onOpenArtifact={open} />));
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-subject-ref="task:work:local"] [data-testid="product-schedule-open-artifact"]',
          )
          ?.click(),
      );
      expect(open).toHaveBeenCalledOnce();
      expect(reveal).not.toHaveBeenCalled();
      await act(async () =>
        root.render(
          <ProductSchedulePanel now={() => now} selectedItemRef={scheduleItemRef(external)} onOpenArtifact={open} />,
        ),
      );
      expect(reveal).toHaveBeenCalledOnce();
      await act(async () =>
        root.render(
          <ProductSchedulePanel now={() => now} selectedItemRef={scheduleItemRef(local)} onOpenArtifact={open} />,
        ),
      );
      expect(reveal).toHaveBeenCalledTimes(2);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('opens the exact source-owned prepared Artifact coordinate', async () => {
    const openArtifact = vi.fn();
    mocks.ownerReads = [
      ownerRead({ id: 'quiet', titleRef: 'message:quiet-ppt', timeRole: 'business_deadline', time: now + 86_400_000 }),
    ];
    await act(async () => {
      root.render(
        <ProductSchedulePanel now={() => now} selectedItemRef="task:work:quiet|3" onOpenArtifact={openArtifact} />,
      );
    });

    await act(async () => {
      container
        .querySelector('[data-testid="product-schedule-open-artifact"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(openArtifact).toHaveBeenCalledWith(
      {
        artifactRef: 'artifact:ppt:quiet',
        artifactRevision: '7',
        completenessRef: 'artifact:ppt:quiet#complete:7',
        previewRef: 'artifact:ppt:quiet#preview:7',
        openInWorkspaceRef: 'workspace:artifact:ppt:quiet:7',
      },
      'task:work:quiet|3',
      undefined, // an F232 artifact has no review title to carry into the tab
    );
    expect(container.querySelector('[data-testid="product-schedule-item"]')?.getAttribute('data-selected')).toBe(
      'true',
    );
    const [firstOwnerRead] = mocks.ownerReads;
    expect(firstOwnerRead).toBeDefined();
    if (!firstOwnerRead) throw new Error('expected one owner read');
    expect(scheduleItemRef(firstOwnerRead)).toBe('task:work:quiet|3');
  });

  it('keeps the terminal projection bounded at narrow panel widths', async () => {
    await act(async () => {
      root.render(<ProductSchedulePanel now={() => now} />);
    });

    const panel = container.querySelector<HTMLElement>('[data-testid="product-schedule-panel"]');
    expect(panel?.className).toContain('min-w-0');
    expect(panel?.className).toContain('overflow-x-hidden');
  });

  it('shows unknown instead of inventing outcome, milestone, owner, or Artifact truth', async () => {
    const unknown = ownerRead({
      id: 'unknown',
      titleRef: 'message:unknown',
      timeRole: 'review_by',
      time: now + 3_600_000,
    });
    mocks.ownerReads = [
      {
        ...unknown,
        brief: {
          ...unknown.brief,
          outcome: { state: 'unknown' },
          verifiedMilestone: { kind: 'unknown' },
          nextOwner: { kind: 'unknown' },
        },
        preparedArtifact: undefined,
      },
    ];

    await act(async () => {
      root.render(<ProductSchedulePanel now={() => now} />);
    });

    const item = container.querySelector('[data-testid="product-schedule-item"]');
    expect(item?.textContent?.match(/unknown/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('restores completed history on exact Artifact return without showing overdue or asking for a new review', async () => {
    const work = ownerRead({
      id: 'finished',
      titleRef: 'message:done',
      timeRole: 'business_deadline',
      time: now - 86_400_000,
    });
    work.brief.current.state = 'done';
    work.brief.nextOwner = { kind: 'unknown' };
    work.brief.verifiedMilestone = { kind: 'work_completed', evidenceRef: work.envelope.ownerRef, revision: 3 };
    work.completion = { recordedAt: now - 3600, evidenceRefs: ['message:accepted'] };
    mocks.ownerReads = [work];
    await act(async () =>
      root.render(
        <ProductSchedulePanel now={() => now} selectedItemRef={scheduleItemRef(work)} onOpenReview={vi.fn()} />,
      ),
    );
    expect(mocks.projection).toHaveBeenLastCalledWith('completed');
    expect(container.querySelector('fieldset[aria-label="筛选工作"]')).toBeNull();
    const item = container.querySelector('[data-testid="product-schedule-item"]');
    expect(item?.getAttribute('data-selected')).toBe('true');
    expect(item?.textContent).toContain('已完成');
    expect(item?.textContent).not.toContain('已逾期');
    expect(item?.textContent).toContain('打开成果');
    expect(item?.textContent).toContain('message:accepted');
  });
});
