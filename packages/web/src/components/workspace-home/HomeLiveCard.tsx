'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { useMemo } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { groupRunningWork } from '@/components/workspace/workspace-running-work';
import { useCatData } from '@/hooks/useCatData';
import { resolveCatNameplateName } from '@/lib/cat-display-name';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { HomeExecutionRow } from './HomeExecutionRow';
import { ManagedExecutionDetail } from './ManagedExecutionDetail';
import { useHomeClock } from './use-home-clock';
import { homeCopy } from './workspace-home.shell-copy';
import { workspaceV3Copy } from './workspace-v3.shell-copy';

function HomeLiveContent({
  threadId,
  onSelectExecution,
}: {
  threadId?: string;
  onSelectExecution?: (execution: ActiveExecutionProjection) => void;
}) {
  const t = useShellCopy(homeCopy);
  const v3 = useShellCopy(workspaceV3Copy);
  const { getCatById } = useCatData();
  const executionsByKey = useActiveExecutionStore((state) => state.executionsByKey);
  const hydration = useActiveExecutionStore((state) => state.hydration);
  const running = useMemo(
    () =>
      groupRunningWork(Object.values(executionsByKey)).flatMap((work) =>
        work.executions.map((execution) => ({ ...work, key: activeExecutionKey(execution), executions: [execution] })),
      ),
    [executionsByKey],
  );
  const nicknameOwners = new Map<string, Set<string>>();
  for (const catId of new Set(running.map((work) => work.catId))) {
    const cat = getCatById(catId);
    const nickname = cat?.nickname?.trim() || cat?.displayName || catId;
    const owners = nicknameOwners.get(nickname) ?? new Set<string>();
    owners.add(catId);
    nicknameOwners.set(nickname, owners);
  }
  const rowName = (catId: string) => {
    const cat = getCatById(catId);
    const nickname = cat?.nickname?.trim() || cat?.displayName || catId;
    return (nicknameOwners.get(nickname)?.size ?? 0) > 1 ? resolveCatNameplateName(catId, getCatById) : nickname;
  };
  const ticking = running.length > 0;
  const now = useHomeClock(ticking, 1000);

  return (
    <section className="home-section" data-testid="workspace-developing" aria-labelledby="home-live-title">
      <header className="home-card-head">
        <span className="home-dot" data-tone="live" aria-hidden="true" />
        <h2 id="home-live-title" className="home-card-title text-sm">
          {t.live.title}
        </h2>
        <span className="home-card-scope text-xs">{t.live.scope(running.length)}</span>
      </header>
      {running.length === 0 && (
        <output data-testid="workspace-developing-status" className="text-xs text-cafe-muted">
          {hydration === 'loading' ? t.live.loading : hydration === 'error' ? t.live.unverified : v3.empty}
        </output>
      )}
      <div className="home-rows">
        {running.map((work) => (
          <HomeExecutionRow
            key={work.key}
            execution={work.executions[0]}
            threadTitle={work.threadTitle ?? work.threadId}
            catName={rowName(work.catId)}
            here={threadId !== undefined && work.threadId === threadId}
            now={now}
            onSelectExecution={onSelectExecution}
          />
        ))}
      </div>
      {hydration === 'error' && (
        <p className="home-card-foot text-xs" data-tone="warn">
          {t.live.stale}
        </p>
      )}
    </section>
  );
}

export function HomeLiveCard(props: Parameters<typeof HomeLiveContent>[0]) {
  return (
    <>
      <ManagedExecutionDetail threadId={props.threadId} />
      <HomeLiveContent {...props} />
    </>
  );
}
