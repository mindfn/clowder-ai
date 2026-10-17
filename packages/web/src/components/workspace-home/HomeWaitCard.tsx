'use client';

import type { DeploymentWaitItemProjection, DeploymentWaitListResponse } from '@cat-cafe/shared';
import { useShellCopy } from '@/components/shell/shell-copy';
import { ThreadChatLink } from '@/components/workspace/ThreadChatLink';
import type { DeploymentWaitHydration } from '@/components/workspace/WorkspaceDeploymentWaits';
import { useCatData } from '@/hooks/useCatData';
import { useDeploymentWaitProjection } from '@/hooks/useDeploymentWaitProjection';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { formatObservedAge, formatWaitDuration, shortRevision } from './format';
import { useHomeClock } from './use-home-clock';
import { type HomeCopy, homeCopy } from './workspace-home.shell-copy';

/**
 * 等待与接回 on the new shell's Workspace home — presentation only.
 *
 * Owned by F323: the same `/api/runtime-deployment/waits` projection, hydration states and 重试 as the classic card, the
 * same three item states. A short neutral summary stays visible; the original condition and next step remain in a closed
 * disclosure. The candidate count is a forecast after deployment, never a claim that a waiting item is already ready.
 */

const STATE_ORDER: Record<DeploymentWaitItemProjection['state'], number> = {
  ready_to_return: 0,
  unknown: 1,
  waiting_for_update: 2,
};

function waitedText(t: HomeCopy, item: DeploymentWaitItemProjection, now: number): string {
  if (item.createdAt === null) return t.wait.waitUnknown;
  const elapsed = Math.max(0, (item.matchedAt ?? now) - item.createdAt);
  return elapsed < 60_000 ? t.wait.justRegistered : t.wait.waited(formatWaitDuration(elapsed, t.time));
}

/**
 * The row's condition, in the tense the canonical state allows. A waiting or unknown row states what it is waiting for
 * (the same condition and services F323 holds); only `ready_to_return` says it has happened. Each of the four cases is one
 * whole sentence in the dictionary: the two languages join the condition and the services differently.
 */
function conditionText(t: HomeCopy, item: DeploymentWaitItemProjection): string {
  const services = item.condition.services.map((service) => service.toUpperCase()).join(' + ');
  const done = item.state === 'ready_to_return';
  if (item.condition.kind === 'revision_included') {
    const revision = shortRevision(item.condition.revision);
    return done ? t.wait.satisfiedRevision(revision, services) : t.wait.awaitingRevision(revision, services);
  }
  return done ? t.wait.satisfiedNewBoot(services) : t.wait.awaitingNewBoot(services);
}

function reasonText(t: HomeCopy, item: DeploymentWaitItemProjection): string | null {
  switch (item.stateReason) {
    case 'deployment_evidence_unavailable':
      return t.wait.reasonUnavailable;
    case 'deployment_evidence_incomplete':
      return t.wait.reasonIncomplete;
    case 'deployment_match_pending_recheck':
      return t.wait.reasonRecheck;
    default:
      return item.state === 'unknown' ? t.wait.undetermined : null;
  }
}

function WaitRow({ item, now }: { item: DeploymentWaitItemProjection; now: number }) {
  const t = useShellCopy(homeCopy);
  const { getCatById } = useCatData();
  const owner = item.ownerCatId ? resolveCatDisplayName(item.ownerCatId, getCatById) : t.wait.ownerUnknown;
  const reason = reasonText(t, item);
  const nextStep = item.nextStep || t.wait.nextStepFallback;
  const ready = item.state === 'ready_to_return';
  const summary = ready
    ? t.wait.readySummary
    : item.state === 'unknown'
      ? item.condition.kind === 'revision_included'
        ? t.wait.revisionUnconfirmed
        : t.wait.bootUnconfirmed
      : item.condition.kind === 'revision_included'
        ? t.wait.waitForFix
        : t.wait.waitForBoot;
  return (
    <article className="home-wait-row" data-testid="workspace-deployment-wait-item" data-state={item.state}>
      <div className="home-wait-main">
        <div className="home-wait-copy">
          <b className="home-wait-title text-compact">{item.taskTitle}</b>{' '}
          <span className="home-wait-summary text-xs">
            {summary} · {waitedText(t, item, now)} · {owner}
          </span>
        </div>
        <ThreadChatLink
          threadId={item.threadId}
          label={t.wait.openConversation}
          className="home-btn shell-focusable text-xs"
          title={t.wait.openConversation}
        />
      </div>
      <details className="home-wait-details text-xs">
        <summary className="shell-focusable">{ready ? t.wait.readyDetails : t.wait.returnDetails}</summary>
        <small className="home-wait-line text-xs">{conditionText(t, item)}</small>
        {reason && <small className="home-wait-line text-xs">{reason}</small>}
        <small className="home-wait-line text-xs">
          {ready ? t.wait.canContinue(nextStep) : t.wait.afterReturn(nextStep)}
        </small>
      </details>
    </article>
  );
}

function CandidateLine({ projection, now }: { projection: DeploymentWaitListResponse; now: number }) {
  const t = useShellCopy(homeCopy);
  const candidate = projection.candidate;
  if (!candidate) return null;
  return (
    <p
      className="home-card-foot text-xs"
      data-testid="deployment-candidate-preview"
      title={`${t.wait.candidate(shortRevision(candidate.revision))} · ${t.wait.observed(formatObservedAge(candidate.observedAt, now, t.time))} · ${t.wait.satisfiable(candidate.satisfiableCount)}`}
    >
      {t.wait.resumeForecast(candidate.satisfiableCount)}
      {candidate.unknownCount > 0 && <span> · {t.wait.unknownEvidence(candidate.unknownCount)}</span>}
    </p>
  );
}

function WaitCardView({
  projection,
  hydration,
  onRetry,
}: {
  projection: DeploymentWaitListResponse | null;
  hydration: DeploymentWaitHydration;
  onRetry: () => void;
}) {
  const t = useShellCopy(homeCopy);
  const now = useHomeClock(projection !== null && projection.items.length > 0, 30_000);
  if (hydration === 'idle') return null;
  if (!projection && hydration === 'loading') {
    return (
      <section className="home-card home-note text-xs" data-testid="workspace-deployment-waits">
        {t.wait.loading}
      </section>
    );
  }
  if (!projection) {
    return (
      <section className="home-card home-note text-xs" data-tone="warn" data-testid="workspace-deployment-waits">
        <span>{t.wait.error}</span>
        <button
          type="button"
          className="home-link shell-focusable text-xs"
          onClick={onRetry}
          data-testid="deployment-waits-retry"
        >
          {t.wait.retry}
        </button>
      </section>
    );
  }

  const items = [...projection.items].sort((left, right) => STATE_ORDER[left.state] - STATE_ORDER[right.state]);
  return (
    <section className="home-card" data-testid="workspace-deployment-waits" aria-labelledby="home-wait-title">
      <div data-testid="home-wait-card-body">
        <header className="home-card-head">
          <span className="home-dot" data-tone="wait" aria-hidden="true" />
          <h2 id="home-wait-title" className="home-card-title text-sm">
            {t.wait.title}
          </h2>
          {items.length > 0 && <span className="home-card-scope text-xs">{t.wait.scope(items.length)}</span>}
        </header>
        {items.length === 0 ? (
          <div className="home-empty">
            <p className="home-empty-title text-compact">{t.wait.empty}</p>
            <p className="home-empty-hint text-xs">{t.wait.emptyHint}</p>
          </div>
        ) : (
          <div className="home-rows">
            {items.map((item) => (
              <WaitRow key={item.taskId} item={item} now={now} />
            ))}
          </div>
        )}
        <CandidateLine projection={projection} now={now} />
        {hydration === 'error' && (
          <p className="home-card-foot text-xs" data-tone="warn">
            <span>{t.wait.stale}</span>{' '}
            <button
              type="button"
              className="home-link shell-focusable text-xs"
              onClick={onRetry}
              data-testid="deployment-waits-retry"
            >
              {t.wait.retry}
            </button>
          </p>
        )}
      </div>
    </section>
  );
}

export function HomeWaitCard({ hideWhenEmpty = false }: { hideWhenEmpty?: boolean } = {}) {
  const projectPath = useActiveExecutionStore((state) => state.projectPath);
  const deploymentWaits = useDeploymentWaitProjection(projectPath);
  if (hideWhenEmpty && deploymentWaits.hydration !== 'error' && deploymentWaits.projection?.items.length === 0)
    return null;
  return (
    <WaitCardView
      projection={deploymentWaits.projection}
      hydration={deploymentWaits.hydration}
      onRetry={() => void deploymentWaits.retry()}
    />
  );
}
