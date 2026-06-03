/**
 * F220 Phase B: GitHub Schedule Factories
 *
 * Wraps 4 existing GitHub poller TaskSpec factories as ScheduleFactory implementations
 * for registration in ScheduleFactoryRegistry. Each factory extracts typed deps from the
 * generic ScheduleFactoryDeps bag and delegates to the existing createXxxTaskSpec function.
 *
 * KD-3: All factories are white-listed by factoryId — no arbitrary script loading.
 * KD-7: Poller logic unchanged — factories only wire deps and override task ID.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CapabilitiesConfig } from '@cat-cafe/shared';
import type { IConnectorThreadBindingStore } from '../../infrastructure/connectors/ConnectorThreadBindingStore.js';
import type { ReconciliationDedup } from '../../infrastructure/connectors/github-repo-event/ReconciliationDedup.js';
import type { GhIssueItem, GhPrItem } from '../../infrastructure/connectors/github-repo-event/RepoScanTaskSpec.js';
import { createRepoScanTaskSpec } from '../../infrastructure/connectors/github-repo-event/RepoScanTaskSpec.js';
import { createCiCdCheckTaskSpec } from '../../infrastructure/email/CiCdCheckTaskSpec.js';
import type { CiCdRouter } from '../../infrastructure/email/CiCdRouter.js';
import type { ConflictAutoExecutor } from '../../infrastructure/email/ConflictAutoExecutor.js';
import { createConflictCheckTaskSpec } from '../../infrastructure/email/ConflictCheckTaskSpec.js';
import type { ConflictRouter } from '../../infrastructure/email/ConflictRouter.js';
import type { ConnectorInvokeTrigger } from '../../infrastructure/email/ConnectorInvokeTrigger.js';
import type {
  ConnectorDeliveryDeps,
  ConnectorDeliveryInput,
  ConnectorDeliveryResult,
} from '../../infrastructure/email/deliver-connector-message.js';
import type {
  PrFeedbackComment,
  PrReviewDecision,
  ReviewFeedbackRouter,
} from '../../infrastructure/email/ReviewFeedbackRouter.js';
import type { ReviewFeedbackPrMetadata } from '../../infrastructure/email/ReviewFeedbackTaskSpec.js';
import { createReviewFeedbackTaskSpec } from '../../infrastructure/email/ReviewFeedbackTaskSpec.js';
import type { TaskSpec_P1 } from '../../infrastructure/scheduler/types.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { ScheduleFactory, ScheduleFactoryDeps, ScheduleFactoryRegistry } from './ScheduleFactoryRegistry.js';

/**
 * Typed dep extraction for GitHub schedule factories.
 *
 * Extends the generic ScheduleFactoryDeps with all services needed by the 4 pollers.
 * Assembled in index.ts where these services are created.
 */
export interface GitHubScheduleDeps extends ScheduleFactoryDeps {
  taskStore: ITaskStore;
  cicdRouter: CiCdRouter;
  conflictRouter: ConflictRouter;
  reviewFeedbackRouter: ReviewFeedbackRouter;
  invokeTrigger: ConnectorInvokeTrigger;
  checkMergeable: (repo: string, pr: number) => Promise<{ mergeState: string; headSha: string }>;
  autoExecutor: ConflictAutoExecutor;
  fetchPrMetadata: (repo: string, pr: number) => Promise<ReviewFeedbackPrMetadata | null>;
  fetchComments: (repo: string, pr: number, sinceId?: number) => Promise<PrFeedbackComment[]>;
  fetchReviews: (repo: string, pr: number, sinceId?: number) => Promise<PrReviewDecision[]>;
  isEchoComment: (c: PrFeedbackComment) => boolean;
  isEchoReview: (r: PrReviewDecision) => boolean;
  isNoiseComment: (c: PrFeedbackComment) => boolean;
  // repo-scan deps — optional, not available when redis is not configured
  repoAllowlist?: string[];
  inboxCatId?: string;
  defaultUserId?: string;
  reconciliationDedup?: Pick<
    ReconciliationDedup,
    'isNotified' | 'markNotified' | 'isBaselineEstablished' | 'markBaselineEstablished'
  >;
  bindingStore?: Pick<IConnectorThreadBindingStore, 'getByExternal'>;
  deliverFn?: (deps: ConnectorDeliveryDeps, input: ConnectorDeliveryInput) => Promise<ConnectorDeliveryResult>;
  deliveryDeps?: ConnectorDeliveryDeps;
  fetchOpenPRs?: (repo: string) => Promise<GhPrItem[]>;
  fetchOpenIssues?: (repo: string) => Promise<GhIssueItem[]>;
}

/** Cast ScheduleFactoryDeps to GitHubScheduleDeps with runtime validation */
function asGitHub(deps: ScheduleFactoryDeps): GitHubScheduleDeps {
  const d = deps as GitHubScheduleDeps;
  if (!d.taskStore) throw new Error('[F220] GitHub schedule factory requires taskStore in deps');
  return d;
}

const cicdCheckFactory: ScheduleFactory = {
  factoryId: 'github.cicd-check',
  createTaskSpec(instanceId, deps) {
    const d = asGitHub(deps);
    return createCiCdCheckTaskSpec({
      id: instanceId,
      taskStore: d.taskStore,
      cicdRouter: d.cicdRouter,
      invokeTrigger: d.invokeTrigger,
      log: d.log,
    }) as TaskSpec_P1;
  },
};

const conflictCheckFactory: ScheduleFactory = {
  factoryId: 'github.conflict-check',
  createTaskSpec(instanceId, deps) {
    const d = asGitHub(deps);
    return createConflictCheckTaskSpec({
      id: instanceId,
      taskStore: d.taskStore,
      checkMergeable: d.checkMergeable,
      conflictRouter: d.conflictRouter,
      invokeTrigger: d.invokeTrigger,
      autoExecutor: d.autoExecutor,
      log: d.log,
    }) as TaskSpec_P1;
  },
};

const reviewFeedbackFactory: ScheduleFactory = {
  factoryId: 'github.review-feedback',
  createTaskSpec(instanceId, deps) {
    const d = asGitHub(deps);
    return createReviewFeedbackTaskSpec({
      id: instanceId,
      taskStore: d.taskStore,
      fetchPrMetadata: d.fetchPrMetadata,
      fetchComments: d.fetchComments,
      fetchReviews: d.fetchReviews,
      reviewFeedbackRouter: d.reviewFeedbackRouter,
      invokeTrigger: d.invokeTrigger,
      log: d.log,
      isEchoComment: d.isEchoComment,
      isEchoReview: d.isEchoReview,
      isNoiseComment: d.isNoiseComment,
    }) as TaskSpec_P1;
  },
};

const repoScanFactory: ScheduleFactory = {
  factoryId: 'github.repo-scan',
  createTaskSpec(instanceId, deps) {
    const d = deps as GitHubScheduleDeps;
    // repo-scan needs redis-dependent deps — validate before construction
    if (!d.repoAllowlist || !d.inboxCatId || !d.defaultUserId) {
      throw new Error(
        '[F220] github.repo-scan requires repoAllowlist, inboxCatId, defaultUserId in deps. ' +
          'Set GITHUB_REPO_ALLOWLIST and GITHUB_REPO_INBOX_CAT_ID environment variables.',
      );
    }
    if (!d.reconciliationDedup || !d.bindingStore || !d.deliverFn || !d.deliveryDeps) {
      throw new Error(
        '[F220] github.repo-scan requires redis-dependent deps (reconciliationDedup, bindingStore, deliverFn, deliveryDeps)',
      );
    }
    if (!d.fetchOpenPRs || !d.fetchOpenIssues) {
      throw new Error('[F220] github.repo-scan requires fetchOpenPRs and fetchOpenIssues in deps');
    }
    return createRepoScanTaskSpec({
      id: instanceId,
      repoAllowlist: d.repoAllowlist,
      inboxCatId: d.inboxCatId,
      defaultUserId: d.defaultUserId,
      reconciliationDedup: d.reconciliationDedup,
      bindingStore: d.bindingStore,
      deliverFn: d.deliverFn,
      deliveryDeps: d.deliveryDeps,
      invokeTrigger: d.invokeTrigger,
      fetchOpenPRs: d.fetchOpenPRs,
      fetchOpenIssues: d.fetchOpenIssues,
      log: d.log,
    }) as TaskSpec_P1;
  },
};

/** Register all 4 GitHub schedule factories in the registry. */
export function registerGitHubScheduleFactories(registry: ScheduleFactoryRegistry): void {
  registry.register(cicdCheckFactory);
  registry.register(conflictCheckFactory);
  registry.register(reviewFeedbackFactory);
  registry.register(repoScanFactory);
}

// --- F220-B Migration helpers (P2-1 fix) ---

const MIGRATION_MARKER_PATH = '.cat-cafe/f220-github-schedule-migrated';

/**
 * Determine if the one-time GitHub schedule migration should run.
 *
 * Returns true only on first-ever startup after Phase B code is deployed.
 * Returns false if:
 * - A marker file exists (migration already ran)
 * - Any GitHub schedule entries already exist in capabilities (enabled or disabled)
 */
export function shouldRunGitHubScheduleMigration(
  projectRoot: string,
  existingCaps: CapabilitiesConfig | null,
): boolean {
  // If any GitHub schedule entries exist (enabled OR disabled), migration already ran
  const hasAnyGitHubSchedule = existingCaps?.capabilities.some((c) => c.type === 'schedule' && c.pluginId === 'github');
  if (hasAnyGitHubSchedule) return false;

  // One-time marker prevents re-enable after explicit disable
  const markerPath = join(projectRoot, MIGRATION_MARKER_PATH);
  return !existsSync(markerPath);
}

/** Write the one-time migration marker so migration won't re-run. */
export function markGitHubScheduleMigrationDone(projectRoot: string): void {
  const markerPath = join(projectRoot, MIGRATION_MARKER_PATH);
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, new Date().toISOString());
}
