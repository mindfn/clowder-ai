import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ManagedRunner, ManagedRunnerStartResult } from '../../infrastructure/managed-runner.js';
import { cleanupDurableManagedGateAttempt } from '../../infrastructure/managed-runner-durable-attempt.js';
import {
  readUnixProcessSnapshotSync,
  resolveCatCafeDataRoot,
  sameUnixProcess,
} from '../../utils/cli-process-ownership.js';
import { findMonorepoRoot } from '../../utils/monorepo-root.js';
import { createResumableDurableManagedGateJob } from '../ball-custody/durable-managed-gate-consumer.js';
import {
  cancelDurableManagedGateJob,
  type DurableManagedGateJob,
  initializeDurableManagedGateJob,
  inspectDurableManagedGateJob,
  isDurableManagedGateCommand,
  type ManagedJobPrincipal,
} from './durable-managed-gate-job.js';
import {
  rawDurableGateRecord,
  readDurableGateRecord,
  writeDurableGateRecord,
} from './durable-managed-gate-job-store.js';
import { CURRENT_DURABLE_GATE_SUPERVISOR_EPOCH } from './durable-managed-gate-supervisor.js';
import { observeManagedJobHealth, publishManagedJobCensus } from './managed-job-health.js';
import { listManagedJobLedger, managedJobPrincipalKey, readManagedJobTransitions } from './managed-job-ledger.js';
import { readManagedJobLogTail } from './managed-job-log.js';

export interface ManagedJobSubmission {
  readonly command: string;
  readonly cwd?: string;
  readonly originTaskId: string;
  readonly originInvocationId: string;
  readonly idempotencyKey: string;
  readonly retryOfJobId?: string;
  readonly executionSlaMs: number;
  readonly wakeTarget: DurableManagedGateJob['wakeTarget'];
}

export type ManagedJobAccess =
  | ManagedJobPrincipal
  | { readonly kind: 'operator'; readonly userId: string; readonly threadId: string };

export class ManagedJobService {
  constructor(
    private readonly dataRoot = resolveCatCafeDataRoot(),
    private readonly maxConcurrent = 4,
    private readonly operatorUserId?: string,
  ) {}

  private locator(jobId: string): DurableManagedGateJob {
    if (!/^managed-job-[a-f0-9]{40}$/u.test(jobId)) throw new Error('managed_job_not_found');
    return {
      kind: 'command',
      recordStorage: 'sqlite_v1',
      jobId,
      originTaskId: '',
      supervisorEpoch: CURRENT_DURABLE_GATE_SUPERVISOR_EPOCH,
      recordPath: join(this.dataRoot, 'managed-jobs', `${jobId}.json`),
      gateReceiptPath: join(this.dataRoot, 'managed-jobs', `${jobId}.gate.json`),
      logPath: join(this.dataRoot, 'managed-jobs', `${jobId}.log`),
      executionSlaMs: 0,
      wallSlaMs: 0,
      wakeTarget: { userId: '', threadId: '', catId: '' },
    };
  }

  /** Internal descriptor lookup. External callers must enter through get/start/cancel/tail. */
  resolve(jobId: string): DurableManagedGateJob | null {
    const locator = this.locator(jobId);
    if (!existsSync(join(this.dataRoot, 'managed-jobs', 'supervisor.sqlite'))) return null;
    const record = rawDurableGateRecord(locator);
    return record?.descriptor ? (record.descriptor as DurableManagedGateJob) : null;
  }

  private authorized(principal: ManagedJobAccess, jobId: string): DurableManagedGateJob {
    const job = this.resolve(jobId);
    const allowed =
      'kind' in principal
        ? principal.userId === this.operatorUserId && principal.threadId === job?.wakeTarget.threadId
        : !!job?.definition && managedJobPrincipalKey(job.definition.principal) === managedJobPrincipalKey(principal);
    if (!job?.definition || !allowed) {
      throw new Error('managed_job_not_found');
    }
    return job;
  }

  findSubmission(
    principal: ManagedJobPrincipal,
    input: Pick<ManagedJobSubmission, 'command' | 'cwd' | 'idempotencyKey' | 'executionSlaMs' | 'retryOfJobId'>,
  ) {
    const digest = createHash('sha256')
      .update(JSON.stringify([managedJobPrincipalKey(principal), input.idempotencyKey]))
      .digest('hex')
      .slice(0, 40);
    const existing = this.resolve(`managed-job-${digest}`);
    if (!existing) return null;
    this.authorized(principal, existing.jobId);
    if (
      existing.definition?.command !== input.command ||
      existing.definition.cwd !== realpathSync(input.cwd ?? process.cwd()) ||
      existing.executionSlaMs !== input.executionSlaMs ||
      (existing.definition.retryOfJobId ?? null) !== (input.retryOfJobId ?? null)
    )
      throw new Error('managed_job_idempotency_conflict');
    return existing;
  }

  async submit(principal: ManagedJobPrincipal, input: ManagedJobSubmission): Promise<DurableManagedGateJob> {
    if (process.env.CAT_CAFE_MANAGED_JOB_ID) throw new Error('nested_managed_job_denied');
    if (
      !principal.userId ||
      !principal.threadId ||
      !principal.catId ||
      !input.originInvocationId ||
      !input.idempotencyKey ||
      input.idempotencyKey.length > 256 ||
      !input.command.trim() ||
      !Number.isSafeInteger(input.executionSlaMs) ||
      input.executionSlaMs < 1000 ||
      input.executionSlaMs > 10_800_000
    ) {
      throw new Error('invalid_managed_job_submission');
    }
    const cwd = realpathSync(input.cwd ?? process.cwd());
    if (!statSync(cwd).isDirectory()) throw new Error('invalid_managed_job_cwd');
    const digest = createHash('sha256')
      .update(JSON.stringify([managedJobPrincipalKey(principal), input.idempotencyKey]))
      .digest('hex')
      .slice(0, 40);
    const jobId = `managed-job-${digest}`;
    const existing = this.findSubmission(principal, input);
    if (existing) {
      return existing;
    }
    let retryEpoch = 0;
    if (input.retryOfJobId) {
      const parent = this.authorized(principal, input.retryOfJobId);
      if (readDurableGateRecord(parent)?.state !== 'terminal') throw new Error('managed_job_retry_requires_terminal');
      retryEpoch = (parent.definition?.retryEpoch ?? 0) + 1;
    }
    if (managedJobPrincipalKey(principal) !== managedJobPrincipalKey(input.wakeTarget)) {
      throw new Error('managed_job_wake_principal_mismatch');
    }
    const guardUrl = pathToFileURL(join(findMonorepoRoot(), 'scripts/native-effect-target-guard.mjs')).href;
    const guard = (await import(guardUrl)) as {
      decideNativeHookPayload(payload: unknown): { decision: string; reasonCode?: string };
    };
    const verdict = guard.decideNativeHookPayload({ tool_name: 'Bash', tool_input: { command: input.command }, cwd });
    if (verdict.decision !== 'allow') throw new Error(`managed_job_effect_denied:${verdict.reasonCode ?? 'unknown'}`);
    const gate = isDurableManagedGateCommand(input.command)
      ? createResumableDurableManagedGateJob(input.originTaskId, input.executionSlaMs, input.wakeTarget, this.dataRoot)
      : null;
    const job: DurableManagedGateJob = {
      ...this.locator(jobId),
      ...(gate ? { kind: gate.kind, recovery: gate.recovery } : {}),
      originTaskId: input.originTaskId,
      executionSlaMs: input.executionSlaMs,
      wallSlaMs: gate?.wallSlaMs ?? input.executionSlaMs,
      wakeTarget: input.wakeTarget,
      definition: {
        principal,
        command: input.command,
        cwd,
        originInvocationId: input.originInvocationId,
        idempotencyKey: input.idempotencyKey,
        retryPolicy: 'never',
        retryEpoch,
        ...(input.retryOfJobId ? { retryOfJobId: input.retryOfJobId } : {}),
        maxConcurrent: this.maxConcurrent,
      },
    };
    try {
      initializeDurableManagedGateJob(job);
      return job;
    } catch (error) {
      // Concurrent retries share the same identity; they may observe the first committed submission.
      const winner = this.resolve(jobId);
      if (
        winner?.definition?.command === input.command &&
        winner.definition.cwd === cwd &&
        winner.executionSlaMs === input.executionSlaMs &&
        (winner.definition.retryOfJobId ?? null) === (input.retryOfJobId ?? null)
      )
        return winner;
      throw error;
    }
  }

  admit(principal: ManagedJobPrincipal, jobId: string, admissionMessageId: string): void {
    const job = this.authorized(principal, jobId);
    const record = rawDurableGateRecord(job);
    if (!record || record.state !== 'queued' || !admissionMessageId) throw new Error('managed_job_not_queued');
    if (record.admissionMessageId === admissionMessageId) return;
    if (!writeDurableGateRecord(job, { ...record, admissionMessageId, updatedAt: Date.now() })) {
      throw new Error('managed_job_admission_fenced');
    }
  }

  start(principal: ManagedJobPrincipal, jobId: string, runner: ManagedRunner): ManagedRunnerStartResult {
    const job = this.authorized(principal, jobId);
    const record = readDurableGateRecord(job);
    if (!record?.admissionMessageId || record.state !== 'queued' || !job.definition) {
      throw new Error('managed_job_not_admitted');
    }
    return runner.start(job.definition.command, {
      cwd: job.definition.cwd,
      timeoutMs: job.wallSlaMs,
      maximumTimeoutMs: job.wallSlaMs,
      managedJob: job,
    });
  }

  get(principal: ManagedJobAccess, jobId: string) {
    const job = this.authorized(principal, jobId);
    const record = readDurableGateRecord(job);
    if (!record) throw new Error('managed_job_not_found');
    const state =
      record.state === 'terminal'
        ? record.terminalStatus === 'green'
          ? 'succeeded'
          : record.terminalStatus === 'partial'
            ? 'failed'
            : record.terminalStatus
        : record.state === 'waiting'
          ? 'running'
          : record.state;
    return {
      ...record,
      state,
      actionKind: job.kind === 'command' ? 'command' : 'full_gate',
      command: job.definition?.command,
      cwd: job.definition?.cwd,
      retryPolicy: 'never' as const,
      retryEpoch: job.definition?.retryEpoch ?? 0,
      ...(job.definition?.retryOfJobId ? { retryOfJobId: job.definition.retryOfJobId } : {}),
    };
  }

  cancel(principal: ManagedJobAccess, jobId: string) {
    const job = this.authorized(principal, jobId);
    return cancelDurableManagedGateJob(job, {
      cancelledBy: 'kind' in principal ? `operator:${principal.userId}` : principal.catId,
      reason: 'explicit_job_cancel',
    });
  }

  tail(principal: ManagedJobAccess, jobId: string, maxBytes = 16_384): string {
    const job = this.authorized(principal, jobId);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65_536) throw new Error('invalid_job_tail_limit');
    if (!existsSync(job.logPath)) return '';
    return readManagedJobLogTail(job.logPath, maxBytes);
  }

  transitions(principal: ManagedJobAccess, jobId: string) {
    return readManagedJobTransitions(this.authorized(principal, jobId));
  }

  /** Scheduler-independent census includes jobs whose wake carrier was consumed or replaced. */
  list() {
    if (!existsSync(join(this.dataRoot, 'managed-jobs', 'supervisor.sqlite'))) return [];
    return listManagedJobLedger(this.locator(`managed-job-${'0'.repeat(40)}`)).map(
      (record) => record.descriptor as DurableManagedGateJob,
    );
  }

  activeExecutions() {
    if (!existsSync(join(this.dataRoot, 'managed-jobs', 'supervisor.sqlite'))) return [];
    return listManagedJobLedger(this.locator(`managed-job-${'0'.repeat(40)}`), true).flatMap((record) => {
      const job = record.descriptor as DurableManagedGateJob;
      if (!record.admissionMessageId || !job.definition || typeof record.createdAt !== 'number') return [];
      return [{ job, startedAt: record.createdAt }];
    });
  }

  async reconcile(legacyJobs: readonly DurableManagedGateJob[] = [], now = Date.now()) {
    const results = [];
    for (const job of [...this.list(), ...legacyJobs]) {
      const record = readDurableGateRecord(job);
      if (record?.state !== 'terminal' && record?.ownerIdentity && record.attemptToken && !record.cleanupProven) {
        const snapshot = readUnixProcessSnapshotSync({ pids: [record.ownerIdentity.pid] });
        if (snapshot !== null && !sameUnixProcess(record.ownerIdentity, snapshot.get(record.ownerIdentity.pid))) {
          const cleanup = await cleanupDurableManagedGateAttempt(record.attemptToken, 3000, 100);
          if (cleanup.proven)
            writeDurableGateRecord(
              { ...job, supervisorEpoch: CURRENT_DURABLE_GATE_SUPERVISOR_EPOCH },
              { ...rawDurableGateRecord(job), cleanupProven: true, updatedAt: Date.now() },
            );
        }
      }
      const inspection = inspectDurableManagedGateJob(job, { now });
      const history =
        job.recordStorage === 'sqlite_v1' ? readManagedJobTransitions(job) : [rawDurableGateRecord(job) ?? {}];
      const health = observeManagedJobHealth(job, inspection, history, now);
      results.push({ job, inspection, health });
    }
    publishManagedJobCensus(results.map(({ health }) => health));
    return results;
  }
}
